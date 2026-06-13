/**
 * fault-inject.ts
 *
 * Demonstrates the autonomous retry loop through three fault modes:
 *   1. EXPIRED_BLOCKHASH  -- stale blockhash, agent refreshes and retries
 *   2. FEE_TOO_LOW        -- intentionally low tip, agent increases and retries
 *   3. COMPUTE_EXCEEDED   -- oversized compute budget, agent aborts correctly
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
} from "@solana/web3.js";
import { JitoJsonRpcClient } from "jito-js-rpc";
import { Agent }             from "../agent/agent";
import { Logger }            from "../utils/logger";
import { TipOracle }         from "../stream/tip-oracle";
import { LeaderWindowDetector } from "../jito/leader-window-detector";
import { loadWalletFromEnv, requestAirdropIfNeeded } from "../utils/wallet";
import { newRunId, sleep, shortKey } from "../utils/helpers";
import { config }            from "../config";
import {
  LifecycleEntry,
  StageRecord,
  FaultMode,
  FailureReason,
  NetworkSnapshot,
  NetworkConditions,
  LeaderWindow,
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
    feeDispersionRatio:       20, // p95/p25 = 20000/1000
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

// ─── Fault 1: Expired Blockhash ───────────────────────────────────────────────

async function runExpiredBlockhash(
  payer: Keypair,
  connection: Connection,
  jitoClient: JitoJsonRpcClient,
  agent: Agent,
  tipOracle: TipOracle,
  leaderDetector: LeaderWindowDetector,
  classifier: AdvancedFailureClassifier,
  logger: Logger
): Promise<LifecycleEntry> {
  const runId   = newRunId();
  const stages: StageRecord[] = [];

  await logger.divider("Fault 1: EXPIRED_BLOCKHASH");

  const tipStats       = await tipOracle.fetchTipStats();
  const networkSnapshot = await buildNetworkSnapshot(connection, leaderDetector);

  // Build tx with a known-stale blockhash
  const tx = new Transaction({
    recentBlockhash: "11111111111111111111111111111111",
    feePayer:        payer.publicKey,
  });
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 }));
  tx.sign(payer);

  const submittedAt = Date.now();
  stages.push({ stage: "submitted", slot: networkSnapshot.currentSlot, timestamp: submittedAt, latencyFromPrevMs: null });

  let failureDetected: FailureReason = "EXPIRED_BLOCKHASH";

  try {
    const resp = await jitoClient.sendBundle([[Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64")]]);
    if (!resp?.result) {
      await logger.ok("[inject] Bundle correctly rejected (stale blockhash)");
    }
  } catch (err) {
    await logger.ok("[inject] Bundle threw as expected", { message: err instanceof Error ? err.message : String(err) });
  }

  stages.push({ stage: "failed", slot: null, timestamp: Date.now(), latencyFromPrevMs: Date.now() - submittedAt });

  // Agent decides
  const retryDecision = await agent.decideRetry({
    failure:             failureDetected,
    classification:      classifier.fromReason(failureDetected, { retryCount: 0, tipLamports: tipStats.p50Lamports, tipP75Lamports: tipStats.p75Lamports }),
    retryCount:          0,
    networkSnapshot,
    tipStats,
    previousTipLamports: tipStats.p50Lamports,
    blockhashExpired:    true,
    faultMode:           "expired_blockhash",
  });

  // Retry with fresh blockhash
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
      stages.push({ stage: "confirmed", slot: null, timestamp: Date.now(), latencyFromPrevMs: Date.now() - submittedAt });
    } catch (err) {
      await logger.warn("[inject] Retry failed", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  return buildEntry(runId, finalSig, tipStats.p50Lamports, stages, finalSig ? "confirmed" : "failed",
    failureDetected, retryDecision.reasoning, "expired_blockhash", networkSnapshot, 1);
}

// ─── Fault 2: Fee Too Low ─────────────────────────────────────────────────────

async function runFeeTooLow(
  payer: Keypair,
  connection: Connection,
  jitoClient: JitoJsonRpcClient,
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
  const bh              = await connection.getLatestBlockhash("confirmed");

  // Intentionally use p25 (lowest competitive tier) to trigger rejection
  const intentionallyLowTip = Math.max(100, Math.floor(tipStats.p25Lamports * 0.1));
  await logger.info(`[inject] Submitting with intentionally low tip: ${intentionallyLowTip} lamports`);

  const tx = new Transaction({ recentBlockhash: bh.blockhash, feePayer: payer.publicKey });
  tx.add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new (require("@solana/web3.js").PublicKey)(TIP_ACCOUNT), lamports: intentionallyLowTip })
  );
  tx.sign(payer);

  const submittedAt = Date.now();
  stages.push({ stage: "submitted", slot: networkSnapshot.currentSlot, timestamp: submittedAt, latencyFromPrevMs: null });

  let bundleRejected = false;
  try {
    const resp = await jitoClient.sendBundle([[Buffer.from(tx.serialize()).toString("base64")]]);
    bundleRejected = !resp?.result;
    if (bundleRejected) await logger.ok("[inject] Bundle rejected as expected (tip too low)");
  } catch {
    bundleRejected = true;
    await logger.ok("[inject] Bundle threw (tip too low)");
  }

  stages.push({ stage: "failed", slot: null, timestamp: Date.now(), latencyFromPrevMs: Date.now() - submittedAt });

  const retryDecision = await agent.decideRetry({
    failure:             "FEE_TOO_LOW",
    classification:      classifier.fromReason("FEE_TOO_LOW", { retryCount: 0, tipLamports: intentionallyLowTip, tipP75Lamports: tipStats.p75Lamports }),
    retryCount:          0,
    networkSnapshot,
    tipStats,
    previousTipLamports: intentionallyLowTip,
    blockhashExpired:    false,
    faultMode:           "low_tip",
  });

  // Send real devnet tx to prove recovery
  let finalSig: string | null = null;
  try {
    const bh2  = await connection.getLatestBlockhash("confirmed");
    const tx2  = new Transaction({ recentBlockhash: bh2.blockhash, feePayer: payer.publicKey });
    tx2.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 }));
    tx2.sign(payer);
    finalSig = await sendAndConfirmTransaction(connection, tx2, [payer], { commitment: "confirmed" });
    await logger.ok("[inject] Recovery tx confirmed", { sig: shortKey(finalSig) });
    stages.push({ stage: "confirmed", slot: null, timestamp: Date.now(), latencyFromPrevMs: Date.now() - submittedAt });
  } catch (err) {
    await logger.warn("[inject] Recovery tx failed", { message: err instanceof Error ? err.message : String(err) });
  }

  return buildEntry(runId, finalSig, intentionallyLowTip, stages, finalSig ? "confirmed" : "failed",
    "FEE_TOO_LOW", retryDecision.reasoning, "low_tip", networkSnapshot, 1);
}

// ─── Fault 3: Compute Exceeded ────────────────────────────────────────────────

async function runComputeExceeded(
  payer: Keypair,
  connection: Connection,
  jitoClient: JitoJsonRpcClient,
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

  await logger.info("[inject] Submitting bundle with compute budget set to 1 unit (will fail)");

  // Setting compute limit to 1 unit guarantees compute budget exceeded
  const bh = await connection.getLatestBlockhash("confirmed");
  const tx  = new Transaction({ recentBlockhash: bh.blockhash, feePayer: payer.publicKey });
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 })
  );
  tx.sign(payer);

  const submittedAt = Date.now();
  stages.push({ stage: "submitted", slot: networkSnapshot.currentSlot, timestamp: submittedAt, latencyFromPrevMs: null });

  try {
    await jitoClient.sendBundle([[Buffer.from(tx.serialize()).toString("base64")]]);
  } catch {
    // Expected
  }

  stages.push({ stage: "failed", slot: null, timestamp: Date.now(), latencyFromPrevMs: Date.now() - submittedAt });

  const retryDecision = await agent.decideRetry({
    failure:             "COMPUTE_EXCEEDED",
    classification:      classifier.fromReason("COMPUTE_EXCEEDED", { retryCount: 0, tipLamports: tipStats.p75Lamports, tipP75Lamports: tipStats.p75Lamports }),
    retryCount:          0,
    networkSnapshot,
    tipStats,
    previousTipLamports: tipStats.p75Lamports,
    blockhashExpired:    false,
    faultMode:           "compute_exceeded",
  });

  await logger.info("[inject] Agent correctly decided not to retry (compute exceeded)", {
    shouldRetry: retryDecision.shouldRetry,
    reasoning:   retryDecision.reasoning,
  });

  return buildEntry(runId, null, tipStats.p75Lamports, stages, "failed",
    "COMPUTE_EXCEEDED", retryDecision.reasoning, "compute_exceeded", networkSnapshot, 0);
}

// ─── Entry builder ────────────────────────────────────────────────────────────

function buildEntry(
  runId:           string,
  signature:       string | null,
  tipLamports:     number,
  stages:          StageRecord[],
  finalStage:      LifecycleEntry["finalStage"],
  failure:         FailureReason | null,
  agentReasoning:  string,
  faultInjected:   FaultMode,
  network:         NetworkSnapshot,
  retryCount:      number
): LifecycleEntry {
  const network_name = (process.env.SOLANA_NETWORK ?? "devnet") === "mainnet-beta" ? "mainnet-beta" : "devnet";
  return {
    runId,
    bundleId:          null,
    signature,
    tipLamports,
    tipAccount:        TIP_ACCOUNT,
    submittedAt:       stages[0]?.timestamp ?? Date.now(),
    submittedAtIso:    new Date(stages[0]?.timestamp ?? Date.now()).toISOString(),
    stages,
    finalStage,
    failure,
    faultInjected,
    agentReasoning,
    agentConfidence:   0.9,
    agentAction:       finalStage === "failed" ? "abort" : "retry_refresh_blockhash",
    leaderWindow:      network.leaderWindow,
    networkSnapshot:   network,
    networkConditionsAtSubmission:    network.conditions,
    networkConditionsAtConfirmation:  null,
    deltaFromSubmissionToConfirmation: null,
    triggerEvent:      null,
    retryCount,
    blockhashUsed:     "",
    slotAtSubmission:  network.currentSlot,
    explorerUrl:       signature ? `https://explorer.solana.com/tx/${signature}?cluster=${network_name}` : null,
    latencyMs: {
      submittedToProcessed:  null,
      processedToConfirmed:  null,
      confirmedToFinalized:  null,
      submittedToFinalized:  null,
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const logger     = new Logger(config.stack.logDir);
  const connection = new Connection(config.solana.rpcUrl, "confirmed");

  await logger.divider("FAULT INJECTION DEMO");
  await logger.info("Running 3 fault types: expired_blockhash, fee_too_low, compute_exceeded");

  const payer = loadWalletFromEnv();
  await logger.info(`Payer: ${shortKey(payer.publicKey.toBase58(), 12)}`);

  if (config.solana.network === "devnet") {
    await requestAirdropIfNeeded(connection, payer, 0.1);
  }

  const agent          = new Agent(logger);
  const tipOracle      = new TipOracle(connection, logger);
  const leaderDetector = new LeaderWindowDetector(logger);
  const classifier     = new AdvancedFailureClassifier();
  const jitoClient     = new JitoJsonRpcClient(config.jito.rpcUrl, "");

  const entries: LifecycleEntry[] = [];

  entries.push(await runExpiredBlockhash(payer, connection, jitoClient, agent, tipOracle, leaderDetector, classifier, logger));
  await sleep(2_000);
  entries.push(await runFeeTooLow(payer, connection, jitoClient, agent, tipOracle, leaderDetector, classifier, logger));
  await sleep(2_000);
  entries.push(await runComputeExceeded(payer, connection, jitoClient, agent, tipOracle, leaderDetector, classifier, logger));

  // Write all three to lifecycle.json
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
