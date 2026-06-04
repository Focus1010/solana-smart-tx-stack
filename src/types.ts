// Commitment levels
export type CommitmentLevel = "processed" | "confirmed" | "finalized";

// Bundle lifecycle stages
export type BundleStage =
  | "submitted"
  | "processed"
  | "confirmed"
  | "finalized"
  | "failed";

// Failure classifications
export type FailureReason =
  | "EXPIRED_BLOCKHASH"
  | "FEE_TOO_LOW"
  | "COMPUTE_EXCEEDED"
  | "BUNDLE_DROPPED" // Jito leader skipped slot
  | "SIMULATION_FAILED"
  | "TIMEOUT"
  | "UNKNOWN";

// Per-stage timestamp record
export interface StageRecord {
  stage: BundleStage;
  slot: number | null;
  timestamp: number; // unix ms
  latencyFromPrevMs: number | null;
}

// Full lifecycle log entry
export interface LifecycleEntry {
  runId: string;
  bundleId: string | null;
  signature: string | null;
  tipLamports: number;
  tipAccount: string;
  submittedAt: number; // unix ms
  stages: StageRecord[];
  finalStage: BundleStage;
  failure: FailureReason | null;
  agentReasoning: string | null;
  retryCount: number;
  blockhashUsed: string;
  slotAtSubmission: number | null;
}

// Slot stream event
export interface SlotEvent {
  slot: number;
  parent: number;
  status: "processed" | "rooted" | "confirmed";
  timestamp: number;
}

// Tip data from Jito
export interface TipStats {
  p25Lamports: number;
  p50Lamports: number;
  p75Lamports: number;
  p95Lamports: number;
  sampledAt: number;
}

// AI agent inputs / outputs
export interface TipDecisionInput {
  tipStats: TipStats;
  currentSlot: number;
  recentSlotTimes: number[]; // ms between recent slots
  previousTipLamports: number | null;
  previousOutcome: BundleStage | null;
}

export interface TipDecision {
  tipLamports: number;
  reasoning: string;
  confidenceScore: number; // 0-1
}

export interface RetryDecisionInput {
  failure: FailureReason;
  retryCount: number;
  currentSlot: number;
  tipStats: TipStats;
  previousTipLamports: number;
  blockhashExpired: boolean;
}

export interface RetryDecision {
  shouldRetry: boolean;
  newTipLamports: number;
  reasoning: string;
  refreshBlockhash: boolean;
  waitMs: number;
}
