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
  | "BLOCKHASH_NOT_FOUND"
  | "FEE_TOO_LOW"
  | "COMPUTE_EXCEEDED"
  | "BUNDLE_DROPPED"
  | "LEADER_SKIPPED"
  | "SIMULATION_FAILED"
  | "INSTRUCTION_ERROR"
  | "ACCOUNT_IN_USE"
  | "ACCOUNT_NOT_FOUND"
  | "INSUFFICIENT_FUNDS"
  | "RATE_LIMITED"
  | "STREAM_DIVERGENCE"
  | "TIMEOUT"
  | "UNKNOWN";

// Fault injection modes

export type FaultMode =
  | "none"
  | "expired_blockhash"
  | "low_tip"
  | "compute_exceeded";

// Recovery paths

export type RecoveryPath =
  | "retry_refresh_blockhash"
  | "retry_increase_tip"
  | "retry_same_tip"
  | "hold_and_wait"
  | "abort";

// Commitment source identifies how a commitment level was resolved.
// This satisfies the bounty requirement to show stream-first confirmation
// with RPC as a fallback, not as the primary path.

export type CommitmentSource =
  | "yellowstone_slot_stream"
  | "yellowstone_tx_stream"
  | "rpc_signature_status"
  | "rpc_polling_fallback"
  | "bundle_result_subscription";

// Per-stage timestamp record

export interface StageRecord {
  stage:             BundleStage;
  slot:              number | null;
  timestamp:         number;
  latencyFromPrevMs: number | null;
  commitmentSource?: CommitmentSource;
}

// Leader window snapshot

export interface LeaderWindow {
  observedAt:           string;
  currentSlot:          number;
  slotsUntilJitoLeader: number | null;
  nextLeaderIdentity:   string | null;
  isJitoLeaderWindow:   boolean;
}

// Network conditions (captured at a specific point in time)

export interface NetworkConditions {
  capturedAt:               string;
  blockProductionRateMs:    number;
  processedToConfirmedP50:  number | null;
  processedToConfirmedP90:  number | null;
  recentPrioritizationFees: {
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    p99: number;
  };
  slotSkipRate:      number;
  recentFailureRate: number;

  // Derived proxies computed from real observations made by this stack.
  // None are sourced from external dashboards or hardcoded estimates.
  // See network-state-observer.ts for derivation details.
  bundleLandingRate:     number; // 1 - recentFailureRate over last 10 runs
  feeDispersionRatio:    number; // p95/p25 fee ratio (congestion proxy)
  validatorLoadProxy:    number; // derived from slotSkipRate, range 0.0-1.0
}

// Delta between submission-time and confirmation-time conditions

export interface NetworkConditionsDelta {
  blockProductionRateDeltaMs: number;
  prioritizationFeeDelta: {
    p50: number;
    p75: number;
  };
  processedToConfirmedDeltaMs: number | null;
  validatorLoadProxyDelta:     number;
  bundleLandingRateDelta:      number;
}

// Network snapshot fed to agent on every run

export interface NetworkSnapshot {
  currentSlot:               number;
  averageSlotTimeMs:         number;
  recentFailureRate:         number;
  leaderWindow:              LeaderWindow;
  processedToConfirmedMsP50: number | null;
  processedToConfirmedMsP90: number | null;
  conditions:                NetworkConditions;
}

// Failure classification with recovery recommendation

export interface FailureClassification {
  type:         FailureReason;
  confidence:   number;
  rootCause:    string;
  recoveryPath: RecoveryPath;
  waitMs:       number;
  reasoning:    string;
}

// Trigger event context (Marinade or manual)

export interface MarinadeTriggerEvent {
  eventType:      "stake" | "unstake" | "deposit" | "withdraw";
  slot:           number;
  signature:      string;
  amountLamports: number;
  timestamp:      number;
}

export interface TriggerEvent {
  type:       "marinade_staking" | "manual" | "scheduled" | "protocol_trigger";
  metadata:   Record<string, unknown>;
  detectedAt: string;
}

// AI decision evidence written into lifecycle logs.
// Every call to the LLM provider produces a promptHash (sha256 of the raw
// prompt) and an llmLatencyMs measurement. These are stored here alongside
// the verbatim reasoning string. The raw prompt itself is not stored.

export type AgentDecisionType =
  | "tip_intelligence"
  | "failure_reasoning"
  | "autonomous_retry";

export interface AgentDecisionEvidence {
  decisionType:               AgentDecisionType;
  action:                     string;
  reasoning:                  string;
  confidenceScore:            number;
  tipLamports?:               number;
  previousTipLamports?:       number;
  newTipLamports?:            number;
  selectedPercentile?:        number;
  congestionMultiplier?:      number;
  leaderUrgencyMultiplier?:   number;
  landingProbabilityEstimate?: number;
  engine?:                    string;
  model?:                     string;
  promptHash?:                string;
  llmLatencyMs?:              number;
  guardrailAdjusted?:         boolean;
  failure?:                   FailureReason;
  refreshBlockhash?:          boolean;
  waitMs?:                    number;
  retryCount:                 number;
  createdAt:                  string;
}

// Full lifecycle log entry

export interface LifecycleEntry {
  runId:            string;
  bundleId:         string | null;
  signature:        string | null;
  network:          "devnet" | "mainnet-beta";
  dryRun:           boolean;
  tipLamports:      number;
  tipAccount:       string;
  submittedAt:      number;
  submittedAtIso:   string;
  stages:           StageRecord[];
  finalStage:       BundleStage;
  failure:          FailureReason | null;
  failureClass?:    FailureReason | null;
  failureMessage?:  string | null;
  faultInjected:    FaultMode;
  agentReasoning:   string;
  agentConfidence:  number;
  agentAction:      string;
  agentDecisionType?: AgentDecisionType;
  agentDecisionTrace?: AgentDecisionEvidence[];

  // Structured agent decision block (new -- superset of agentDecisionTrace)
  agentDecision?: {
    engine:                    string;
    model:                     string;
    action:                    string;
    selectedTipLamports:       number;
    landingProbabilityEstimate: number;
    reasoning:                 string;
    promptHash:                string;
    llmLatencyMs:              number;
    guardrailAdjusted:         boolean;
  };

  leaderWindow:     LeaderWindow | null;
  networkSnapshot:  NetworkSnapshot | null;

  // Conditions at two specific points for delta analysis
  networkConditionsAtSubmission:    NetworkConditions | null;
  networkConditionsAtConfirmation:  NetworkConditions | null;
  deltaFromSubmissionToConfirmation: NetworkConditionsDelta | null;

  // Optional trigger context (set when Marinade-triggered)
  triggerEvent:          TriggerEvent | null;
  marinadeTriggerEvent:  MarinadeTriggerEvent | null;

  retryCount:      number;
  blockhashUsed:   string;
  slotAtSubmission: number | null;
  explorerUrl:     string | null;
  bundleExplorerUrl?: string | null;
  // Signature of the bundle tip transaction (distinct from the real evidence tx).
  bundleTxSignature?: string | null;
  // Raw bundle-result events (accepted/rejected/dropped) collected from
  // subscribeBundleResults during the submission window. Stored for audit.
  rawBundleResults?: unknown[];
  // Structured raw engine payload for auditing (latest bundle-result event).
  raw?: {
    bundleResult?: unknown;
    bundleResults?: unknown[];
  };
  latencyMs: {
    submittedToProcessed:  number | null;
    processedToConfirmed:  number | null;
    confirmedToFinalized:  number | null;
    submittedToFinalized:  number | null;
  };
}

// Slot stream event

export interface SlotEvent {
  slot:      number;
  parent:    number;
  status:    "processed" | "confirmed" | "finalized" | "dead";
  timestamp: number;
}

// Tip stats

export interface TipStats {
  p25Lamports: number;
  p50Lamports: number;
  p75Lamports: number;
  p95Lamports: number;
  p99Lamports: number;
  sampledAt:   number;
  source:      "jito-tip-floor" | "rpc-prioritization-fees" | "fallback";
}

// AI agent inputs / outputs

export interface TipDecisionInput {
  tipStats:            TipStats;
  networkSnapshot:     NetworkSnapshot;
  previousTipLamports: number | null;
  previousOutcome:     BundleStage | null;
  previousFailure:     FailureReason | null;
  retryCount:          number;
  faultMode:           FaultMode;
}

export interface LlmDecisionMeta {
  engine:            string;
  model:             string;
  promptHash:        string;
  llmLatencyMs:      number;
  guardrailAdjusted: boolean;
}

export interface TipDecision extends LlmDecisionMeta {
  tipLamports:                number;
  reasoning:                  string;
  action:                     string;
  confidenceScore:            number;
  landingProbabilityEstimate: number;
  selectedPercentile:         number;
  congestionMultiplier:       number;
  leaderUrgencyMultiplier:    number;
}

export interface RetryDecisionInput {
  failure:             FailureReason;
  classification:      FailureClassification;
  retryCount:          number;
  networkSnapshot:     NetworkSnapshot;
  tipStats:            TipStats;
  previousTipLamports: number;
  blockhashExpired:    boolean;
  faultMode:           FaultMode;
}

export interface RetryDecision extends LlmDecisionMeta {
  shouldRetry:      boolean;
  action:           RecoveryPath;
  newTipLamports:   number;
  reasoning:        string;
  refreshBlockhash: boolean;
  waitMs:           number;
  confidenceScore:  number;
}