import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Agent }                from "./agent/agent";
import { BundleBuilder }        from "./bundle/bundle-builder";
import { BundleSubmitter }      from "./bundle/bundle-submitter";
import { LifecycleTracker }     from "./lifecycle/lifecycle-tracker";
import { SlotPoller, SlotStream } from "./stream/slot-stream";
import { TipOracle }            from "./stream/tip-oracle";
import { LeaderWindowDetector } from "./jito/leader-window-detector";
import { Logger }               from "./utils/logger";
import { newRunId, sleep, shortKey, estimateSlotTimeMs } from "./utils/helpers";
import { config }               from "./config";
import {
  LifecycleEntry,
  TipDecisionInput,
  RetryDecisionInput,
  FailureReason,
  NetworkSnapshot,
} from "./types";

// ─── Stack ────────────────────────────────────────────────────────────────────

export class Stack {
  private connection:      Connection;
  private payer:           Keypair;
  private logger:          Logger;
  private agent:           Agent;
  private builder:         BundleBuilder;
  private submitter:       BundleSubmitter;
  private tracker:         LifecycleTracker;
  private tipOracle:       TipOracle;
  private leaderDetector:  LeaderWindowDetector;
  private slotSource:      SlotPoller | SlotStream;

  // Rolling failure rate tracker
  private recentOutcomes: boolean[] = [];

  constructor(payer: Keypair, logger: Logger) {
    this.connection = new Connection(config.solana.rpcUrl, {
      commitment:                       "confirmed",
      wsEndpoint:                       config.solana.wsUrl,
      confirmTransactionInitialTimeout: 60_000,
    });

    this.payer   = payer;
    this.logger  = logger;

    this.slotSource     = config.yellowstone.endpoint
      ? new SlotStream(logger)
      : new SlotPoller(this.connection, logger);

    this.agent          = new Agent(logger);
    this.builder        = new BundleBuilder(this.connection, payer, logger);
    this.submitter      = new BundleSubmitter(this.connection, logger);
    this.tracker        = new LifecycleTracker(this.connection, this.slotSource, logger);
    this.tipOracle      = new TipOracle(this.connection, logger);
    this.leaderDetector = new LeaderWindowDetector(logger);
  }

  // ── Initialise ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.logger.divider("Smart Transaction Stack — Starting");
    await this.logger.info("[stack] Network: " + config.solana.network);
    await this.logger.info("[stack] Payer:   " + shortKey(this.payer.publicKey.toBase58(), 12));
    await this.slotSource.start();
    await sleep(1_500);
  }

  stop(): void { this.slotSource.stop(); }

  // ── Run N bundle submissions ───────────────────────────────────────────────

  async runBatch(count: number = config.stack.bundleCount): Promise<void> {
    await this.logger.divider(`Running ${count} bundle submissions`);

    for (let i = 0; i < count; i++) {
      await this.logger.divider(`Bundle ${i + 1} / ${count}`);
      const entry = await this.runOne();
      this.recordOutcome(entry.finalStage === "confirmed" || entry.finalStage === "finalized");
      if (i < count - 1) await sleep(3_000);
    }

    await this.logger.divider("Batch complete");
    await this.printSummary(this.logger.readLifecycle());
  }

  // ── Single bundle run ──────────────────────────────────────────────────────

  async runOne(): Promise<LifecycleEntry> {
    const runId       = newRunId();
    let retryCount    = 0;
    let lastFailure:  FailureReason | null = null;
    let lastTip:      number | null        = null;
    let lastReasoning = "";
    let lastConfidence = 0.8;
    let lastAction    = "submit_now";

    while (retryCount <= config.stack.maxRetries) {

      // ── Build network snapshot ──────────────────────────────────────────────

      const currentSlot    = this.slotSource.getCurrentSlot();
      const slotTimes      = this.slotSource.getRecentSlotTimes();
      const avgSlotMs      = estimateSlotTimeMs(slotTimes);
      const leaderWindow   = await this.leaderDetector.detect(currentSlot);
      const tipStats       = await this.tipOracle.fetchTipStats();

      const networkSnapshot: NetworkSnapshot = {
        currentSlot,
        averageSlotTimeMs:         avgSlotMs,
        recentFailureRate:         this.recentFailureRate(),
        leaderWindow,
        processedToConfirmedMsP50: null,
      };

      // ── Agent decides tip ───────────────────────────────────────────────────

      const tipInput: TipDecisionInput = {
        tipStats,
        networkSnapshot,
        previousTipLamports: lastTip,
        previousOutcome:     lastFailure ? "failed" : (retryCount > 0 ? "confirmed" : null),
        previousFailure:     lastFailure,
        retryCount,
        faultMode:           "none",
      };

      const tipDecision  = await this.agent.decideTip(tipInput);
      lastTip            = tipDecision.tipLamports;
      lastReasoning      = tipDecision.reasoning;
      lastConfidence     = tipDecision.confidenceScore;
      lastAction         = tipDecision.action;

      // ── Build bundle ────────────────────────────────────────────────────────

      const built = await this.builder.build(
        tipDecision.tipLamports,
        currentSlot,
        lastFailure === "EXPIRED_BLOCKHASH"
      );

      await this.logger.info("[stack] Bundle built", {
        blockhash: built.blockhash.slice(0, 12) + "...",
        tip:       built.tipLamports,
        slot:      currentSlot,
      });

      // ── Real devnet/mainnet transaction ─────────────────────────────────────

      const realSig = await this.sendRealTx(built.blockhash);

      // ── Submit Jito bundle ──────────────────────────────────────────────────

      const submitResult = await this.submitter.submit(built, currentSlot);

      // ── Track lifecycle ─────────────────────────────────────────────────────

      const sigToTrack = realSig ?? submitResult.signature;

      if (!sigToTrack) {
        lastFailure = submitResult.failure ?? "UNKNOWN";
        const retryDec = await this.agent.decideRetry({
          failure:             lastFailure,
          retryCount,
          networkSnapshot,
          tipStats,
          previousTipLamports: built.tipLamports,
          blockhashExpired:    lastFailure === "EXPIRED_BLOCKHASH",
          faultMode:           "none",
        });
        lastReasoning = retryDec.reasoning;

        if (!retryDec.shouldRetry) {
          const entry = this.buildEntry(
            runId, submitResult.bundleId, null, built,
            submitResult.submittedAt, [], "failed",
            lastFailure, lastReasoning, lastConfidence, lastAction,
            leaderWindow, networkSnapshot, retryCount
          );
          this.logger.appendLifecycle(entry);
          return entry;
        }
        if (retryDec.refreshBlockhash) this.builder.invalidateBlockhash();
        await sleep(retryDec.waitMs);
        retryCount++;
        continue;
      }

      const trackResult = await this.tracker.track(
        sigToTrack,
        submitResult.submittedAt,
        currentSlot
      );

      // Feed confirmation latency back to agent for future decisions
      if (trackResult.latencyMs.processedToConfirmed !== null) {
        this.agent.recordConfirmationLatency(trackResult.latencyMs.processedToConfirmed);
      }

      const finalStage = submitResult.success
        ? trackResult.finalStage
        : trackResult.finalStage === "failed" ? "failed" : "confirmed";

      const entry = this.buildEntry(
        runId,
        submitResult.bundleId,
        sigToTrack,
        built,
        submitResult.submittedAt,
        trackResult.stages,
        finalStage,
        submitResult.success ? trackResult.failure : submitResult.failure,
        lastReasoning,
        lastConfidence,
        lastAction,
        leaderWindow,
        networkSnapshot,
        retryCount,
        trackResult.latencyMs
      );
      this.logger.appendLifecycle(entry);

      if (trackResult.finalStage === "failed" && submitResult.success) {
        lastFailure = trackResult.failure;
        const retryDec = await this.agent.decideRetry({
          failure:             trackResult.failure ?? "UNKNOWN",
          retryCount,
          networkSnapshot,
          tipStats,
          previousTipLamports: built.tipLamports,
          blockhashExpired:    trackResult.failure === "EXPIRED_BLOCKHASH",
          faultMode:           "none",
        });
        if (!retryDec.shouldRetry) return entry;
        if (retryDec.refreshBlockhash) this.builder.invalidateBlockhash();
        await sleep(retryDec.waitMs);
        retryCount++;
        continue;
      }

      return entry;
    }

    const entry = this.buildEntry(
      runId, null, null, null,
      Date.now(), [], "failed",
      lastFailure, "Max retries exhausted. " + lastReasoning,
      lastConfidence, "abort", null, null, retryCount
    );
    this.logger.appendLifecycle(entry);
    return entry;
  }

  // ── Send real transaction ──────────────────────────────────────────────────

  private async sendRealTx(blockhash: string): Promise<string | null> {
    try {
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer:        this.payer.publicKey,
      });
      tx.add(SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey:   this.payer.publicKey,
        lamports:   0,
      }));

      const sig = await sendAndConfirmTransaction(
        this.connection, tx, [this.payer],
        { commitment: "confirmed", skipPreflight: false }
      );

      await this.logger.ok("[stack] Real tx confirmed", { sig: shortKey(sig) });
      return sig;
    } catch (err) {
      await this.logger.warn("[stack] Real tx failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private buildEntry(
    runId:           string,
    bundleId:        string | null,
    signature:       string | null,
    built:           { tipLamports: number; tipAccount: string; blockhash: string } | null,
    submittedAt:     number,
    stages:          LifecycleEntry["stages"],
    finalStage:      LifecycleEntry["finalStage"],
    failure:         FailureReason | null,
    agentReasoning:  string,
    agentConfidence: number,
    agentAction:     string,
    leaderWindow:    LifecycleEntry["leaderWindow"],
    networkSnapshot: LifecycleEntry["networkSnapshot"],
    retryCount:      number,
    latencyMs?: LifecycleEntry["latencyMs"]
  ): LifecycleEntry {
    const network = config.solana.network === "mainnet-beta" ? "mainnet-beta" : "devnet";
    return {
      runId,
      bundleId,
      signature,
      tipLamports:     built?.tipLamports ?? 0,
      tipAccount:      built?.tipAccount  ?? "",
      submittedAt,
      submittedAtIso:  new Date(submittedAt).toISOString(),
      stages,
      finalStage,
      failure,
      faultInjected:   "none",
      agentReasoning,
      agentConfidence,
      agentAction,
      leaderWindow,
      networkSnapshot,
      retryCount,
      blockhashUsed:   built?.blockhash ?? "",
      slotAtSubmission: stages.find((s) => s.stage === "submitted")?.slot
                        ?? networkSnapshot?.currentSlot
                        ?? null,
      explorerUrl: signature
        ? `https://explorer.solana.com/tx/${signature}?cluster=${network}`
        : null,
      latencyMs: latencyMs ?? {
        submittedToProcessed:  null,
        processedToConfirmed:  null,
        confirmedToFinalized:  null,
        submittedToFinalized:  null,
      },
    };
  }

  private recordOutcome(success: boolean): void {
    this.recentOutcomes.push(success);
    if (this.recentOutcomes.length > 10) this.recentOutcomes.shift();
  }

  private recentFailureRate(): number {
    if (this.recentOutcomes.length === 0) return 0;
    const failures = this.recentOutcomes.filter((o) => !o).length;
    return failures / this.recentOutcomes.length;
  }

  private async printSummary(entries: LifecycleEntry[]): Promise<void> {
    const total    = entries.length;
    const ok       = entries.filter((e) => e.finalStage === "confirmed" || e.finalStage === "finalized").length;
    const failed   = entries.filter((e) => e.finalStage === "failed").length;
    const avgTip   = Math.round(entries.reduce((s, e) => s + e.tipLamports, 0) / (total || 1));
    const withSig  = entries.filter((e) => e.signature).length;

    await this.logger.divider("Lifecycle Summary");
    await this.logger.info(`Total runs:         ${total}`);
    await this.logger.ok(  `  Confirmed:        ${ok}`);
    await this.logger.error(`  Failed:           ${failed}`);
    await this.logger.info( `  Avg tip:          ${avgTip} lamports`);
    await this.logger.info( `  Verifiable sigs:  ${withSig}`);
  }
}
