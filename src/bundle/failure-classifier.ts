import {
  FailureReason,
  FailureClassification,
  RecoveryPath,
} from "../types";

// ─── FailureContext ───────────────────────────────────────────────────────────

export interface FailureContext {
  retryCount:          number;
  blockhashAge:        number;      // slots since blockhash was fetched
  streamSaysConfirmed: boolean;
  rpcConfirmed:        boolean;
  tipLamports:         number;
  tipP75Lamports:      number;
}

// ─── AdvancedFailureClassifier ────────────────────────────────────────────────
// Classifies errors into typed failure reasons with confidence scores and
// recommended recovery paths. Each failure type has a specific, correct
// recovery strategy that the agent uses as its starting point.

export class AdvancedFailureClassifier {
  classify(
    errorMessage: string,
    context: FailureContext
  ): FailureClassification {
    const msg   = (errorMessage ?? "").toLowerCase();

    // ── EXPIRED_BLOCKHASH ─────────────────────────────────────────────────────
    if (
      msg.includes("blockhash") && (msg.includes("expir") || msg.includes("not found")) ||
      msg.includes("blockhash not found")
    ) {
      return {
        type:         "EXPIRED_BLOCKHASH",
        confidence:   0.97,
        rootCause:    "Transaction blockhash exceeded its 150-slot validity window",
        recoveryPath: "retry_refresh_blockhash",
        waitMs:       800,
        reasoning:
          "The blockhash exceeded its 150-slot validity window before the " +
          "transaction landed. A fresh blockhash at confirmed commitment is " +
          "required. Tip can remain the same since network conditions are unchanged.",
      };
    }

    // ── BLOCKHASH_NOT_FOUND ──────────────────────────────────────────────────
    // Distinct from EXPIRED_BLOCKHASH: the blockhash was never in the ledger
    // (extreme edge case, usually a bug in blockhash generation)
    if (msg.includes("blockhash not found") && !msg.includes("expir")) {
      return {
        type:         "BLOCKHASH_NOT_FOUND",
        confidence:   0.85,
        rootCause:    "Blockhash does not exist in the ledger (never was valid)",
        recoveryPath: "retry_refresh_blockhash",
        waitMs:       1_000,
        reasoning:
          "Blockhash was never present in the ledger, which is distinct from expiry. " +
          "This usually means the blockhash was corrupted or fetched from a stale RPC node. " +
          "Fetching a fresh blockhash from the primary RPC endpoint should resolve it.",
      };
    }

    // ── INSTRUCTION_ERROR ─────────────────────────────────────────────────────
    // A specific instruction within the transaction failed on-chain (not simulation).
    // Different from SIMULATION_FAILED because the tx was accepted and processed.
    if (
      msg.includes("instruction error") ||
      (msg.includes("custom") && msg.includes("error")) ||
      msg.includes("program error")
    ) {
      return {
        type:         "INSTRUCTION_ERROR",
        confidence:   0.82,
        rootCause:    "A specific instruction in the transaction failed on-chain",
        recoveryPath: "abort",
        waitMs:       0,
        reasoning:
          "An on-chain instruction error means the transaction was accepted, processed, " +
          "and landed in a block -- but one instruction returned an error code. " +
          "This is a program logic issue, not a network or fee issue. Do not retry.",
      };
    }

    // ── ACCOUNT_NOT_FOUND ─────────────────────────────────────────────────────
    if (
      msg.includes("account not found") ||
      msg.includes("account does not exist") ||
      (msg.includes("invalid account") && msg.includes("owner"))
    ) {
      return {
        type:         "ACCOUNT_NOT_FOUND",
        confidence:   0.88,
        rootCause:    "A required account does not exist on-chain",
        recoveryPath: "abort",
        waitMs:       0,
        reasoning:
          "A required account was not found on-chain. This is not a transient " +
          "error -- the account either was never created or was closed. " +
          "Retrying will not help. The operator must investigate the account.",
      };
    }

    // ── INSUFFICIENT_FUNDS ────────────────────────────────────────────────────
    if (
      msg.includes("insufficient lamports") ||
      msg.includes("insufficient funds") ||
      msg.includes("insufficient sol")
    ) {
      return {
        type:         "INSUFFICIENT_FUNDS",
        confidence:   0.99,
        rootCause:    "Payer wallet does not have enough SOL for fees and tip",
        recoveryPath: "abort",
        waitMs:       0,
        reasoning:
          "Wallet is underfunded. Increasing the tip will not help -- the " +
          "transaction cannot be signed with insufficient balance. " +
          "Operator must add SOL to the payer wallet.",
      };
    }

    // ── FEE_TOO_LOW ───────────────────────────────────────────────────────────
    if (
      msg.includes("fee too low") ||
      msg.includes("tip too low") ||
      msg.includes("bundle tip") ||
      (msg.includes("fee") && msg.includes("rejected")) ||
      context.tipLamports < context.tipP75Lamports * 0.3
    ) {
      return {
        type:         "FEE_TOO_LOW",
        confidence:   0.91,
        rootCause:    `Tip of ${context.tipLamports} lamports lost the Jito block auction`,
        recoveryPath: "retry_increase_tip",
        waitMs:       1_000,
        reasoning:
          `The bundle tip (${context.tipLamports} lamports) was not competitive ` +
          `in the Jito block auction. The current p75 is ${context.tipP75Lamports} ` +
          `lamports. Retrying with at least p75 increases landing probability ` +
          `significantly. Blockhash is still valid.`,
      };
    }

    // ── COMPUTE_EXCEEDED ─────────────────────────────────────────────────────
    if (
      msg.includes("compute") && (msg.includes("exceed") || msg.includes("budget")) ||
      msg.includes("computational budget exceeded")
    ) {
      return {
        type:         "COMPUTE_EXCEEDED",
        confidence:   0.95,
        rootCause:    "Transaction exceeded its compute unit budget",
        recoveryPath: "abort",
        waitMs:       0,
        reasoning:
          "The transaction hit its compute unit limit. A higher tip will not " +
          "help -- the instruction logic itself consumes too many compute units. " +
          "This requires a code change to the transaction, not a retry.",
      };
    }

    // ── SIMULATION_FAILED ────────────────────────────────────────────────────
    if (
      msg.includes("simulation") ||
      msg.includes("preflight") ||
      msg.includes("invalid instruction")
    ) {
      return {
        type:         "SIMULATION_FAILED",
        confidence:   0.93,
        rootCause:    "Transaction failed pre-flight simulation check",
        recoveryPath: "abort",
        waitMs:       0,
        reasoning:
          "Pre-flight simulation rejected the transaction. The instruction " +
          "logic is invalid. Retrying with a higher tip or fresh blockhash " +
          "will not fix a simulation failure -- the transaction must be rebuilt.",
      };
    }

    // ── RATE_LIMITED ─────────────────────────────────────────────────────────
    if (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("too many requests")
    ) {
      const jitter = Math.floor(Math.random() * 2_000);
      return {
        type:         "RATE_LIMITED",
        confidence:   0.92,
        rootCause:    "Hit Jito block engine submission rate limit",
        recoveryPath: "hold_and_wait",
        waitMs:       3_000 + jitter,
        reasoning:
          `Hit Jito rate limit (HTTP 429). Waiting ${3_000 + jitter}ms with ` +
          `random jitter before retrying. Blockhash is still valid. ` +
          `Tip unchanged -- rate limiting is not about bid price.`,
      };
    }

    // ── ACCOUNT_IN_USE ────────────────────────────────────────────────────────
    if (
      msg.includes("account in use") ||
      msg.includes("account is being") ||
      msg.includes("lock")
    ) {
      return {
        type:         "ACCOUNT_IN_USE",
        confidence:   0.88,
        rootCause:    "A concurrent transaction is modifying the same account",
        recoveryPath: "hold_and_wait",
        waitMs:       2_000,
        reasoning:
          "Another transaction has a write-lock on the account. Retrying " +
          "immediately will fail again. Waiting 2 seconds gives the other " +
          "transaction time to complete. Blockhash and tip are still valid.",
      };
    }

    // ── BUNDLE_DROPPED / LEADER_SKIPPED ──────────────────────────────────────
    if (
      msg.includes("bundle dropped") ||
      msg.includes("leader skip") ||
      msg.includes("not found") ||
      msg.includes("notfound")
    ) {
      return {
        type:         "BUNDLE_DROPPED",
        confidence:   0.78,
        rootCause:    "Jito leader skipped their slot or block engine is unreachable",
        recoveryPath: "retry_refresh_blockhash",
        waitMs:       1_600,  // ~4 slots at 400ms
        reasoning:
          "The Jito block engine returned NOTFOUND, which typically means the " +
          "assigned leader skipped their slot. The bundle was never included in a " +
          "block. Waiting 4 slot-times for the next leader window, then " +
          "resubmitting with a fresh blockhash.",
      };
    }

    // ── STREAM_DIVERGENCE ─────────────────────────────────────────────────────
    if (context.streamSaysConfirmed && !context.rpcConfirmed) {
      return {
        type:         "STREAM_DIVERGENCE",
        confidence:   0.55,
        rootCause:    "Yellowstone stream reports confirmation but RPC has not caught up",
        recoveryPath: "hold_and_wait",
        waitMs:       5_000,
        reasoning:
          "Stream leads RPC by 1-2 slots normally, but this divergence is " +
          "larger than expected. Waiting 5 seconds for the RPC layer to catch up " +
          "before declaring failure. If still unconfirmed after that, retry " +
          "with a fresh blockhash.",
      };
    }

    // ── TIMEOUT ───────────────────────────────────────────────────────────────
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return {
        type:         "TIMEOUT",
        confidence:   0.82,
        rootCause:    "No confirmation observed within the tracking window",
        recoveryPath: "retry_increase_tip",
        waitMs:       1_500,
        reasoning:
          "Transaction was submitted but not confirmed within the timeout window. " +
          "This could be a missed leader window or insufficient tip. " +
          "Retrying with p75 tip and fresh blockhash to ensure next attempt lands.",
      };
    }

    // ── UNKNOWN ───────────────────────────────────────────────────────────────
    return {
      type:         "UNKNOWN",
      confidence:   0.30,
      rootCause:    `Unclassified error: ${errorMessage.slice(0, 120)}`,
      recoveryPath: "hold_and_wait",
      waitMs:       2_000,
      reasoning:
        "Error type could not be classified. Holding briefly to check if " +
        "transient. Will retry once with current tip and fresh blockhash. " +
        "If it fails again, aborting.",
    };
  }

  // ── Convenience: classify a FailureReason directly ────────────────────────
  fromReason(
    reason: FailureReason,
    context: Partial<FailureContext> = {}
  ): FailureClassification {
    const defaults: FailureContext = {
      retryCount:          0,
      blockhashAge:        0,
      streamSaysConfirmed: false,
      rpcConfirmed:        false,
      tipLamports:         0,
      tipP75Lamports:      0,
      ...context,
    };

    const reasonToMsg: Record<FailureReason, string> = {
      EXPIRED_BLOCKHASH:   "blockhash expir",
      BLOCKHASH_NOT_FOUND: "blockhash not found",
      FEE_TOO_LOW:         "fee too low",
      COMPUTE_EXCEEDED:    "compute budget exceeded",
      BUNDLE_DROPPED:      "notfound",
      LEADER_SKIPPED:      "leader skip",
      SIMULATION_FAILED:   "simulation failed",
      INSTRUCTION_ERROR:   "instruction error",
      ACCOUNT_IN_USE:      "account in use",
      ACCOUNT_NOT_FOUND:   "account not found",
      INSUFFICIENT_FUNDS:  "insufficient lamports",
      RATE_LIMITED:        "429",
      STREAM_DIVERGENCE:   "stream divergence rpc mismatch",
      TIMEOUT:             "timeout",
      UNKNOWN:             "unknown unclassified",
    };

    return this.classify(reasonToMsg[reason] ?? "", defaults);
  }
}
