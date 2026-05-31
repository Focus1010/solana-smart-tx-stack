import { Connection } from "@solana/web3.js";
import {
  BundleStage,
  StageRecord,
  FailureReason,
} from "../types";
import { Logger } from "../utils/logger";
import { sleep, shortKey } from "../utils/helpers";

// ─── TrackResult ─────────────────────────────────────────────────────────────

export interface TrackResult {
  finalStage: BundleStage;
  stages:     StageRecord[];
  failure:    FailureReason | null;
}

// ─── LifecycleTracker ─────────────────────────────────────────────────────────
// Polls for transaction confirmation across commitment levels, recording
// precise timestamps and slot numbers at each stage.
// RPC polling + confirmation subscription — not happy-path-only.

export class LifecycleTracker {
  private connection: Connection;
  private logger: Logger;

  // Timeouts per commitment level
  private readonly PROCESSED_TIMEOUT_MS  = 15_000;
  private readonly CONFIRMED_TIMEOUT_MS  = 30_000;
  private readonly FINALIZED_TIMEOUT_MS  = 60_000;
  private readonly POLL_INTERVAL_MS      = 800;

  constructor(connection: Connection, logger: Logger) {
    this.connection = connection;
    this.logger     = logger;
  }

  // ── Main tracking entrypoint ─────────────────────────────────────────────────

  async track(
    signature: string,
    submittedAt: number,
    submissionSlot: number
  ): Promise<TrackResult> {
    const stages: StageRecord[] = [
      {
        stage:             "submitted",
        slot:              submissionSlot,
        timestamp:         submittedAt,
        latencyFromPrevMs: null,
      },
    ];

    await this.logger.info("[tracker] Tracking lifecycle", { sig: shortKey(signature) });

    // ── Stage: processed ────────────────────────────────────────────────────

    const processedRecord = await this.waitForCommitment(
      signature,
      "processed",
      this.PROCESSED_TIMEOUT_MS
    );

    if (!processedRecord) {
      stages.push(this.failedRecord("processed", submittedAt));
      return { finalStage: "failed", stages, failure: "TIMEOUT" };
    }

    processedRecord.latencyFromPrevMs = processedRecord.timestamp - submittedAt;
    stages.push(processedRecord);

    await this.logger.info("[tracker] → processed", {
      slot:    processedRecord.slot,
      latency: `${processedRecord.latencyFromPrevMs}ms`,
    });

    // Check if it was an error (compute / fee)
    const txError = await this.getTransactionError(signature);
    if (txError) {
      const failure = this.classifyTransactionError(txError);
      stages.push(this.failedRecord("failed", processedRecord.timestamp));
      await this.logger.error("[tracker] Transaction failed on-chain", { error: txError, failure });
      return { finalStage: "failed", stages, failure };
    }

    // ── Stage: confirmed ────────────────────────────────────────────────────

    const confirmedRecord = await this.waitForCommitment(
      signature,
      "confirmed",
      this.CONFIRMED_TIMEOUT_MS
    );

    if (!confirmedRecord) {
      // Processed but never confirmed — likely a fork
      stages.push(this.failedRecord("confirmed", processedRecord.timestamp));
      return { finalStage: "processed", stages, failure: "TIMEOUT" };
    }

    confirmedRecord.latencyFromPrevMs = confirmedRecord.timestamp - processedRecord.timestamp;
    stages.push(confirmedRecord);

    await this.logger.ok("[tracker] → confirmed", {
      slot:    confirmedRecord.slot,
      latency: `${confirmedRecord.latencyFromPrevMs}ms`,
      delta_processed_confirmed: `${confirmedRecord.latencyFromPrevMs}ms`,
    });

    // ── Stage: finalized ────────────────────────────────────────────────────

    const finalizedRecord = await this.waitForCommitment(
      signature,
      "finalized",
      this.FINALIZED_TIMEOUT_MS
    );

    if (!finalizedRecord) {
      return { finalStage: "confirmed", stages, failure: null };
    }

    finalizedRecord.latencyFromPrevMs = finalizedRecord.timestamp - confirmedRecord.timestamp;
    stages.push(finalizedRecord);

    await this.logger.ok("[tracker] → finalized", {
      slot:    finalizedRecord.slot,
      latency: `${finalizedRecord.latencyFromPrevMs}ms`,
    });

    return { finalStage: "finalized", stages, failure: null };
  }

  // ── Poll for a specific commitment level ─────────────────────────────────────

  private async waitForCommitment(
    signature: string,
    commitment: "processed" | "confirmed" | "finalized",
    timeoutMs: number
  ): Promise<StageRecord | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const status = await this.connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });

        if (status?.value) {
          const val = status.value;

          const reached =
            commitment === "processed"  ? val.confirmationStatus !== undefined :
            commitment === "confirmed"  ? (val.confirmationStatus === "confirmed" || val.confirmationStatus === "finalized") :
            /* finalized */               val.confirmationStatus === "finalized";

          if (reached) {
            const slot = val.slot ?? null;
            return {
              stage:             commitment as BundleStage,
              slot,
              timestamp:         Date.now(),
              latencyFromPrevMs: null, // filled by caller
            };
          }
        }
      } catch {
        // Transient RPC failure — keep polling
      }

      await sleep(this.POLL_INTERVAL_MS);
    }

    return null; // Timed out
  }

  // ── Fetch transaction error if any ──────────────────────────────────────────

  private async getTransactionError(signature: string): Promise<string | null> {
    try {
      const status = await this.connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      const err = status?.value?.err;
      if (!err) return null;
      return typeof err === "object" ? JSON.stringify(err) : String(err);
    } catch {
      return null;
    }
  }

  // ── Classify on-chain errors ────────────────────────────────────────────────

  private classifyTransactionError(errStr: string): FailureReason {
    const lower = errStr.toLowerCase();
    if (lower.includes("blockhash"))                             return "EXPIRED_BLOCKHASH";
    if (lower.includes("insufficient") || lower.includes("fee")) return "FEE_TOO_LOW";
    if (lower.includes("compute") || lower.includes("budget"))  return "COMPUTE_EXCEEDED";
    return "UNKNOWN";
  }

  // ── Build a failed stage record ──────────────────────────────────────────────

  private failedRecord(stage: BundleStage, prevTimestamp: number): StageRecord {
    const now = Date.now();
    return {
      stage,
      slot:              null,
      timestamp:         now,
      latencyFromPrevMs: now - prevTimestamp,
    };
  }
}
