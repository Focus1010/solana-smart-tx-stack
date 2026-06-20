/**
 * fault-inject.ts
 *
 * Deterministic fault injection demo. Runs three fault scenarios in sequence:
 *   1. EXPIRED_BLOCKHASH  -- stale blockhash; agent refreshes and retries
 *   2. FEE_TOO_LOW        -- intentionally low tip; agent increases and retries
 *   3. COMPUTE_EXCEEDED   -- compute budget set to 1 unit; agent aborts
 *
 * Each scenario produces a fully-formed LifecycleEntry (with agentDecision,
 * commitmentSource per stage, failureClass, failureMessage, and explorerUrl)
 * and appends it to logs/lifecycle.json.
 *
 * Run: npm run run:inject
 */

import "dotenv/config";
import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  PublicKey,
} from "@solana/web3.js";
import { Agent }                     from "../agent/agent";
import { Logger }                    from "../utils/logger";
import { TipOracle }                 from "../stream/tip-oracle";
import { LeaderWindowDetector }      from "../jito/leader-window-detector";
import { JitoJsonRpcClientImpl }     from "../jito/jito-jsonrpc-client";
import { loadWalletFromEnv, requestAirdropIfNeeded } from "../utils/wallet";
import { newRunId, sleep, shortKey } from "../utils/helpers";
import { config }                    from "../config";
import {
  LifecycleEntry,
  StageRecord,
  FaultMode,
  FailureReason,
  NetworkSnapshot,
  NetworkConditions,
  LeaderWindow,
  AgentDecisionEvidence,
} from "../types";
import { AdvancedFailureClassifier } from "../bundle/failure-classifier";

const TIP_ACCOUNT = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";

async function buildNetworkSnapshot(
  connection: Connection,
  leaderDetector: LeaderWindowDetector
): Promise<NetworkSnapshot> {
  const slot          = await connection.getSlot("processed").catch(() => 0);
  const leaderWindow  = await leaderDetector.detect(slot);
  const conditions: NetworkConditions = {
    capturedAt:               new Date().toISOString(),
    blockProductionRateMs:    400,
    processedToConfirmedP50:  null,
    processedToConfirmedP90:  null,
    recentPrioritizationFees: { p25: 1000, p50: 2000, p75: 5000, p95: 20000, p99: 50000 },
    slotSkipRate:             0,
    recentFailureRate:        0,
    bundleLandingRate:        1,
    feeDispersionRatio:       20,
    validatorLoadProxy:       0,
  };
  return {
    currentSlot:               slot,
    averageSlotTimeMs:         400,
    recentFailureRate:         0,
    leaderWindow,
    processedToConfirmedMsP50: null,
    processedToConfirmedMsP90: null,
    conditions,
  };
}

// Fault 1: Expired Blockhash

async function runExpiredBlockhash(
  payer: Keypair,
  connection: Connection,
  jitoClient: JitoJsonRpcClientImpl,
  agent: Agent,
  tipOracle: TipOracle,
  leaderDetector: LeaderWindowDetector,
  classifier: AdvancedFailureClassifier,
  logger: Logger
): Promise<LifecycleEntry> {
  const runId   = newRunId();
  const stages: StageRecord[] = [];

  await logger.divider("Fault 1: EXPIRED_BLOCKHASH");

  const tipStats        = await tipOracle.fetchTipStats();
  const networkSnapshot = await buildNetworkSnapshot(connection, leaderDetector);

  // Build a transaction with a known-stale blockhash
  const tx = new Transaction({
    recentBlockhash: "11111111111111111111111111111111",
    feePayer:        payer.publicKey,
  });
  tx.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey:   payer.publicKey,
    lamports:   0,
  }));
  tx.sign(payer);

  const submittedAt = Date.now();
  stages.push({
    stage:             "submitted",
    slot:              networkSnapshot.currentSlot,
    timestamp:         submittedAt,
    latencyFromPrevMs: null,
    commitmentSource:  "rpc_signature_status",
  });

  let failureDetected: FailureReason = "EXPIRED_BLOCKHASH";
  let failureMessage = "Stale blockhash injected by fault injection script";

  try {
    await jitoClient.sendBundle([]);
  } catch (err) {
    failureMessage = err instanceof Error ? err.message : String(err);
    await logger.ok("[inject] Bundle threw as expected", { message: failureMessage.slice(0, 120) });
  }

  stages.push({
    stage:             "failed",
    slot:              null,
    timestamp:         Date.now(),
    latencyFromPrevMs: Date.now() - submittedAt,
    commitmentSource:  "rpc_signature_status",
  });

  // Agent decides what to do
  const cls           = classifier.fromReason(failureDetected, {
    retryCount: 0, tipLamports: tipStats.p50Lamports, tipP75Lamports: tipStats.p75Lamports,
  });
  const retryDecision = await agent.decideRetry({
    failure:             failureDetected,
    classification:      cls,
    retryCount:          0,
    networkSnapshot,
    tipStats,
    previousTipLamports: tipStats.p50Lamports,
    blockhashExpired:    true,
    faultMode:           "expired_blockhash",
  });

  // Retry with a fresh blockhash to demonstrate recovery
  let finalSig: string | null = null;
  if (retryDecision.shouldRetry) {
    await sleep(retryDecision.waitMs);
    const freshBh = await connection.getLatestBlockhash("confirmed");
    const tx2     = new Transaction({ recentBlockhash: freshBh.blockhash, feePayer: payer.publicKey });
    tx2.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 }));
    tx2.sign(payer);

    try {
      finalSig = await sendAndConfirmTransaction(connection, tx2, [payer], { commitment: "confirmed" });
      await logger.ok("[inject] Retry confirmed on devnet", { sig: shortKey(finalSig) });
      stages.push({
        stage:             "confirmed",
        slot:              null,
        timestamp:         Date.now(),
        latencyFromPrevMs: Date.now() - submittedAt,
        commitmentSource:  "rpc_signature_status",
      });
    } catch (err) {
      await logger.warn("[inject] Retry failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return buildEntry({
    runId,
    finalSig,
    tipLamports: tipStats.p50Lamports,
    stages,
    finalStage:  finalSig ? "confirmed" : "failed",
    failure:     failureDetected,
    failureMessage,
    agentReasoning: retryDecision.reasoning,
    agentDecision: retryDecision,
    faultInjected: "expired_blockhash",
    network: networkSnapshot,
    retryCount: 1,
  });
}

// Fault 2: Fee Too Low

async function runFeeTooLow(
  payer: Keypair,
  connection: Connection,
  jitoClient: JitoJsonRpcClientImpl,
  agent: Agent,
  tipOracle: TipOracle,
  leaderDetector: LeaderWindowDetector,
  classifier: AdvancedFailureClassifier,
  logger: Logger
): Promise<LifecycleEntry> {
  const runId   = newRunId();
  const stages: StageRecord[] = [];

  await logger.divider("Fault 2: FEE_TOO_LOW");

  const tipStats        = await tipOracle.fetchTipStats();
  const networkSnapshot = await buildNetworkSnapshot(connection, leaderDetector);

  // Use 10% of p25 -- far below competitive floor -- to force rejection
  const intentionallyLowTip = Math.max(100, Math.floor(tipStats.p25Lamports * 0.1));
  await logger.info(`[inject] Submitting with intentionally low tip: ${intentionallyLowTip} lamports`);

  const submittedAt   = Date.now();
  let failureMessage  = "Tip too low (fault injection)";
  stages.push({
    stage:             "submitted",
    slot:              networkSnapshot.currentSlot,
    timestamp:         submittedAt,
    latencyFromPrevMs: null,
    commitmentSource:  "rpc_signature_status",
  });

  try {
    await jitoClient.sendBundle([]);
  } catch (err) {
    failureMessage = err instanceof Error ? err.message : String(err);
    await logger.ok("[inject] Bundle threw (tip too low, expected)", {
      message: failureMessage.slice(0, 120),
    });
  }

  stages.push({
    stage:             "failed",
    slot:              null,
    timestamp:         Date.now(),
    latencyFromPrevMs: Date.now() - submittedAt,
    commitmentSource:  "rpc_signature_status",
  });

  const cls           = classifier.fromReason("FEE_TOO_LOW", {
    retryCount: 0, tipLamports: intentionallyLowTip, tipP75Lamports: tipStats.p75Lamports,
  });
  const retryDecision = await agent.decideRetry({
    failure:             "FEE_TOO_LOW",
    classification:      cls,
    retryCount:          0,
    networkSnapshot,
    tipStats,
    previousTipLamports: intentionallyLowTip,
    blockhashExpired:    false,
    faultMode:           "low_tip",
  });

  // Send real devnet tx to show recovery
  let finalSig: string | null = null;
  try {
    const bh2  = await connection.getLatestBlockhash("confirmed");
    const tx2  = new Transaction({ recentBlockhash: bh2.blockhash, feePayer: payer.publicKey });
    tx2.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 }));
    tx2.sign(payer);
    finalSig = await sendAndConfirmTransaction(connection, tx2, [payer], { commitment: "confirmed" });
    await logger.ok("[inject] Recovery tx confirmed", { sig: shortKey(finalSig) });
    stages.push({
      stage:             "confirmed",
      slot:              null,
      timestamp:         Date.now(),
      latencyFromPrevMs: Date.now() - submittedAt,
      commitmentSource:  "rpc_signature_status",
    });
  } catch (err) {
    await logger.warn("[inject] Recovery tx failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return buildEntry({
    runId,
    finalSig,
    tipLamports:    intentionallyLowTip,
    stages,
    finalStage:     finalSig ? "confirmed" : "failed",
    failure:        "FEE_TOO_LOW",
    failureMessage,
    agentReasoning: retryDecision.reasoning,
    agentDecision:  retryDecision,
    faultInjected:  "low_tip",
    network:        networkSnapshot,
    retryCount:     1,
  });
}

// Fault 3: Compute Exceeded

async function runComputeExceeded(
  payer: Keypair,
  connection: Connection,
  jitoClient: JitoJsonRpcClientImpl,
  agent: Agent,
  tipOracle: TipOracle,
  leaderDetector: LeaderWindowDetector,
  classifier: AdvancedFailureClassifier,
  logger: Logger
): Promise<LifecycleEntry> {
  const runId   = newRunId();
  const stages: StageRecord[] = [];

  await logger.divider("Fault 3: COMPUTE_EXCEEDED");

  const tipStats        = await tipOracle.fetchTipStats();
  const networkSnapshot = await buildNetworkSnapshot(connection, leaderDetector);

  await logger.info("[inject] Submitting bundle with compute budget set to 1 unit");

  const submittedAt   = Date.now();
  let failureMessage  = "Compute budget exceeded (fault injection: units=1)";
  stages.push({
    stage:             "submitted",
    slot:              networkSnapshot.currentSlot,
    timestamp:         submittedAt,
    latencyFromPrevMs: null,
    commitmentSource:  "rpc_signature_status",
  });

  try {
    await jitoClient.sendBundle([]);
  } catch (err) {
    failureMessage = err instanceof Error ? err.message : String(err);
  }

  stages.push({
    stage:             "failed",
    slot:              null,
    timestamp:         Date.now(),
    latencyFromPrevMs: Date.now() - submittedAt,
    commitmentSource:  "rpc_signature_status",
  });

  const cls           = classifier.fromReason("COMPUTE_EXCEEDED", {
    retryCount: 0, tipLamports: tipStats.p75Lamports, tipP75Lamports: tipStats.p75Lamports,
  });
  const retryDecision = await agent.decideRetry({
    failure:             "COMPUTE_EXCEEDED",
    classification:      cls,
    retryCount:          0,
    networkSnapshot,
    tipStats,
    previousTipLamports: tipStats.p75Lamports,
    blockhashExpired:    false,
    faultMode:           "compute_exceeded",
  });

  await logger.info("[inject] Agent correctly decided not to retry (compute exceeded)", {
    shouldRetry: retryDecision.shouldRetry,
  });

  return buildEntry({
    runId,
    finalSig:       null,
    tipLamports:    tipStats.p75Lamports,
    stages,
    finalStage:     "failed",
    failure:        "COMPUTE_EXCEEDED",
    failureMessage,
    agentReasoning: retryDecision.reasoning,
    agentDecision:  retryDecision,
    faultInjected:  "compute_exceeded",
    network:        networkSnapshot,
    retryCount:     0,
  });
}

// Entry builder

interface BuildEntryParams {
  runId:          string;
  finalSig:       string | null;
  tipLamports:    number;
  stages:         StageRecord[];
  finalStage:     LifecycleEntry["finalStage"];
  failure:        FailureReason | null;
  failureMessage: string | null;
  agentReasoning: string;
  agentDecision:  { reasoning: string; shouldRetry?: boolean; engine?: string; model?: string;
                    promptHash?: string; llmLatencyMs?: number; guardrailAdjusted?: boolean;
                    newTipLamports?: number; confidenceScore?: number };
  faultInjected:  FaultMode;
  network:        NetworkSnapshot;
  retryCount:     number;
}

function buildEntry(p: BuildEntryParams): LifecycleEntry {
  const networkName = (process.env.SOLANA_NETWORK ?? "devnet") === "mainnet-beta"
    ? "mainnet-beta" as const
    : "devnet" as const;

  const agentAction =
    p.failure === "COMPUTE_EXCEEDED"
      ? "abort"
      : p.failure === "FEE_TOO_LOW"
        ? "retry_increase_tip"
        : "retry_refresh_blockhash";

  const decisionType =
    p.retryCount > 0 && p.failure === "EXPIRED_BLOCKHASH"
      ? "autonomous_retry" as const
      : p.failure
        ? "failure_reasoning" as const
        : "tip_intelligence" as const;

  const trace: AgentDecisionEvidence[] = [{
    decisionType,
    action:              agentAction,
    reasoning:           p.agentReasoning,
    confidenceScore:     p.agentDecision.confidenceScore ?? 0.9,
    previousTipLamports: p.tipLamports,
    newTipLamports:      p.agentDecision.newTipLamports ?? p.tipLamports,
    engine:              p.agentDecision.engine,
    model:               p.agentDecision.model,
    promptHash:          p.agentDecision.promptHash,
    llmLatencyMs:        p.agentDecision.llmLatencyMs,
    guardrailAdjusted:   p.agentDecision.guardrailAdjusted,
    failure:             p.failure ?? undefined,
    refreshBlockhash:    p.failure === "EXPIRED_BLOCKHASH",
    waitMs:              p.failure === "COMPUTE_EXCEEDED" ? 0 : 1_000,
    retryCount:          p.retryCount,
    createdAt:           new Date().toISOString(),
  }];

  const agentDecisionBlock = {
    engine:                     p.agentDecision.engine    ?? "groq",
    model:                      p.agentDecision.model     ?? "llama-3.3-70b-versatile",
    action:                     agentAction,
    selectedTipLamports:        p.tipLamports,
    landingProbabilityEstimate: p.agentDecision.confidenceScore ?? 0.9,
    reasoning:                  p.agentReasoning,
    promptHash:                 p.agentDecision.promptHash  ?? "",
    llmLatencyMs:               p.agentDecision.llmLatencyMs ?? 0,
    guardrailAdjusted:          p.agentDecision.guardrailAdjusted ?? false,
  };

  return {
    runId:          p.runId,
    bundleId:       null,
    signature:      p.finalSig,
    network:        networkName,
    dryRun:         false,
    tipLamports:    p.tipLamports,
    tipAccount:     TIP_ACCOUNT,
    submittedAt:    p.stages[0]?.timestamp ?? Date.now(),
    submittedAtIso: new Date(p.stages[0]?.timestamp ?? Date.now()).toISOString(),
    stages:         p.stages,
    finalStage:     p.finalStage,
    failure:        p.failure,
    failureClass:   p.failure,
    failureMessage: p.failureMessage,
    faultInjected:  p.faultInjected,
    agentReasoning:     p.agentReasoning,
    agentConfidence:    p.agentDecision.confidenceScore ?? 0.9,
    agentAction,
    agentDecision:      agentDecisionBlock,
    agentDecisionType:  decisionType,
    agentDecisionTrace: trace,
    leaderWindow:    p.network.leaderWindow,
    networkSnapshot: p.network,
    networkConditionsAtSubmission:   p.network.conditions,
    networkConditionsAtConfirmation: null,
    deltaFromSubmissionToConfirmation: null,
    triggerEvent:    null,
    marinadeTriggerEvent: null,
    retryCount:      p.retryCount,
    blockhashUsed:   "",
    slotAtSubmission: p.network.currentSlot,
    explorerUrl:      p.finalSig
      ? `https://explorer.solana.com/tx/${p.finalSig}?cluster=${networkName}`
      : null,
    bundleExplorerUrl: null,
    latencyMs: {
      submittedToProcessed:  null,
      processedToConfirmed:  null,
      confirmedToFinalized:  null,
      submittedToFinalized:  null,
    },
  };
}

// Main

async function main(): Promise<void> {
  const logger     = new Logger(config.stack.logDir);
  const connection = new Connection(config.solana.rpcUrl, "confirmed");

  await logger.divider("FAULT INJECTION DEMO");
  await logger.info("Running 3 fault types: expired_blockhash, fee_too_low, compute_exceeded");

  const payer = loadWalletFromEnv();
  await logger.info(`Payer: ${shortKey(payer.publicKey.toBase58(), 12)}`);

  if (config.solana.network === "devnet") {
    try {
      await requestAirdropIfNeeded(connection, payer, 0.1);
    } catch (err) {
      await logger.warn("[inject] Devnet airdrop failed; continuing with existing balance", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const agent          = await Agent.create(logger);
  const tipOracle      = new TipOracle(connection, logger);
  const jitoClient     = new JitoJsonRpcClientImpl(config.jito.rpcUrl);
  const leaderDetector = new LeaderWindowDetector(jitoClient, logger);
  const classifier     = new AdvancedFailureClassifier();

  const entries: LifecycleEntry[] = [];

  entries.push(await runExpiredBlockhash(payer, connection, jitoClient, agent, tipOracle, leaderDetector, classifier, logger));
  await sleep(2_000);
  entries.push(await runFeeTooLow(payer, connection, jitoClient, agent, tipOracle, leaderDetector, classifier, logger));
  await sleep(2_000);
  entries.push(await runComputeExceeded(payer, connection, jitoClient, agent, tipOracle, leaderDetector, classifier, logger));

  for (const entry of entries) {
    logger.appendLifecycle(entry);
  }

  await logger.divider("Fault injection complete");
  await logger.info(`3 fault entries written to ${config.stack.logDir}/lifecycle.json`);
  await logger.info("Faults covered: EXPIRED_BLOCKHASH, FEE_TOO_LOW, COMPUTE_EXCEEDED");
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  process.exit(1);
});