import { Connection }           from "@solana/web3.js";
import { CommitmentTracker, SlotSource } from "./commitment-tracker";
import { BundleStage, StageRecord, FailureReason } from "../types";
import { Logger }               from "../utils/logger";
import { sleep, shortKey }      from "../utils/helpers";

//  TrackResult 

export interface TrackResult {
  finalStage: BundleStage;
  stages:     StageRecord[];
  failure:    FailureReason | null;
  latencyMs: {
    submittedToProcessed:  number | null;
    processedToConfirmed:  number | null;
    confirmedToFinalized:  number | null;
    submittedToFinalized:  number | null;
  };
}

//  LifecycleTracker 
// Stream-first: uses CommitmentTracker to resolve confirmed and finalized
// purely from Yellowstone slot events (no RPC polling for those stages).
//
// For the processed stage we still poll getSignatureStatus() because we need
// the actual transaction slot number -- the stream only tells us the cluster
// has passed that slot, not which slot the tx landed in.

export class LifecycleTracker {
  private connection:        Connection;
  private logger:            Logger;
  private commitmentTracker: CommitmentTracker;

  private readonly PROCESSED_TIMEOUT_MS  = 20_000;
  private readonly CONFIRMED_TIMEOUT_MS  = 45_000;
  private readonly FINALIZED_TIMEOUT_MS  = 90_000;
  private readonly POLL_INTERVAL_MS      = 600;

  constructor(connection: Connection, slotSource: SlotSource, logger: Logger) {
    this.connection        = connection;
    this.logger            = logger;
    this.commitmentTracker = new CommitmentTracker(slotSource);
  }

  async track(
    signature: string,
    submittedAt: number,
    submissionSlot: number
  ): Promise<TrackResult> {
    const stages: StageRecord[] = [{
      stage:             "submitted",
      slot:              submissionSlot || null,
      timestamp:         submittedAt,
      latencyFromPrevMs: null,
    }];

    await this.logger.info("[tracker] Tracking lifecycle", { sig: shortKey(signature) });

    //  Stage: processed (RPC poll to get the landing slot) 

    const processedResult = await this.waitForProcessed(signature, submittedAt);

    if (!processedResult) {
      stages.push(this.failedRecord("failed", submittedAt));
      return {
        finalStage: "failed",
        stages,
        failure: "TIMEOUT",
        latencyMs: { submittedToProcessed: null, processedToConfirmed: null, confirmedToFinalized: null, submittedToFinalized: null },
      };
    }

    const submittedToProcessed = processedResult.timestamp - submittedAt;
    processedResult.latencyFromPrevMs = submittedToProcessed;
    stages.push(processedResult);

    await this.logger.info("[tracker] Processed", {
      slot:    processedResult.slot,
      latency: `${submittedToProcessed}ms`,
    });

    // Check if tx itself errored on-chain
    const txError = await this.getTxError(signature);
    if (txError) {
      const failure = this.classifyTxError(txError);
      stages.push(this.failedRecord("failed", processedResult.timestamp));
      await this.logger.error("[tracker] On-chain error", { txError, failure });
      return {
        finalStage: "failed",
        stages,
        failure,
        latencyMs: { submittedToProcessed, processedToConfirmed: null, confirmedToFinalized: null, submittedToFinalized: null },
      };
    }

    //  Stage: confirmed (stream-based via CommitmentTracker) 

    const landingSlot = processedResult.slot ?? submissionSlot;
    let confirmedAt:  number | null = null;
    let confirmedSlot: number | null = null;

    try {
      const obs = await this.commitmentTracker.waitForCommitment(
        landingSlot,
        "confirmed",
        this.CONFIRMED_TIMEOUT_MS
      );
      confirmedAt   = obs.observedAt;
      confirmedSlot = obs.slot;
    } catch {
      // Stream timed out -- fall back to RPC poll
      const rpcResult = await this.pollForCommitment(signature, "confirmed", this.CONFIRMED_TIMEOUT_MS);
      if (rpcResult) {
        confirmedAt   = rpcResult.timestamp;
        confirmedSlot = rpcResult.slot;
      }
    }

    if (!confirmedAt) {
      return {
        finalStage: "processed",
        stages,
        failure: "TIMEOUT",
        latencyMs: { submittedToProcessed, processedToConfirmed: null, confirmedToFinalized: null, submittedToFinalized: null },
      };
    }

    const processedToConfirmed = confirmedAt - processedResult.timestamp;
    stages.push({
      stage:             "confirmed",
      slot:              confirmedSlot,
      timestamp:         confirmedAt,
      latencyFromPrevMs: processedToConfirmed,
    });

    await this.logger.ok("[tracker] Confirmed", {
      slot:                    confirmedSlot,
      processedToConfirmedMs:  processedToConfirmed,
    });

    //  Stage: finalized (stream-based) 

    let finalizedAt:   number | null = null;
    let finalizedSlot: number | null = null;

    try {
      const obs = await this.commitmentTracker.waitForCommitment(
        landingSlot,
        "finalized",
        this.FINALIZED_TIMEOUT_MS
      );
      finalizedAt   = obs.observedAt;
      finalizedSlot = obs.slot;
    } catch {
      const rpcResult = await this.pollForCommitment(signature, "finalized", this.FINALIZED_TIMEOUT_MS);
      if (rpcResult) {
        finalizedAt   = rpcResult.timestamp;
        finalizedSlot = rpcResult.slot;
      }
    }

    if (!finalizedAt) {
      return {
        finalStage: "confirmed",
        stages,
        failure: null,
        latencyMs: { submittedToProcessed, processedToConfirmed, confirmedToFinalized: null, submittedToFinalized: null },
      };
    }

    const confirmedToFinalized = finalizedAt - confirmedAt;
    const submittedToFinalized = finalizedAt - submittedAt;

    stages.push({
      stage:             "finalized",
      slot:              finalizedSlot,
      timestamp:         finalizedAt,
      latencyFromPrevMs: confirmedToFinalized,
    });

    await this.logger.ok("[tracker] Finalized", {
      slot:                      finalizedSlot,
      confirmedToFinalizedMs:    confirmedToFinalized,
      submittedToFinalizedMs:    submittedToFinalized,
    });

    return {
      finalStage: "finalized",
      stages,
      failure:    null,
      latencyMs: {
        submittedToProcessed,
        processedToConfirmed,
        confirmedToFinalized,
        submittedToFinalized,
      },
    };
  }

  //  Poll for processed stage to get the landing slot number 

  private async waitForProcessed(
    signature: string,
    submittedAt: number
  ): Promise<StageRecord | null> {
    const deadline = submittedAt + this.PROCESSED_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const status = await this.connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });

        if (status?.value?.confirmationStatus) {
          return {
            stage:             "processed",
            slot:              status.value.slot ?? null,
            timestamp:         Date.now(),
            latencyFromPrevMs: null,
          };
        }
      } catch {
        // Transient error
      }
      await sleep(this.POLL_INTERVAL_MS);
    }
    return null;
  }

  //  RPC fallback for confirmed/finalized if stream times out 

  private async pollForCommitment(
    signature: string,
    level: "confirmed" | "finalized",
    timeoutMs: number
  ): Promise<{ slot: number | null; timestamp: number } | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const status = await this.connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });
        const val = status?.value;
        if (!val) { await sleep(this.POLL_INTERVAL_MS); continue; }

        const reached =
          level === "confirmed"
            ? val.confirmationStatus === "confirmed" || val.confirmationStatus === "finalized"
            : val.confirmationStatus === "finalized";

        if (reached) return { slot: val.slot ?? null, timestamp: Date.now() };
      } catch {
        // Keep polling
      }
      await sleep(this.POLL_INTERVAL_MS);
    }
    return null;
  }

  private async getTxError(signature: string): Promise<string | null> {
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

  private classifyTxError(errStr: string): FailureReason {
    const lower = errStr.toLowerCase();
    if (lower.includes("blockhash"))                              return "EXPIRED_BLOCKHASH";
    if (lower.includes("insufficient") || lower.includes("fee")) return "FEE_TOO_LOW";
    if (lower.includes("compute") || lower.includes("budget"))   return "COMPUTE_EXCEEDED";
    return "UNKNOWN";
  }

  private failedRecord(stage: BundleStage, prevTimestamp: number): StageRecord {
    const now = Date.now();
    return { stage, slot: null, timestamp: now, latencyFromPrevMs: now - prevTimestamp };
  }
}