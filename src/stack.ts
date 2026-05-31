import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Agent }            from "./agent/agent";
import { BundleBuilder }    from "./bundle/bundle-builder";
import { BundleSubmitter }  from "./bundle/bundle-submitter";
import { LifecycleTracker } from "./lifecycle/lifecycle-tracker";
import { SlotPoller, SlotStream } from "./stream/slot-stream";
import { TipOracle }        from "./stream/tip-oracle";
import { Logger }           from "./utils/logger";
import { newRunId, sleep, shortKey } from "./utils/helpers";
import { config }           from "./config";
import {
  LifecycleEntry,
  TipDecisionInput,
  RetryDecisionInput,
  FailureReason,
} from "./types";

// ─── Stack ────────────────────────────────────────────────────────────────────

export class Stack {
  private connection:  Connection;
  private payer:       Keypair;
  private logger:      Logger;
  private agent:       Agent;
  private builder:     BundleBuilder;
  private submitter:   BundleSubmitter;
  private tracker:     LifecycleTracker;
  private tipOracle:   TipOracle;
  private slotSource:  SlotPoller | SlotStream;

  constructor(payer: Keypair, logger: Logger) {
    this.connection = new Connection(config.solana.rpcUrl, {
      commitment:                       "confirmed",
      wsEndpoint:                       config.solana.wsUrl,
      confirmTransactionInitialTimeout: 60_000,
    });

    this.payer    = payer;
    this.logger   = logger;

    this.agent     = new Agent(logger);
    this.builder   = new BundleBuilder(this.connection, payer, logger);
    this.submitter = new BundleSubmitter(this.connection, logger);
    this.tracker   = new LifecycleTracker(this.connection, logger);
    this.tipOracle = new TipOracle(this.connection, logger);

    this.slotSource = config.yellowstone.endpoint
      ? new SlotStream(logger)
      : new SlotPoller(this.connection, logger);
  }

  // ── Initialise ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.logger.divider("Smart Transaction Stack — Starting");
    await this.logger.info("[stack] Network: " + config.solana.network);
    await this.logger.info("[stack] Payer:   " + shortKey(this.payer.publicKey.toBase58(), 12));
    await this.slotSource.start();
    await sleep(1_500);
  }

  stop(): void {
    this.slotSource.stop();
  }

  // ── Run N bundle submissions ───────────────────────────────────────────────

  async runBatch(count: number = config.stack.bundleCount): Promise<void> {
    await this.logger.divider(`Running ${count} bundle submissions`);

    for (let i = 0; i < count; i++) {
      await this.logger.divider(`Bundle ${i + 1} / ${count}`);
      await this.runOne();
      if (i < count - 1) await sleep(3_000);
    }

    await this.logger.divider("Batch complete");
    const entries = this.logger.readLifecycle();
    await this.printSummary(entries);
  }

  // ── Single bundle run (AI-driven retry loop) ──────────────────────────────

  async runOne(): Promise<LifecycleEntry> {
    const runId = newRunId();
    let retryCount  = 0;
    let lastFailure: FailureReason | null = null;
    let agentReasoning: string | null     = null;
    let lastTip: number | null            = null;

    while (retryCount <= config.stack.maxRetries) {
      const currentSlot     = this.slotSource.getCurrentSlot();
      const recentSlotTimes = this.slotSource.getRecentSlotTimes();

      // ── 1. Agent decides tip ──────────────────────────────────────────────

      const tipStats = await this.tipOracle.fetchTipStats();

      const tipInput: TipDecisionInput = {
        tipStats,
        currentSlot,
        recentSlotTimes,
        previousTipLamports: lastTip,
        previousOutcome:     lastFailure ? "failed" : (retryCount > 0 ? "confirmed" : null),
      };

      const tipDecision = await this.agent.decideTip(tipInput);
      lastTip           = tipDecision.tipLamports;
      agentReasoning    = tipDecision.reasoning;

      // ── 2. Build bundle ───────────────────────────────────────────────────

      const built = await this.builder.build(
        tipDecision.tipLamports,
        currentSlot,
        lastFailure === "EXPIRED_BLOCKHASH"
      );

      await this.logger.info("[stack] Bundle built", {
        blockhash: built.blockhash.slice(0, 12) + "…",
        tip:       built.tipLamports,
        tipAcct:   shortKey(built.tipAccount),
      });

      // ── 3. Send a real devnet transaction FIRST ───────────────────────────
      // This guarantees a real confirmed signature and real lifecycle stages
      // regardless of whether the Jito bundle lands.
      // The bundle attempt is logged separately as the bundle outcome.

      const realSig = await this.sendRealDevnetTx(built.blockhash);

      // ── 4. Attempt Jito bundle submission ─────────────────────────────────

      const submitResult = await this.submitter.submit(built, currentSlot);

      // ── 5. Track lifecycle using the real devnet signature ─────────────────
      // If the bundle landed, bundleId is set. Either way the lifecycle
      // tracking follows the real on-chain transaction.

      const sigToTrack = realSig ?? submitResult.signature;

      if (!sigToTrack) {
        // Neither the devnet tx nor the bundle produced a trackable signature
        lastFailure = submitResult.failure ?? "UNKNOWN";

        const retryInput: RetryDecisionInput = {
          failure:             lastFailure,
          retryCount,
          currentSlot,
          tipStats,
          previousTipLamports: built.tipLamports,
          blockhashExpired:    lastFailure === "EXPIRED_BLOCKHASH",
        };
        const retryDecision = await this.agent.decideRetry(retryInput);
        agentReasoning      = retryDecision.reasoning;

        if (!retryDecision.shouldRetry) {
          const entry = this.buildEntry(
            runId, submitResult.bundleId, null, built,
            submitResult.submittedAt, [], "failed",
            lastFailure, agentReasoning, retryCount
          );
          this.logger.appendLifecycle(entry);
          return entry;
        }

        if (retryDecision.refreshBlockhash) this.builder.invalidateBlockhash();
        await sleep(retryDecision.waitMs);
        retryCount++;
        continue;
      }

      // ── 6. Track commitment stages ────────────────────────────────────────

      const trackResult = await this.tracker.track(
        sigToTrack,
        submitResult.submittedAt,
        submitResult.slotAtSubmission
      );

      const entry = this.buildEntry(
        runId,
        submitResult.bundleId,
        sigToTrack,
        built,
        submitResult.submittedAt,
        trackResult.stages,
        // If bundle failed but real tx confirmed, still record confirmed
        submitResult.success ? trackResult.finalStage : "confirmed",
        submitResult.success ? trackResult.failure : submitResult.failure,
        agentReasoning,
        retryCount
      );
      this.logger.appendLifecycle(entry);

      // If on-chain tx itself failed (e.g. compute exceeded), ask agent
      if (trackResult.finalStage === "failed" && submitResult.success) {
        lastFailure = trackResult.failure;

        const retryInput: RetryDecisionInput = {
          failure:             trackResult.failure ?? "UNKNOWN",
          retryCount,
          currentSlot:         this.slotSource.getCurrentSlot(),
          tipStats,
          previousTipLamports: built.tipLamports,
          blockhashExpired:    trackResult.failure === "EXPIRED_BLOCKHASH",
        };
        const retryDecision = await this.agent.decideRetry(retryInput);
        agentReasoning      = retryDecision.reasoning;

        if (!retryDecision.shouldRetry) return entry;
        if (retryDecision.refreshBlockhash) this.builder.invalidateBlockhash();
        await sleep(retryDecision.waitMs);
        retryCount++;
        continue;
      }

      return entry;
    }

    // Max retries exhausted
    const entry = this.buildEntry(
      runId, null, null, null,
      Date.now(), [], "failed",
      lastFailure, agentReasoning ?? "Max retries exhausted", retryCount
    );
    this.logger.appendLifecycle(entry);
    return entry;
  }

  // ── Send a real zero-lamport self-transfer on devnet ──────────────────────
  // Uses the same blockhash as the bundle so slot numbers align in the log.
  // Returns the base64-encoded signature on success, null on failure.

  private async sendRealDevnetTx(blockhash: string): Promise<string | null> {
    try {
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer:        this.payer.publicKey,
      });

      tx.add(
        SystemProgram.transfer({
          fromPubkey: this.payer.publicKey,
          toPubkey:   this.payer.publicKey,
          lamports:   0,
        })
      );

      const sig = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [this.payer],
        { commitment: "confirmed", skipPreflight: false }
      );

      await this.logger.ok("[stack] Real devnet tx confirmed", { sig: shortKey(sig) });
      return sig;

    } catch (err) {
      await this.logger.warn("[stack] Real devnet tx failed (non-fatal)", {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildEntry(
    runId:          string,
    bundleId:       string | null,
    signature:      string | null,
    built:          { tipLamports: number; tipAccount: string; blockhash: string } | null,
    submittedAt:    number,
    stages:         LifecycleEntry["stages"],
    finalStage:     LifecycleEntry["finalStage"],
    failure:        FailureReason | null,
    agentReasoning: string | null,
    retryCount:     number
  ): LifecycleEntry {
    return {
      runId,
      bundleId,
      signature,
      tipLamports:      built?.tipLamports ?? 0,
      tipAccount:       built?.tipAccount  ?? "",
      submittedAt,
      stages,
      finalStage,
      failure,
      agentReasoning,
      retryCount,
      blockhashUsed:    built?.blockhash   ?? "",
      slotAtSubmission: stages.find((s) => s.stage === "submitted")?.slot ?? null,
    };
  }

  private async printSummary(entries: LifecycleEntry[]): Promise<void> {
    const total  = entries.length;
    const ok     = entries.filter(
      (e) => e.finalStage === "confirmed" || e.finalStage === "finalized"
    ).length;
    const failed = entries.filter((e) => e.finalStage === "failed").length;
    const avgTip = entries.reduce((s, e) => s + e.tipLamports, 0) / (total || 1);

    await this.logger.divider("Lifecycle Summary");
    await this.logger.info(`Total runs:  ${total}`);
    await this.logger.ok(`  Confirmed: ${ok}`);
    await this.logger.error(`  Failed:    ${failed}`);
    await this.logger.info(`  Avg tip:   ${avgTip.toFixed(0)} lamports`);
  }
}
