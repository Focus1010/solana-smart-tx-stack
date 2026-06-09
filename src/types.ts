// ─── Commitment levels ────────────────────────────────────────────────────────

export type CommitmentLevel = "processed" | "confirmed" | "finalized";

// ─── Bundle lifecycle stages ──────────────────────────────────────────────────

export type BundleStage =
  | "submitted"
  | "processed"
  | "confirmed"
  | "finalized"
  | "failed";

// ─── Failure classifications ──────────────────────────────────────────────────

export type FailureReason =
  | "EXPIRED_BLOCKHASH"
  | "FEE_TOO_LOW"
  | "COMPUTE_EXCEEDED"
  | "BUNDLE_DROPPED"
  | "SIMULATION_FAILED"
  | "LEADER_SKIPPED"
  | "TIMEOUT"
  | "UNKNOWN";

// ─── Fault injection modes ────────────────────────────────────────────────────

export type FaultMode =
  | "none"
  | "expired_blockhash"
  | "low_tip"
  | "compute_exceeded";

// ─── Per-stage timestamp record ───────────────────────────────────────────────

export interface StageRecord {
  stage: BundleStage;
  slot: number | null;
  timestamp: number;
  latencyFromPrevMs: number | null;
}

// ─── Leader window snapshot ───────────────────────────────────────────────────

export interface LeaderWindow {
  observedAt: string;
  currentSlot: number;
  slotsUntilJitoLeader: number | null;
  nextLeaderIdentity: string | null;
  isJitoLeaderWindow: boolean;
}

// ─── Network snapshot (fed to agent) ─────────────────────────────────────────

export interface NetworkSnapshot {
  currentSlot: number;
  averageSlotTimeMs: number;
  recentFailureRate: number;
  leaderWindow: LeaderWindow;
  processedToConfirmedMsP50: number | null;
}

// ─── Full lifecycle log entry ─────────────────────────────────────────────────

export interface LifecycleEntry {
  runId: string;
  bundleId: string | null;
  signature: string | null;
  tipLamports: number;
  tipAccount: string;
  submittedAt: number;
  submittedAtIso: string;
  stages: StageRecord[];
  finalStage: BundleStage;
  failure: FailureReason | null;
  faultInjected: FaultMode;
  agentReasoning: string;
  agentConfidence: number;
  agentAction: string;
  leaderWindow: LeaderWindow | null;
  networkSnapshot: NetworkSnapshot | null;
  retryCount: number;
  blockhashUsed: string;
  slotAtSubmission: number | null;
  explorerUrl: string | null;
  latencyMs: {
    submittedToProcessed: number | null;
    processedToConfirmed: number | null;
    confirmedToFinalized: number | null;
    submittedToFinalized: number | null;
  };
}

// ─── Slot stream event ────────────────────────────────────────────────────────

export interface SlotEvent {
  slot: number;
  parent: number;
  status: "processed" | "confirmed" | "finalized" | "rooted";
  timestamp: number;
}

// ─── Tip data ─────────────────────────────────────────────────────────────────

export interface TipStats {
  p25Lamports: number;
  p50Lamports: number;
  p75Lamports: number;
  p95Lamports: number;
  p99Lamports: number;
  sampledAt: number;
  source: "jito-tip-floor" | "rpc-prioritization-fees" | "fallback";
}

// ─── AI agent inputs / outputs ────────────────────────────────────────────────

export interface TipDecisionInput {
  tipStats: TipStats;
  networkSnapshot: NetworkSnapshot;
  previousTipLamports: number | null;
  previousOutcome: BundleStage | null;
  previousFailure: FailureReason | null;
  retryCount: number;
  faultMode: FaultMode;
}

export interface TipDecision {
  tipLamports: number;
  reasoning: string;
  action: string;
  confidenceScore: number;
  landingProbabilityEstimate: number;
  selectedPercentile: number;
  congestionMultiplier: number;
  leaderUrgencyMultiplier: number;
}

export interface RetryDecisionInput {
  failure: FailureReason;
  retryCount: number;
  networkSnapshot: NetworkSnapshot;
  tipStats: TipStats;
  previousTipLamports: number;
  blockhashExpired: boolean;
  faultMode: FaultMode;
}

export interface RetryDecision {
  shouldRetry: boolean;
  action: string;
  newTipLamports: number;
  reasoning: string;
  refreshBlockhash: boolean;
  waitMs: number;
  confidenceScore: number;
}
