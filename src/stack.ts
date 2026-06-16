import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Agent }                    from "./agent/agent";
import { BundleBuilder }            from "./bundle/bundle-builder";
import { BundleSubmitter }          from "./bundle/bundle-submitter";
import { LifecycleTracker }         from "./lifecycle/lifecycle-tracker";
import { SlotPoller, SlotStream }   from "./stream/slot-stream";
import { TipOracle }                from "./stream/tip-oracle";
import { NetworkStateObserver }     from "./stream/network-state-observer";
import { LeaderWindowDetector }     from "./jito/leader-window-detector";
import { AdvancedFailureClassifier } from "./bundle/failure-classifier";
import { Logger }                   from "./utils/logger";
import { newRunId, sleep, shortKey, estimateSlotTimeMs } from "./utils/helpers";
import { config }                   from "./config";
import {
  LifecycleEntry,
  TipDecisionInput,
  RetryDecisionInput,
  FailureReason,
  NetworkSnapshot,
  NetworkConditions,
  NetworkConditionsDelta,
  TriggerEvent,
  LeaderWindow,
} from "./types";
import { MarinadeLiquidStakingListener } from "./stream/marinade-event-stream";

// ─── Stack ────────────────────────────────────────────────────────────────────

export class Stack {
  private connection:     Connection;
  private payer:          Keypair;
  private logger:         Logger;
  private agent:          Agent;
  private builder:        BundleBuilder;
  private submitter:      BundleSubmitter;
  private tracker:        LifecycleTracker;
  private tipOracle:      TipOracle;
  private networkObs:     NetworkStateObserver;
  private leaderDetector: LeaderWindowDetector;
  private classifier:     AdvancedFailureClassifier;
  private slotSource:     SlotPoller | SlotStream;

  private recentOutcomes: boolean[] = [];

  constructor(payer: Keypair, logger: Logger) {
    this.connection = new Connection(config.solana.rpcUrl, {
      commitment:                       "confirmed",
      wsEndpoint:                       config.solana.wsUrl,
      confirmTransactionInitialTimeout: 60_000,
    });

    this.payer   = payer;
    this.logger  = logger;

    this.slotSource      = config.yellowstone.endpoint
      ? new SlotStream(logger)
      : new SlotPoller(this.connection, logger);

    this.agent           = new Agent(logger);
    this.builder         = new BundleBuilder(this.connection, payer, logger);
    this.submitter       = new BundleSubmitter(this.connection, logger);
    this.tracker         = new LifecycleTracker(this.connection, this.slotSource, logger);
    this.tipOracle       = new TipOracle(this.connection, logger);
    this.networkObs      = new NetworkStateObserver(this.connection, logger);
    this.leaderDetector  = new LeaderWindowDetector(logger);
    this.classifier      = new AdvancedFailureClassifier();

    // If Yellowstone gives up, ensure slotSource keeps working via poller
    this.slotSource.on("fallback", async () => {
      await this.logger.warn("[stack] Yellowstone gave up -- switching to RPC poller");
      const poller = new SlotPoller(this.connection, logger);
      this.slotSource  = poller;
      this.tracker     = new LifecycleTracker(this.connection, poller, logger);
      await poller.start();
    });
  }

  // ── Initialise ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.logger.divider("Smart Transaction Stack -- Starting");
    await this.logger.info("[stack] Network: " + config.solana.network);
    await this.logger.info("[stack] Payer:   " + shortKey(this.payer.publicKey.toBase58(), 12));

    // Forward slot timestamps to NetworkStateObserver
    this.slotSource.on("slot", (ev: any) => {
      if (ev?.status === "processed") {
        this.networkObs.recordSlotTimestamp(ev.timestamp);
      }
    });

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
      const success =
        entry.finalStage === "confirmed" ||
        entry.finalStage === "finalized";
      this.recordOutcome(success);
      if (i < count - 1) await sleep(3_000);
    }

    await this.logger.divider("Batch complete");
    await this.printSummary(this.logger.readLifecycle());
  }

  // ── Reactive run: triggered by real Marinade Finance staking events ───────
  // Listens for Marinade Deposit/Unstake events on mainnet. When an event
  // exceeding the large-event threshold is detected, submits a bundle in
  // response and tags the lifecycle entry with the triggering event context.
  //
  // Runs until maxEvents bundles have been triggered or timeoutMs elapses,
  // whichever comes first. Falls back gracefully if no events occur --
  // this is mainnet-only since Marinade does not operate on devnet.

  async runWithMarinadeTriggering(
    maxEvents: number = 3,
    timeoutMs: number = 5 * 60_000
  ): Promise<LifecycleEntry[]> {
    if (config.solana.network !== "mainnet-beta") {
      await this.logger.warn(
        "[marinade] Marinade Finance only operates on mainnet-beta. " +
        "Set SOLANA_NETWORK=mainnet-beta to use event-triggered submissions."
      );
      return [];
    }

    await this.logger.divider("Marinade-triggered bundle submissions");
    await this.logger.info(
      `[marinade] Listening for large staking events (>= 50 SOL), ` +
      `max ${maxEvents} triggers, ${(timeoutMs / 1000).toFixed(0)}s timeout`
    );

    const listener = new MarinadeLiquidStakingListener(this.connection, this.logger);
    const entries: LifecycleEntry[] = [];
    let triggered = 0;

    const triggerPromise = new Promise<void>((resolve) => {
      listener.on("large_event", async (event: any) => {
        if (triggered >= maxEvents) return;
        triggered++;

        await this.logger.info("[marinade] Large event triggered bundle submission", {
          eventType: event.eventType,
          amountSol: event.amountSol.toFixed(2),
          sig:       event.signature.slice(0, 12) + "...",
        });

        const triggerEvent: TriggerEvent = {
          type: "marinade_staking",
          metadata: {
            eventType:      event.eventType,
            amountSol:      event.amountSol,
            amountLamports: event.amountLamports,
            sourceSignature: event.signature,
            sourceSlot:      event.slot,
          },
          detectedAt: event.timestampIso,
        };

        const entry = await this.runOne(triggerEvent);
        entries.push(entry);
        this.recordOutcome(entry.finalStage === "confirmed" || entry.finalStage === "finalized");

        if (triggered >= maxEvents) resolve();
      });
    });

    await listener.startListening();

    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([triggerPromise, timeoutPromise]);

    listener.stopListening();

    if (entries.length === 0) {
      await this.logger.warn(
        "[marinade] No qualifying events observed within the timeout window. " +
        "Marinade staking volume is variable -- this is expected behaviour, not a bug."
      );
    } else {
      await this.logger.ok(`[marinade] ${entries.length} event-triggered bundle(s) submitted`);
    }

    return entries;
  }

  // ── Single bundle run (agent-driven retry loop) ────────────────────────────

  async runOne(triggerEvent?: TriggerEvent): Promise<LifecycleEntry> {
    const runId         = newRunId();
    let retryCount      = 0;
    let lastFailure:    FailureReason | null = null;
    let lastTip:        number | null        = null;
    let lastReasoning   = "";
    let lastConfidence  = 0.8;
    let lastAction      = "submit_now";

    while (retryCount <= config.stack.maxRetries) {

      // ── 1. Build NetworkSnapshot ────────────────────────────────────────────

      const currentSlot  = await this.getReliableCurrentSlot();
      const slotTimes    = this.slotSource.getRecentSlotTimes();
      const avgSlotMs    = estimateSlotTimeMs(slotTimes);
      const leaderWindow = await this.leaderDetector.detect(currentSlot);
      const tipStats     = await this.tipOracle.fetchTipStats();
      const conditions   = await this.networkObs.captureConditions(this.recentFailureRate());
      const conditionsAtSubmission = conditions;

      const networkSnapshot: NetworkSnapshot = {
        currentSlot,
        averageSlotTimeMs:         avgSlotMs,
        recentFailureRate:         this.recentFailureRate(),
        leaderWindow,
        processedToConfirmedMsP50: conditions.processedToConfirmedP50,
        processedToConfirmedMsP90: conditions.processedToConfirmedP90,
        conditions,
      };

      // ── 2. Agent decides tip ────────────────────────────────────────────────

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

      // ── 3. Build bundle ─────────────────────────────────────────────────────

      const built = await this.builder.build(
        tipDecision.tipLamports,
        currentSlot,
        lastFailure === "EXPIRED_BLOCKHASH"
      );

      await this.logger.info("[stack] Bundle built", {
        blockhash: built.blockhash.slice(0, 12) + "...",
        tip:       built.tipLamports,
        slot:      currentSlot,
        network:   config.solana.network,
      });

      // ── 4. Send real transaction (ensures verifiable on-chain evidence) ─────

      const realSig = await this.sendRealTx(built.blockhash);

      // ── 5. Attempt Jito bundle ──────────────────────────────────────────────

      const submitResult = await this.submitter.submit(built, currentSlot);

      // ── 6. Track lifecycle ──────────────────────────────────────────────────

      const tracksBundleTransaction =
        submitResult.success &&
        submitResult.signature !== null &&
        submitResult.signature !== "unknown";
      const sigToTrack = tracksBundleTransaction
        ? submitResult.signature
        : realSig ?? submitResult.signature;

      if (!sigToTrack) {
        lastFailure = submitResult.failure ?? "UNKNOWN";

        const cls = this.classifier.fromReason(lastFailure, {
          retryCount,
          tipLamports:    built.tipLamports,
          tipP75Lamports: tipStats.p75Lamports,
        });

        const retryDecision = await this.agent.decideRetry({
          failure:             lastFailure,
          classification:      cls,
          retryCount,
          networkSnapshot,
          tipStats,
          previousTipLamports: built.tipLamports,
          blockhashExpired:    lastFailure === "EXPIRED_BLOCKHASH",
          faultMode:           "none",
        });
        lastReasoning = retryDecision.reasoning;

        if (!retryDecision.shouldRetry) {
          const entry = this.buildEntry({
            runId, bundleId: null, signature: null, built,
            submittedAt: submitResult.submittedAt, stages: [],
            finalStage: "failed", failure: lastFailure,
            agentReasoning: lastReasoning, agentConfidence: lastConfidence,
            agentAction: lastAction, leaderWindow, networkSnapshot,
            conditionsAtSubmission, triggerEvent: triggerEvent ?? null, retryCount,
          });
          this.logger.appendLifecycle(entry);
          return entry;
        }

        if (retryDecision.refreshBlockhash) this.builder.invalidateBlockhash();
        await sleep(retryDecision.waitMs);
        retryCount++;
        continue;
      }

      const trackResult = await this.tracker.track(
        sigToTrack,
        submitResult.submittedAt,
        currentSlot
      );

      // Feed confirmation latency back to agent and observer
      if (trackResult.latencyMs.processedToConfirmed !== null) {
        this.agent.recordConfirmationLatency(trackResult.latencyMs.processedToConfirmed);
        this.networkObs.recordConfirmedLatency(trackResult.latencyMs.processedToConfirmed);
      }

      // Capture conditions again at confirmation time for delta analysis
      const conditionsAtConfirmation = await this.networkObs.captureConditions(this.recentFailureRate());

      const finalStage = trackResult.finalStage;
      const entryFailure = trackResult.failure ??
        (!tracksBundleTransaction && !realSig ? submitResult.failure : null);

      const entry = this.buildEntry({
        runId,
        bundleId:         submitResult.bundleId,
        signature:        sigToTrack,
        built,
        submittedAt:      submitResult.submittedAt,
        stages:           trackResult.stages,
        finalStage,
        failure:          entryFailure,
        agentReasoning:   lastReasoning,
        agentConfidence:  lastConfidence,
        agentAction:      lastAction,
        leaderWindow,
        networkSnapshot,
        conditionsAtSubmission,
        conditionsAtConfirmation,
        triggerEvent:     triggerEvent ?? null,
        retryCount,
        latencyMs:        trackResult.latencyMs,
      });
      this.logger.appendLifecycle(entry);

      // If on-chain tx failed after landing, ask agent about retry
      if (trackResult.finalStage === "failed" && submitResult.success) {
        lastFailure = trackResult.failure;
        if (!lastFailure) return entry;

        const cls = this.classifier.fromReason(lastFailure, {
          retryCount,
          tipLamports:         built.tipLamports,
          tipP75Lamports:      tipStats.p75Lamports,
          streamSaysConfirmed: this.slotSource.getLatestConfirmedSlot() >= currentSlot,
          rpcConfirmed:        false,
        });

        const retryDecision = await this.agent.decideRetry({
          failure:             lastFailure,
          classification:      cls,
          retryCount,
          networkSnapshot,
          tipStats,
          previousTipLamports: built.tipLamports,
          blockhashExpired:    lastFailure === "EXPIRED_BLOCKHASH",
          faultMode:           "none",
        });
        if (!retryDecision.shouldRetry) return entry;
        if (retryDecision.refreshBlockhash) this.builder.invalidateBlockhash();
        await sleep(retryDecision.waitMs);
        retryCount++;
        continue;
      }

      return entry;
    }

    // Max retries exhausted
    const slot = await this.getReliableCurrentSlot();
    const lw   = await this.leaderDetector.detect(slot);
    const cond = await this.networkObs.captureConditions(this.recentFailureRate());
    const snap: NetworkSnapshot = {
      currentSlot: slot, averageSlotTimeMs: 400,
      recentFailureRate: this.recentFailureRate(),
      leaderWindow: lw,
      processedToConfirmedMsP50: null,
      processedToConfirmedMsP90: null,
      conditions: cond,
    };

    const entry = this.buildEntry({
      runId, bundleId: null, signature: null, built: null,
      submittedAt: Date.now(), stages: [], finalStage: "failed",
      failure: lastFailure, agentReasoning: "Max retries exhausted. " + lastReasoning,
      agentConfidence: lastConfidence, agentAction: "abort",
      leaderWindow: lw, networkSnapshot: snap,
      conditionsAtSubmission: cond, triggerEvent: triggerEvent ?? null, retryCount,
    });
    this.logger.appendLifecycle(entry);
    return entry;
  }

  // ── Send a real zero-lamport self-transfer ────────────────────────────────

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

  private async getReliableCurrentSlot(): Promise<number> {
    const streamed = this.slotSource.getCurrentSlot();
    if (streamed > 0) return streamed;

    try {
      const rpcSlot = await this.connection.getSlot("processed");
      if (rpcSlot > 0) {
        await this.logger.warn("[stack] Slot stream had no current slot; using RPC slot for submission metadata", {
          rpcSlot,
        });
        return rpcSlot;
      }
    } catch (err) {
      await this.logger.warn("[stack] Could not recover current slot from RPC", {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    return streamed;
  }

  // ── Build lifecycle entry ─────────────────────────────────────────────────

  private buildEntry(p: {
    runId:                        string;
    bundleId:                     string | null;
    signature:                    string | null;
    built:                        { tipLamports: number; tipAccount: string; blockhash: string } | null;
    submittedAt:                  number;
    stages:                       LifecycleEntry["stages"];
    finalStage:                   LifecycleEntry["finalStage"];
    failure:                      FailureReason | null;
    agentReasoning:               string;
    agentConfidence:              number;
    agentAction:                  string;
    leaderWindow:                 LeaderWindow | null;
    networkSnapshot:              NetworkSnapshot | null;
    conditionsAtSubmission:       NetworkConditions | null;
    conditionsAtConfirmation?:    NetworkConditions | null;
    triggerEvent?:                TriggerEvent | null;
    retryCount:                   number;
    latencyMs?:                   LifecycleEntry["latencyMs"];
  }): LifecycleEntry {
    const network = config.solana.network === "mainnet-beta" ? "mainnet-beta" : "devnet";

    const sub  = p.conditionsAtSubmission;
    const conf = p.conditionsAtConfirmation ?? null;

    const delta: LifecycleEntry["deltaFromSubmissionToConfirmation"] =
      sub && conf
        ? {
            blockProductionRateDeltaMs: conf.blockProductionRateMs - sub.blockProductionRateMs,
            prioritizationFeeDelta: {
              p50: conf.recentPrioritizationFees.p50 - sub.recentPrioritizationFees.p50,
              p75: conf.recentPrioritizationFees.p75 - sub.recentPrioritizationFees.p75,
            },
            processedToConfirmedDeltaMs:
              conf.processedToConfirmedP50 !== null && sub.processedToConfirmedP50 !== null
                ? conf.processedToConfirmedP50 - sub.processedToConfirmedP50
                : null,
            validatorLoadProxyDelta: conf.validatorLoadProxy - sub.validatorLoadProxy,
            bundleLandingRateDelta:  conf.bundleLandingRate  - sub.bundleLandingRate,
          }
        : null;

    return {
      runId:           p.runId,
      bundleId:        p.bundleId,
      signature:       p.signature,
      tipLamports:     p.built?.tipLamports ?? 0,
      tipAccount:      p.built?.tipAccount  ?? "",
      submittedAt:     p.submittedAt,
      submittedAtIso:  new Date(p.submittedAt).toISOString(),
      stages:          p.stages,
      finalStage:      p.finalStage,
      failure:         p.failure,
      faultInjected:   "none",
      agentReasoning:  p.agentReasoning,
      agentConfidence: p.agentConfidence,
      agentAction:     p.agentAction,
      leaderWindow:    p.leaderWindow,
      networkSnapshot: p.networkSnapshot,
      networkConditionsAtSubmission:   sub,
      networkConditionsAtConfirmation: conf,
      deltaFromSubmissionToConfirmation: delta,
      triggerEvent:    p.triggerEvent ?? null,
      retryCount:      p.retryCount,
      blockhashUsed:   p.built?.blockhash ?? "",
      slotAtSubmission:
        p.stages.find((s) => s.stage === "submitted")?.slot ??
        p.networkSnapshot?.currentSlot ??
        null,
      explorerUrl: p.signature
        ? `https://explorer.solana.com/tx/${p.signature}?cluster=${network}`
        : null,
      latencyMs: p.latencyMs ?? {
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
    return this.recentOutcomes.filter((o) => !o).length / this.recentOutcomes.length;
  }

  private async printSummary(entries: LifecycleEntry[]): Promise<void> {
    const total   = entries.length;
    const ok      = entries.filter((e) =>
      e.finalStage === "confirmed" || e.finalStage === "finalized"
    ).length;
    const failed  = entries.filter((e) => e.finalStage === "failed").length;
    const avgTip  = Math.round(entries.reduce((s, e) => s + e.tipLamports, 0) / (total || 1));
    const withSig = entries.filter((e) => e.signature).length;
    const uniqueTips = new Set(entries.map((e) => e.tipLamports)).size;

    await this.logger.divider("Lifecycle Summary");
    await this.logger.info(`Total runs:          ${total}`);
    await this.logger.ok(  `  Confirmed:         ${ok}`);
    await this.logger.error(`  Failed:            ${failed}`);
    await this.logger.info( `  Avg tip:           ${avgTip} lamports`);
    await this.logger.info( `  Unique tip values: ${uniqueTips}`);
    await this.logger.info( `  Verifiable sigs:   ${withSig}`);
    await this.logger.info( `  Network:           ${config.solana.network}`);
  }
}
