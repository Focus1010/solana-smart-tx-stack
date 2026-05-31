/**
 * fault-inject.ts
 *
 * Demonstrates the autonomous retry loop by injecting a guaranteed
 * EXPIRED_BLOCKHASH failure on the first submission attempt.
 *
 * Run: npm run run:inject
 */

import "dotenv/config";
import { Connection, Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { JitoJsonRpcClient } from "jito-js-rpc";
import { Agent }    from "../agent/agent";
import { Logger }   from "../utils/logger";
import { TipOracle } from "../stream/tip-oracle";
import { LifecycleTracker } from "../lifecycle/lifecycle-tracker";
import { loadWalletFromEnv, requestAirdropIfNeeded } from "../utils/wallet";
import { newRunId, sleep, shortKey } from "../utils/helpers";
import { config }   from "../config";
import {
  LifecycleEntry,
  StageRecord,
  TipDecisionInput,
  RetryDecisionInput,
  FailureReason,
} from "../types";

// ─── Stale blockhash generator ────────────────────────────────────────────────
// Returns a blockhash that is guaranteed to be expired by using a string that
// passes base58 validation but was valid 200+ slots ago.

function makeStaleTxBase64(payer: Keypair): string {
  const tx = new Transaction();

  // Use an obviously stale blockhash string (valid base58, invalid on-chain)
  tx.recentBlockhash = "1111111111111111111111111111111111111111111";
  tx.feePayer        = payer.publicKey;

  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey:   payer.publicKey,
      lamports:   0,
    })
  );

  tx.sign(payer);
  return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");
}

// ─── Main fault injection run ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const logger     = new Logger(config.stack.logDir);
  const connection = new Connection(config.solana.rpcUrl, "confirmed");

  await logger.divider("FAULT INJECTION — Blockhash Expiry Demo");

  const payer = loadWalletFromEnv();
  await logger.info(`Payer: ${shortKey(payer.publicKey.toBase58(), 12)}`);

  if (config.solana.network === "devnet") {
    await requestAirdropIfNeeded(connection, payer, 0.1);
  }

  const agent      = new Agent(logger);
  const tipOracle  = new TipOracle(connection, logger);
  const tracker    = new LifecycleTracker(connection, logger);
  const jitoClient = new JitoJsonRpcClient(config.jito.rpcUrl, "");

  const runId         = newRunId();
  const tipStats      = await tipOracle.fetchTipStats();
  const stages: StageRecord[] = [];

  // ── Attempt 1: Inject stale blockhash ──────────────────────────────────────

  await logger.divider("Attempt 1 — Injecting stale blockhash (forced failure)");

  const staleTxBase64 = makeStaleTxBase64(payer);
  const submittedAt   = Date.now();

  stages.push({
    stage:             "submitted",
    slot:              null,
    timestamp:         submittedAt,
    latencyFromPrevMs: null,
  });

  let bundleId: string | null = null;
  let failure: FailureReason  = "EXPIRED_BLOCKHASH";

  try {
    const resp = await jitoClient.sendBundle([[staleTxBase64]]);
    if (resp?.result) {
      bundleId = resp.result;
      await logger.warn("[inject] Bundle unexpectedly accepted (devnet may not validate blockhash)");
      failure = "UNKNOWN";
    } else {
      await logger.ok("[inject] Bundle correctly rejected — EXPIRED_BLOCKHASH simulated");
    }
  } catch (err) {
    await logger.ok("[inject] Bundle threw as expected (stale blockhash)", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  stages.push({
    stage:             "failed",
    slot:              null,
    timestamp:         Date.now(),
    latencyFromPrevMs: Date.now() - submittedAt,
  });

  // ── Ask agent what to do ───────────────────────────────────────────────────

  await logger.divider("Agent reasoning about EXPIRED_BLOCKHASH failure");

  const retryInput: RetryDecisionInput = {
    failure:             "EXPIRED_BLOCKHASH",
    retryCount:          0,
    currentSlot:         0,
    tipStats,
    previousTipLamports: tipStats.p50Lamports,
    blockhashExpired:    true,
  };

  const retryDecision = await agent.decideRetry(retryInput);

  if (!retryDecision.shouldRetry) {
    await logger.warn("[inject] Agent decided not to retry — exiting");
    return;
  }

  await logger.info(`[inject] Agent says retry after ${retryDecision.waitMs}ms`, {
    newTip:           retryDecision.newTipLamports,
    refreshBlockhash: retryDecision.refreshBlockhash,
    reasoning:        retryDecision.reasoning,
  });

  await sleep(retryDecision.waitMs);

  // ── Attempt 2: Retry with fresh blockhash ─────────────────────────────────

  await logger.divider("Attempt 2 — Fresh blockhash (agent-directed retry)");

  const freshBlockhash = await connection.getLatestBlockhash("confirmed");

  const tipInput: TipDecisionInput = {
    tipStats,
    currentSlot:         0,
    recentSlotTimes:     [],
    previousTipLamports: retryDecision.newTipLamports,
    previousOutcome:     "failed",
  };
  const tipDecision = await agent.decideTip(tipInput);

  const tipAccountKey = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";

  const tx2 = new Transaction({
    recentBlockhash: freshBlockhash.blockhash,
    feePayer:        payer.publicKey,
  });

  tx2.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey:   payer.publicKey,
      lamports:   0,
    })
  );

  const { PublicKey } = await import("@solana/web3.js");
  tx2.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey:   new PublicKey(tipAccountKey),
      lamports:   tipDecision.tipLamports,
    })
  );

  tx2.sign(payer);

  const sig2At = Date.now();
  let sig2: string | null = null;

  stages.push({
    stage:             "submitted",
    slot:              null,
    timestamp:         sig2At,
    latencyFromPrevMs: sig2At - submittedAt,
  });

  try {
    const tx2Base64 = Buffer.from(tx2.serialize()).toString("base64");
    const resp2     = await jitoClient.sendBundle([[tx2Base64]]);

    if (resp2?.result) {
      bundleId = resp2.result;
      await logger.ok("[inject] Retry bundle accepted!", { bundleId });
      sig2 = Buffer.from(tx2.signatures[0].signature!).toString("base64");
    } else {
      await logger.warn("[inject] Retry bundle also rejected", { error: resp2?.error });
    }
  } catch (err) {
    await logger.warn("[inject] Retry bundle threw", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Track retry if it landed ──────────────────────────────────────────────

  let finalStage: LifecycleEntry["finalStage"] = "failed";

  if (sig2) {
    const trackResult = await tracker.track(sig2, sig2At, 0);
    stages.push(...trackResult.stages.slice(1));
    finalStage = trackResult.finalStage;
  }

  // ── Write lifecycle entry ─────────────────────────────────────────────────

  const entry: LifecycleEntry = {
    runId,
    bundleId,
    signature:       sig2,
    tipLamports:     tipDecision.tipLamports,
    tipAccount:      tipAccountKey,
    submittedAt,
    stages,
    finalStage,
    failure:         finalStage === "failed" ? "EXPIRED_BLOCKHASH" : null,
    agentReasoning:  retryDecision.reasoning + " | " + tipDecision.reasoning,
    retryCount:      1,
    blockhashUsed:   freshBlockhash.blockhash,
    slotAtSubmission: null,
  };

  logger.appendLifecycle(entry);
  await logger.divider("Fault injection complete");
  await logger.info("[inject] Entry written to lifecycle log");
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
