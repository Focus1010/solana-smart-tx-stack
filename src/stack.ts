import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { Agent }                     from "./agent/agent";
import { BundleBuilder }             from "./bundle/bundle-builder";
import { BundleSubmitter }           from "./bundle/bundle-submitter";
import { LifecycleTracker }          from "./lifecycle/lifecycle-tracker";
import { SlotPoller, SlotStream }    from "./stream/slot-stream";
import { TipOracle }                 from "./stream/tip-oracle";
import { NetworkStateObserver }      from "./stream/network-state-observer";
import { LeaderWindowDetector }      from "./jito/leader-window-detector";
import { JitoBundleClient }          from "./jito/jito-bundle-client";
import { createJitoClient }          from "./jito/create-jito-client";
import { AdvancedFailureClassifier } from "./bundle/failure-classifier";
import { Logger }                    from "./utils/logger";
import { newRunId, sleep, shortKey, estimateSlotTimeMs } from "./utils/helpers";
import { config }                    from "./config";
import {
  LifecycleEntry,
  TipDecisionInput,
  RetryDecisionInput,
  FailureReason,
  NetworkSnapshot,
  NetworkConditions,
  NetworkConditionsDelta,
  TriggerEvent,
  MarinadeTriggerEvent,
  LeaderWindow,
  AgentDecisionEvidence,
} from "./types";
import { MarinadeLiquidStakingListener } from "./stream/marinade-event-stream";
import { ProtocolTrigger, ProtocolEvent } from "./stream/protocol-trigger";

//  Stack 

export class Stack {
  private connection:     Connection;
  private payer:          Keypair;
  private logger:         Logger;
  private agent!:         Agent;
  private builder:        BundleBuilder;
  private submitter:      BundleSubmitter;
  private tracker:        LifecycleTracker;
  private tipOracle:      TipOracle;
  private networkObs:     NetworkStateObserver;
  private leaderDetector: LeaderWindowDetector;
  private classifier:     AdvancedFailureClassifier;
  private slotSource:     SlotPoller | SlotStream;
  private jitoClient:     JitoBundleClient;
  private slotStreamHealthy = true;
  private protocolTrigger: ProtocolTrigger | null = null;
  private triggerSubmitting = false;
  private triggerQueue: ProtocolEvent[] = [];

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
    this.slotStreamHealthy = config.yellowstone.endpoint.length > 0;

    const jitoClient     = createJitoClient(logger);
    this.jitoClient      = jitoClient;

    this.builder         = new BundleBuilder(this.connection, payer, logger);
    this.submitter       = new BundleSubmitter(this.connection, payer, logger, jitoClient, this.builder);
    this.tracker         = new LifecycleTracker(this.connection, this.slotSource, logger);
    this.tipOracle       = new TipOracle(this.connection, logger);
    this.networkObs      = new NetworkStateObserver(this.connection, logger);
    this.leaderDetector  = new LeaderWindowDetector(jitoClient, logger);
    this.classifier      = new AdvancedFailureClassifier();

    // Wire the leader detector into the submitter so it can gate on leader windows
    this.submitter.setLeaderDetector(this.leaderDetector);

    if (config.trigger.protocol !== "none") {
      this.protocolTrigger = new ProtocolTrigger(this.connection, logger);
    }
  }

  //  Initialise 

  async start(): Promise<void> {
    await this.logger.divider("Smart Transaction Stack -- Starting");
    await this.logger.info("[stack] Network: " + config.solana.network);
    await this.logger.info("[stack] Payer:   " + shortKey(this.payer.publicKey.toBase58(), 12));
    this.agent = await Agent.create(this.logger);

    // Register fallback handler BEFORE start() so we catch both:
    //   (a) immediate emit from start() when native binding is unavailable
    //   (b) deferred emit after 3 failed reconnect attempts
    this.slotSource.on("fallback", async () => {
      this.slotStreamHealthy = false;
      await this.logger.warn("[stack] Yellowstone unavailable -- switching to RPC poller");
      if (this.slotSource instanceof SlotPoller) return; // already on poller
      const poller = new SlotPoller(this.connection, this.logger);
      // Re-register the slot timestamp forwarder on the new source
      poller.on("slot", (ev: any) => {
        if (ev?.status === "processed") {
          this.networkObs.recordSlotTimestamp(ev.timestamp);
        }
      });
      this.slotSource = poller;
      this.tracker    = new LifecycleTracker(this.connection, poller, this.logger);
      await poller.start();
    });

    // Forward slot timestamps to NetworkStateObserver
    this.slotSource.on("slot", (ev: any) => {
      if (ev?.status === "processed") {
        this.networkObs.recordSlotTimestamp(ev.timestamp);
      }
    });

    await this.slotSource.start();

    if (this.protocolTrigger) {
      await this.protocolTrigger.start();
      this.protocolTrigger.on("protocolEvent", (ev: ProtocolEvent) => {
        void this.handleProtocolTriggerEvent(ev);
      });
    }

    await sleep(1_500);
  }

  stop(): void {
    this.protocolTrigger?.stop();
    this.slotSource.stop();
  }

  //  Run N bundle submissions 

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

  //  Reactive run: triggered by real Marinade Finance staking events 
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
      `[marinade] Listening for large staking events (>= 1 SOL), ` +
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
        const marinadeTriggerEvent: MarinadeTriggerEvent = {
          eventType: event.eventType === "unstake" ? "unstake" : "stake",
          slot: event.slot,
          signature: event.signature,
          amountLamports: event.amountLamports,
          timestamp: event.timestamp,
        };

        const entry = await this.runOne(triggerEvent, marinadeTriggerEvent);
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

  //  Reactive run: SPL token / Raydium protocol trigger 

  async runWithProtocolTriggering(
    maxEvents: number = 3,
    timeoutMs: number = 5 * 60_000
  ): Promise<LifecycleEntry[]> {
    if (!this.protocolTrigger) {
      await this.logger.warn(
        "[trigger] Protocol trigger not configured. Set TRIGGER_PROTOCOL and TRIGGER_MINT."
      );
      return [];
    }

    await this.logger.divider("Protocol-triggered bundle submissions");
    const entries: LifecycleEntry[] = [];
    let triggered = 0;

    const handler = async (ev: ProtocolEvent) => {
      if (triggered >= maxEvents) return;
      triggered++;
      const entry = await this.handleProtocolTriggerEvent(ev);
      if (entry) entries.push(entry);
    };

    this.protocolTrigger.on("protocolEvent", handler);

    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    await timeoutPromise;

    this.protocolTrigger.off("protocolEvent", handler);

    if (entries.length === 0) {
      await this.logger.warn(
        "[trigger] No qualifying protocol events within timeout (normal on low-traffic devnet)."
      );
    } else {
      await this.logger.ok(`[trigger] ${entries.length} event-triggered bundle(s) submitted`);
    }

    return entries;
  }

  private async handleProtocolTriggerEvent(ev: ProtocolEvent): Promise<LifecycleEntry | null> {
    await this.logger.info("[trigger] Protocol event received", {
      type: ev.type,
      sig:  ev.txSignature.slice(0, 12) + "...",
      slot: ev.slot,
    });

    this.networkObs.recordSlotTimestamp(ev.slotTimestamp ?? Date.now());

    if (this.triggerSubmitting) {
      this.triggerQueue.push(ev);
      return null;
    }

    this.triggerSubmitting = true;
    try {
      const currentSlot  = await this.getReliableCurrentSlot();
      const leaderWindow = await this.leaderDetector.detect(currentSlot);
      const gate         = await this.evaluateSubmissionGate(leaderWindow);

      if (gate === "blocked") {
        await this.logger.warn("[trigger] Submission skipped — leader-window gating policy");
        return null;
      }

      const triggerEvent: TriggerEvent = {
        type: "protocol_trigger",
        metadata: {
          protocolType:  ev.type,
          txSignature:   ev.txSignature,
          programId:     ev.programId,
          slot:          ev.slot,
          explorerUrl:   ev.explorerUrl,
          parsedDetails: ev.parsedDetails,
        },
        detectedAt: new Date().toISOString(),
      };

      return await this.runOne(triggerEvent, null);
    } finally {
      this.triggerSubmitting = false;
      const next = this.triggerQueue.shift();
      if (next) void this.handleProtocolTriggerEvent(next);
    }
  }

  //  Single bundle run (agent-driven retry loop) 

  async runOne(
    triggerEvent?: TriggerEvent,
    marinadeTriggerEvent?: MarinadeTriggerEvent | null
  ): Promise<LifecycleEntry> {
    const runId         = newRunId();
    let retryCount      = 0;
    let lastFailure:    FailureReason | null = null;
    let lastTip:        number | null        = null;
    let lastReasoning   = "";
    let lastConfidence  = 0.8;
    let lastAction      = "submit_now";
    const agentDecisionTrace: AgentDecisionEvidence[] = [];

    while (retryCount <= config.stack.maxRetries) {

      //  1. Build NetworkSnapshot 

      const currentSlot  = await this.getReliableCurrentSlot();
      const slotTimes    = this.slotSource.getRecentSlotTimes();
      const avgSlotMs    = estimateSlotTimeMs(slotTimes);
      const leaderWindow = await this.leaderDetector.detect(currentSlot);
      const tipStats     = await this.tipOracle.fetchTipStats();
      const conditions   = await this.networkObs.captureConditions(this.recentFailureRate());
      const conditionsAtSubmission = conditions;

      // ── Submission gating (mainnet only) ──────────────────────────────────
      const isEmergencySubmit = await this.evaluateSubmissionGate(leaderWindow);
      if (isEmergencySubmit === "blocked") {
        const entry = this.buildEntry({
          runId, bundleId: null, signature: null, built: null,
          submittedAt: Date.now(), stages: [], finalStage: "failed",
          failure: "BUNDLE_DROPPED",
          agentReasoning:
            "Submission skipped: Yellowstone stream unavailable and no Jito leader window confirmed.",
          agentConfidence: 0.9, agentAction: "hold_and_wait",
          leaderWindow, networkSnapshot: {
            currentSlot, averageSlotTimeMs: estimateSlotTimeMs(this.slotSource.getRecentSlotTimes()),
            recentFailureRate: this.recentFailureRate(), leaderWindow,
            processedToConfirmedMsP50: conditions.processedToConfirmedP50,
            processedToConfirmedMsP90: conditions.processedToConfirmedP90,
            conditions,
          },
          conditionsAtSubmission, triggerEvent: triggerEvent ?? null, retryCount,
          marinadeTriggerEvent: marinadeTriggerEvent ?? null,
          agentDecisionTrace,
        });
        this.logger.appendLifecycle(entry);
        return entry;
      }

      const networkSnapshot: NetworkSnapshot = {
        currentSlot,
        averageSlotTimeMs:         avgSlotMs,
        recentFailureRate:         this.recentFailureRate(),
        leaderWindow,
        processedToConfirmedMsP50: conditions.processedToConfirmedP50,
        processedToConfirmedMsP90: conditions.processedToConfirmedP90,
        conditions,
      };

      //  2. Agent decides tip 

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
      let selectedTip    = tipDecision.tipLamports;

      if (isEmergencySubmit === "emergency") {
        const floor = Math.max(
          config.submission.emergencyTipFloorLamports,
          config.jito.emergencyMinTipLamports
        );
        if (selectedTip < floor) {
          selectedTip = floor;
          tipDecision.reasoning =
            `EMERGENCY SUBMIT: bumped tip to floor ${floor} lamports due to stream unavailability. ` +
            tipDecision.reasoning;
          tipDecision.guardrailAdjusted = true;
        }
      }

      lastTip            = selectedTip;
      lastReasoning      = tipDecision.reasoning;
      lastConfidence     = tipDecision.confidenceScore;
      lastAction         = tipDecision.action;
      agentDecisionTrace.push({
        decisionType:                "tip_intelligence",
        action:                      tipDecision.action,
        reasoning:                   tipDecision.reasoning,
        confidenceScore:             tipDecision.confidenceScore,
        tipLamports:                 selectedTip,
        selectedPercentile:          tipDecision.selectedPercentile,
        congestionMultiplier:        tipDecision.congestionMultiplier,
        leaderUrgencyMultiplier:     tipDecision.leaderUrgencyMultiplier,
        landingProbabilityEstimate:  tipDecision.landingProbabilityEstimate,
        engine:                      tipDecision.engine,
        model:                       tipDecision.model,
        promptHash:                  tipDecision.promptHash,
        llmLatencyMs:                tipDecision.llmLatencyMs,
        guardrailAdjusted:           tipDecision.guardrailAdjusted,
        retryCount,
        createdAt:                   new Date().toISOString(),
      });

      //  3. Build bundle 

      const built = await this.builder.build(
        selectedTip,
        currentSlot,
        lastFailure === "EXPIRED_BLOCKHASH"
      );

      await this.logger.info("[stack] Bundle built", {
        blockhash: built.blockhash.slice(0, 12) + "...",
        tip:       built.tipLamports,
        slot:      currentSlot,
        network:   config.solana.network,
      });

      //  4. Submit bundle to Jito immediately, in parallel with the real
      //     evidence transaction.
      //
      // CRITICAL ORDERING: a Jito bundle is only valid for its target
      // leader's slot window, roughly 1 to 4 slots (400ms to 1.6s on
      // mainnet). The bundle's blockhash was fetched moments ago inside
      // builder.build(). If we wait for sendRealTx() to fully confirm
      // on-chain (a separate, unrelated decoy transaction sent purely for
      // evidence purposes) before submitting the bundle, the bundle's
      // blockhash can age by several seconds -- observed up to 5.6s (about
      // 14 slots) during RPC throttling -- well past its own live window,
      // before it ever reaches the block engine. That guarantees the
      // bundle arrives too late to compete, independent of tip size or
      // leader luck.
      //
      // Running both concurrently means the bundle reaches Jito as soon as
      // it is built, while the evidence transaction's confirmation latency
      // no longer sits in the bundle's critical path.

      const [submitResult, realSig] = await Promise.all([
        this.submitter.submit(built, currentSlot),
        this.sendRealTx(built.blockhash),
      ]);

      //  5. Track lifecycle 

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
        lastConfidence = retryDecision.confidenceScore;
        lastAction = retryDecision.action;
        agentDecisionTrace.push({
          decisionType:          "autonomous_retry",
          action:                retryDecision.action,
          reasoning:             retryDecision.reasoning,
          confidenceScore:       retryDecision.confidenceScore,
          previousTipLamports:   built.tipLamports,
          newTipLamports:        retryDecision.newTipLamports,
          failure:               lastFailure,
          refreshBlockhash:      retryDecision.refreshBlockhash,
          waitMs:                retryDecision.waitMs,
          engine:                retryDecision.engine,
          model:                 retryDecision.model,
          promptHash:            retryDecision.promptHash,
          llmLatencyMs:          retryDecision.llmLatencyMs,
          guardrailAdjusted:     retryDecision.guardrailAdjusted,
          retryCount,
          createdAt:             new Date().toISOString(),
        });

        if (!retryDecision.shouldRetry) {
          const entry = this.buildEntry({
            runId, bundleId: null, signature: null, built,
            submittedAt: submitResult.submittedAt, stages: [],
            finalStage: "failed", failure: lastFailure,
            agentReasoning: lastReasoning, agentConfidence: lastConfidence,
            agentAction: lastAction, leaderWindow, networkSnapshot,
            conditionsAtSubmission, triggerEvent: triggerEvent ?? null, retryCount,
            marinadeTriggerEvent: marinadeTriggerEvent ?? null,
            agentDecisionTrace,
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
        marinadeTriggerEvent: marinadeTriggerEvent ?? null,
        retryCount,
        latencyMs:        trackResult.latencyMs,
        agentDecisionTrace,
        rawBundleResults: submitResult.rawBundleResults ?? [],
        raw: {
          bundleResults: submitResult.rawBundleResults ?? [],
          bundleResult:  (submitResult.rawBundleResults ?? []).slice(-1)[0],
        },
        bundleTxSignature: submitResult.bundleTxSignature ?? built?.bundleTxSignature ?? null,
      });
      // If on-chain tx failed after landing, ask agent about retry
      if (trackResult.finalStage === "failed" && submitResult.success) {
        lastFailure = trackResult.failure;
        if (!lastFailure) {
          this.logger.appendLifecycle(entry);
          return entry;
        }

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
        lastReasoning = retryDecision.reasoning;
        lastConfidence = retryDecision.confidenceScore;
        lastAction = retryDecision.action;
        agentDecisionTrace.push({
          decisionType:          "failure_reasoning",
          action:                retryDecision.action,
          reasoning:             retryDecision.reasoning,
          confidenceScore:       retryDecision.confidenceScore,
          previousTipLamports:   built.tipLamports,
          newTipLamports:        retryDecision.newTipLamports,
          failure:               lastFailure,
          refreshBlockhash:      retryDecision.refreshBlockhash,
          waitMs:                retryDecision.waitMs,
          engine:                retryDecision.engine,
          model:                 retryDecision.model,
          promptHash:            retryDecision.promptHash,
          llmLatencyMs:          retryDecision.llmLatencyMs,
          guardrailAdjusted:     retryDecision.guardrailAdjusted,
          retryCount,
          createdAt:             new Date().toISOString(),
        });
        entry.agentReasoning = lastReasoning;
        entry.agentConfidence = lastConfidence;
        entry.agentAction = lastAction;
        entry.agentDecisionType = "failure_reasoning";
        entry.agentDecisionTrace = [...agentDecisionTrace];
        this.logger.appendLifecycle(entry);
        if (!retryDecision.shouldRetry) return entry;
        if (retryDecision.refreshBlockhash) this.builder.invalidateBlockhash();
        await sleep(retryDecision.waitMs);
        retryCount++;
        continue;
      }

      this.logger.appendLifecycle(entry);
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
      marinadeTriggerEvent: marinadeTriggerEvent ?? null,
      agentDecisionTrace,
    });
    this.logger.appendLifecycle(entry);
    return entry;
  }

  //  Send a real zero-lamport self-transfer 

  private async sendRealTx(_bundleBlockhash: string): Promise<string | null> {
    try {
      // Fetch a FRESH blockhash independent of the bundle's cached blockhash.
      // If sendRealTx reused the bundle's blockhash AND had identical instructions,
      // both txs would produce the same signature -- Jito drops the bundle as a
      // duplicate of an already-confirmed transaction (Invalid status).
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash("confirmed");

      const message = new TransactionMessage({
        payerKey:        this.payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: this.payer.publicKey,
            toPubkey:   this.payer.publicKey,
            lamports:   0,
          }),
        ],
      }).compileToV0Message();

      const vtx = new VersionedTransaction(message);
      vtx.sign([this.payer]);

      const sig = await this.connection.sendTransaction(vtx, {
        skipPreflight:       false,
        preflightCommitment: "confirmed",
      });

      // Pass the cached lastValidBlockHeight -- avoids a second getLatestBlockhash()
      // call inside confirmTransaction which would add another RPC hit on the
      // free public endpoint and contribute to 429s.
      await this.connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
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

  /**
   * Leader-window submission gating policy.
   * Returns "ok" to proceed, "emergency" when override is active, or "blocked".
   */
  private async evaluateSubmissionGate(
    leaderInfo: LeaderWindow
  ): Promise<"ok" | "emergency" | "blocked"> {
    if (config.solana.network !== "mainnet-beta") return "ok";

    if (this.slotStreamHealthy && leaderInfo.isJitoLeaderWindow) {
      return "ok";
    }

    if (!this.slotStreamHealthy && leaderInfo.isJitoLeaderWindow) {
      await this.logger.info(
        "[stack] Stream unavailable but leader window confirmed. Proceeding."
      );
      return "ok";
    }

    if (!this.slotStreamHealthy && !leaderInfo.isJitoLeaderWindow) {
      if (config.submission.requireLeaderWindowWhenStreamDown) {
        if (config.submission.emergencyOverrideAllowed) {
          await this.logger.warn(
            "[stack] EMERGENCY: Submitting without leader window. Bumping tip to floor."
          );
          return "emergency";
        }
        await this.logger.warn(
          "[stack] Stream unavailable and no leader window confirmed. Refusing submit."
        );
        return "blocked";
      }
    }

    if (!config.submission.emergencyOverrideAllowed && !leaderInfo.isJitoLeaderWindow) {
      await this.logger.warn("[stack] Emergency override disabled. Refusing submit.");
      return "blocked";
    }

    return "ok";
  }

  //  Build lifecycle entry 

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
    marinadeTriggerEvent?:        MarinadeTriggerEvent | null;
    retryCount:                   number;
    latencyMs?:                   LifecycleEntry["latencyMs"];
    agentDecisionTrace?:          AgentDecisionEvidence[];
    rawBundleResults?:             unknown[];
    raw?:                          LifecycleEntry["raw"];
    bundleTxSignature?:            string | null;
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

    // Build the structured agentDecision block from the last tip decision trace
    const lastTipTrace = p.agentDecisionTrace?.find(
      (t) => t.decisionType === "tip_intelligence"
    );
    const agentDecision = lastTipTrace ? {
      engine:                     lastTipTrace.engine    ?? "",
      model:                      lastTipTrace.model     ?? "",
      action:                     lastTipTrace.action,
      selectedTipLamports:        lastTipTrace.tipLamports ?? 0,
      landingProbabilityEstimate: lastTipTrace.landingProbabilityEstimate ?? 0,
      reasoning:                  lastTipTrace.reasoning,
      promptHash:                 lastTipTrace.promptHash  ?? "",
      llmLatencyMs:               lastTipTrace.llmLatencyMs ?? 0,
      guardrailAdjusted:          lastTipTrace.guardrailAdjusted ?? false,
    } : undefined;

    return {
      runId:           p.runId,
      bundleId:        p.bundleId,
      signature:       p.signature,
      network:         config.solana.network,
      dryRun:          false,
      tipLamports:     p.built?.tipLamports ?? 0,
      tipAccount:      p.built?.tipAccount  ?? "",
      submittedAt:     p.submittedAt,
      submittedAtIso:  new Date(p.submittedAt).toISOString(),
      stages:          p.stages,
      finalStage:      p.finalStage,
      failure:         p.failure,
      failureClass:    p.failure,
      failureMessage:  null,
      faultInjected:   "none",
      agentReasoning:  p.agentReasoning,
      agentConfidence: p.agentConfidence,
      agentAction:     p.agentAction,
      agentDecision,
      agentDecisionType: p.agentDecisionTrace?.[p.agentDecisionTrace.length - 1]?.decisionType ?? undefined,
      agentDecisionTrace: p.agentDecisionTrace ?? [],
      leaderWindow:    p.leaderWindow,
      networkSnapshot: p.networkSnapshot,
      networkConditionsAtSubmission:   sub,
      networkConditionsAtConfirmation: conf,
      deltaFromSubmissionToConfirmation: delta,
      triggerEvent:    p.triggerEvent ?? null,
      marinadeTriggerEvent: p.marinadeTriggerEvent ?? null,
      retryCount:      p.retryCount,
      blockhashUsed:   p.built?.blockhash ?? "",
      slotAtSubmission:
        p.stages.find((s) => s.stage === "submitted")?.slot ??
        p.networkSnapshot?.currentSlot ??
        null,
      explorerUrl: p.signature
        ? `https://explorer.solana.com/tx/${p.signature}?cluster=${network}`
        : null,
      bundleExplorerUrl: p.bundleId
        ? `https://explorer.jito.wtf/bundle/${p.bundleId}`
        : null,
      bundleTxSignature: p.bundleTxSignature ?? null,
      rawBundleResults: p.rawBundleResults ?? [],
      raw: p.raw,
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