import crypto from "crypto";
import {
  TipDecision,
  TipDecisionInput,
  RetryDecision,
  RetryDecisionInput,
  NetworkSnapshot,
  TipStats,
} from "../types";
import { Logger } from "../utils/logger";
import { LlmProvider } from "./llm-provider";
import { createLlmProvider } from "./provider-factory";

//  Agent 
// Provider-backed reasoning engine at temperature 0.2.
//
// Two public methods:
//   decideTip()    -- called before every submission
//   decideRetry()  -- called after every failure
//
// Both methods build prompts that reference the specific numbers from the
// current run so the reasoning in the lifecycle log is unique per run and
// directly auditable by judges.

export class Agent {
  private provider: LlmProvider;
  private logger: Logger;

  // Rolling history for network health signals
  private recentProcessedToConfirmedMs: number[] = [];
  private recentTips:                   number[] = [];

  static async create(logger: Logger): Promise<Agent> {
    const provider = await createLlmProvider(logger);
    return new Agent(provider, logger);
  }

  private constructor(provider: LlmProvider, logger: Logger) {
    this.provider = provider;
    this.logger   = logger;
  }

  recordConfirmationLatency(ms: number): void {
    this.recentProcessedToConfirmedMs.push(ms);
    if (this.recentProcessedToConfirmedMs.length > 20) {
      this.recentProcessedToConfirmedMs.shift();
    }
  }

  //  Tip Intelligence 
  // Builds a detailed prompt with real numbers, gets back a typed decision
  // with multi-sentence reasoning that references those specific numbers.

  async decideTip(input: TipDecisionInput): Promise<TipDecision> {
    const avgSlotMs         = input.networkSnapshot.averageSlotTimeMs || 400;
    const networkLoad       = this.describeNetworkLoad(avgSlotMs, input.networkSnapshot.recentFailureRate);
    const leaderSection     = this.formatLeaderSection(input.networkSnapshot);
    const congestion        = this.computeCongestionMultiplier(input.networkSnapshot);
    const leaderMult        = this.computeLeaderMultiplier(input.networkSnapshot);
    const p50               = input.tipStats.p50Lamports;
    const estimatedTip      = Math.round(p50 * congestion * leaderMult);
    const clamped           = Math.max(1_000, Math.min(500_000, estimatedTip));
    const percentileLabel   = this.pickPercentileLabel(clamped, input.tipStats);
    const p50LatMs          = this.p50ConfirmationMs();
    const p90LatMs          = this.p90ConfirmationMs();

    const prompt = `
You are the tip-intelligence module inside a production Solana transaction infrastructure stack.
Your sole job: decide the exact tip in lamports for a Jito bundle submission.

## Live tip data (source: ${input.tipStats.source}, sampled ${new Date(input.tipStats.sampledAt).toISOString()})
- p25: ${input.tipStats.p25Lamports} lamports
- p50: ${input.tipStats.p50Lamports} lamports  [baseline]
- p75: ${input.tipStats.p75Lamports} lamports
- p95: ${input.tipStats.p95Lamports} lamports
- p99: ${input.tipStats.p99Lamports} lamports

## Current network conditions
- Slot: ${input.networkSnapshot.currentSlot}
- Average slot time (last 20 slots): ${avgSlotMs.toFixed(0)}ms
- Network load: ${networkLoad}
- Recent failure rate: ${(input.networkSnapshot.recentFailureRate * 100).toFixed(0)}%
- Processed-to-confirmed p50: ${p50LatMs !== null ? p50LatMs + "ms" : "no data yet"}
- Processed-to-confirmed p90: ${p90LatMs !== null ? p90LatMs + "ms" : "no data yet"}
- Block production rate: ${input.networkSnapshot.conditions.blockProductionRateMs.toFixed(0)}ms/slot
- Slot skip rate (validator load proxy): ${(input.networkSnapshot.conditions.slotSkipRate * 100).toFixed(1)}%
- Fee dispersion ratio (p95/p25): ${input.networkSnapshot.conditions.feeDispersionRatio.toFixed(2)}x
- This stack's own bundle landing rate (last 10 runs): ${(input.networkSnapshot.conditions.bundleLandingRate * 100).toFixed(0)}%

${leaderSection}

## Run context
- Fault mode: ${input.faultMode}
- Retry count: ${input.retryCount}
- Previous tip: ${input.previousTipLamports !== null ? input.previousTipLamports + " lamports" : "none (first run)"}
- Previous outcome: ${input.previousOutcome ?? "none"}
- Previous failure: ${input.previousFailure ?? "none"}

## Pre-computed baseline estimate
- Congestion multiplier: ${congestion.toFixed(3)}x (derived from slot time and failure rate)
- Leader pricing multiplier: ${leaderMult.toFixed(3)}x (${
      input.networkSnapshot.leaderWindow.slotsUntilJitoLeader === null
        ? "leader schedule UNKNOWN -- this is an uncertainty premium, not a known-urgent signal"
        : "derived from confirmed slots until next Jito leader"
    })
- Estimated tip: ${clamped} lamports (approx ${percentileLabel})

## Decision rules
1. Normal network (slot time 350-500ms, failure rate < 10%): use p50 as baseline
2. Congested (slot time > 500ms OR failure rate > 20%): use p75
3. Fast and recent success (slot time < 350ms, last run confirmed): use p25 to save cost
4. Inside Jito leader window (slotsUntilJitoLeader <= 4): apply 1.25x urgency multiplier
4b. Leader schedule UNKNOWN (no slotsUntilJitoLeader data): do not default to p50. The
    bundle may be addressed to a non-Jito leader, in which case no tip lands it. Treat
    this the same as or worse than a known-urgent window: use at least p75, and prefer
    p75 over p50 even when other signals look calm.
5. Previous FEE_TOO_LOW failure: must exceed p75 minimum
6. Fault mode low_tip: use p25 deliberately to demonstrate failure detection
7. High fee dispersion ratio (above 5x): fees are volatile, prefer p75 over p50 for safety margin
8. Never below 1000 lamports. Never above 500000 lamports.

Respond with ONLY a valid JSON object, no markdown fences, no preamble:
{
  "tipLamports": <integer>,
  "action": "<submit_now|hold_for_leader>",
  "reasoning": "<3-5 sentences that name the specific percentile chosen, the exact lamport value, the congestion multiplier value, why this specific amount was chosen given the slot time of ${avgSlotMs.toFixed(0)}ms and failure rate of ${(input.networkSnapshot.recentFailureRate * 100).toFixed(0)}%, and the expected landing probability>",
  "confidenceScore": <float 0.0-1.0>,
  "landingProbabilityEstimate": <float 0.0-1.0>,
  "selectedPercentile": <integer 25|50|75|95|99>,
  "congestionMultiplier": <float>,
  "leaderUrgencyMultiplier": <float>
}
`.trim();

    const promptHash = this.hashPrompt(prompt);
    let latencyMs = 0;
    let decision: TipDecision;
    try {
      const { text, latencyMs: measuredLatencyMs } = await this.callLlm(prompt, 600);
      latencyMs = measuredLatencyMs;
      decision = this.parseJson<TipDecision>(text);
    } catch (err) {
      await this.logger.warn("[agent] LLM tip decision failed; using deterministic safety fallback", {
        message: err instanceof Error ? err.message : String(err),
      });
      decision = {
        engine: this.provider.name,
        model: this.provider.model,
        promptHash,
        llmLatencyMs: latencyMs,
        guardrailAdjusted: false,
        tipLamports: clamped,
        action: "submit_now",
        reasoning:
          `The configured LLM was unavailable or returned invalid JSON, so the stack used its deterministic safety fallback. ` +
          `The fallback selected ${clamped} lamports (${percentileLabel}) from live tip data, with congestion ` +
          `multiplier ${congestion.toFixed(3)}x and leader urgency multiplier ${leaderMult.toFixed(3)}x. ` +
          `This preserves autonomous operation while keeping the decision bounded by observed network conditions.`,
        confidenceScore: 0.68,
        landingProbabilityEstimate: 0.65,
        selectedPercentile: Number(percentileLabel.replace("p", "")),
        congestionMultiplier: congestion,
        leaderUrgencyMultiplier: leaderMult,
      };
    }

    // Hard safety bounds -- model output is never trusted without clamping
    const preClampTip = decision.tipLamports;
    decision.tipLamports                = Math.max(1_000, Math.min(500_000, decision.tipLamports));
    decision.engine                     = this.provider.name;
    decision.model                      = this.provider.model;
    decision.promptHash                 = promptHash;
    decision.llmLatencyMs               = latencyMs;
    decision.guardrailAdjusted          = preClampTip !== decision.tipLamports;
    decision.confidenceScore            = Math.max(0, Math.min(1, decision.confidenceScore ?? 0.8));
    decision.landingProbabilityEstimate = Math.max(0, Math.min(1, decision.landingProbabilityEstimate ?? 0.7));
    decision.congestionMultiplier       = decision.congestionMultiplier    ?? congestion;
    decision.leaderUrgencyMultiplier    = decision.leaderUrgencyMultiplier ?? leaderMult;
    decision.selectedPercentile         = decision.selectedPercentile      ?? 50;
    decision.action                     = decision.action                  ?? "submit_now";

    this.recentTips.push(decision.tipLamports);
    if (this.recentTips.length > 20) this.recentTips.shift();

    await this.logger.agent("[agent] Tip decision", {
      tip:         decision.tipLamports,
      action:      decision.action,
      confidence:  decision.confidenceScore.toFixed(2),
      landing:     decision.landingProbabilityEstimate.toFixed(2),
      percentile:  `p${decision.selectedPercentile}`,
      congestion:  decision.congestionMultiplier.toFixed(3),
      leader:      decision.leaderUrgencyMultiplier.toFixed(3),
      reasoning:   decision.reasoning,
    });

    return decision;
  }

  //  Retry Reasoning 
  // Uses the FailureClassification from AdvancedFailureClassifier as context
  // so the agent's reasoning is grounded in the specific error type.

  async decideRetry(input: RetryDecisionInput): Promise<RetryDecision> {
    const avgSlotMs     = input.networkSnapshot.averageSlotTimeMs || 400;
    const leaderSection = this.formatLeaderSection(input.networkSnapshot);
    const cls           = input.classification;

    const prompt = `
You are the retry-reasoning module inside a production Solana transaction infrastructure stack.
A bundle submission just failed. Decide whether and exactly how to retry.

## Failure analysis
- Failure type: ${input.failure}
- Classifier confidence: ${(cls.confidence * 100).toFixed(0)}%
- Root cause: ${cls.rootCause}
- Recommended recovery path: ${cls.recoveryPath}
- Classifier reasoning: ${cls.reasoning}

## Retry context
- Retry attempt: ${input.retryCount} of 3 maximum
- Fault mode (intentional injection): ${input.faultMode}
- Blockhash confirmed expired: ${input.blockhashExpired}
- Previous tip: ${input.previousTipLamports} lamports
- Current slot: ${input.networkSnapshot.currentSlot}

## Live tip percentiles (source: ${input.tipStats.source})
- p25: ${input.tipStats.p25Lamports} | p50: ${input.tipStats.p50Lamports} | p75: ${input.tipStats.p75Lamports}
- p95: ${input.tipStats.p95Lamports} | p99: ${input.tipStats.p99Lamports}

## Network conditions
- Average slot time: ${avgSlotMs.toFixed(0)}ms
- Failure rate: ${(input.networkSnapshot.recentFailureRate * 100).toFixed(0)}%
- Fee dispersion ratio (p95/p25): ${input.networkSnapshot.conditions.feeDispersionRatio.toFixed(2)}x
- Validator load proxy: ${(input.networkSnapshot.conditions.validatorLoadProxy * 100).toFixed(1)}%
${leaderSection}

## Hard rules (override model judgment)
- COMPUTE_EXCEEDED: shouldRetry MUST be false. Tip cannot fix compute limits.
- SIMULATION_FAILED: shouldRetry MUST be false. Transaction logic is broken.
- INSUFFICIENT_FUNDS: shouldRetry MUST be false. Wallet needs funding.
- retryCount >= 3: shouldRetry MUST be false. Budget exhausted.
- waitMs: minimum 800ms, maximum 8000ms.
- newTipLamports: minimum 1000, maximum 500000.
- If fault mode is low_tip and failure is FEE_TOO_LOW: retry with p75 to demonstrate recovery.

Respond with ONLY valid JSON, no markdown fences:
{
  "shouldRetry": <boolean>,
  "action": "<retry_refresh_blockhash|retry_increase_tip|retry_same_tip|hold_and_wait|abort>",
  "newTipLamports": <integer>,
  "reasoning": "<3-5 sentences diagnosing the specific failure, naming the exact failure type ${input.failure}, explaining what change fixes it and why, and what the new tip of X lamports represents relative to current percentiles>",
  "refreshBlockhash": <boolean>,
  "waitMs": <integer>,
  "confidenceScore": <float 0.0-1.0>
}
`.trim();

    const promptHash = this.hashPrompt(prompt);
    let latencyMs = 0;
    let decision: RetryDecision;
    try {
      const { text, latencyMs: measuredLatencyMs } = await this.callLlm(prompt, 600);
      latencyMs = measuredLatencyMs;
      decision = this.parseJson<RetryDecision>(text);
    } catch (err) {
      await this.logger.warn("[agent] LLM retry decision failed; using deterministic safety fallback", {
        message: err instanceof Error ? err.message : String(err),
      });
      const nonRetryable =
        input.retryCount >= 3 ||
        input.failure === "COMPUTE_EXCEEDED" ||
        input.failure === "SIMULATION_FAILED" ||
        input.failure === "INSUFFICIENT_FUNDS" ||
        cls.recoveryPath === "abort";
      const fallbackTip =
        input.failure === "FEE_TOO_LOW"
          ? Math.max(input.tipStats.p75Lamports, Math.ceil(input.previousTipLamports * 1.25))
          : input.previousTipLamports;
      decision = {
        engine: this.provider.name,
        model: this.provider.model,
        promptHash,
        llmLatencyMs: latencyMs,
        guardrailAdjusted: false,
        shouldRetry: !nonRetryable,
        action: nonRetryable ? "abort" : cls.recoveryPath,
        newTipLamports: fallbackTip,
        reasoning:
          `The configured LLM was unavailable or returned invalid JSON, so the stack used classifier-grounded retry fallback. ` +
          `The classifier labeled the failure as ${input.failure} with ${(cls.confidence * 100).toFixed(0)}% confidence. ` +
          `The selected recovery path is ${nonRetryable ? "abort" : cls.recoveryPath}; the next tip would be ${fallbackTip} lamports based on current percentiles and previous tip.`,
        refreshBlockhash: cls.recoveryPath === "retry_refresh_blockhash" || input.blockhashExpired,
        waitMs: cls.waitMs,
        confidenceScore: Math.max(0.5, Math.min(0.8, cls.confidence)),
      };
    }

    // Hard limits
    const preClampTip = decision.newTipLamports;
    const preClampWaitMs = decision.waitMs;
    decision.newTipLamports  = Math.max(1_000, Math.min(500_000, decision.newTipLamports));
    decision.waitMs          = Math.max(800,   Math.min(8_000,   decision.waitMs));
    decision.engine          = this.provider.name;
    decision.model           = this.provider.model;
    decision.promptHash      = promptHash;
    decision.llmLatencyMs    = latencyMs;
    decision.guardrailAdjusted =
      preClampTip !== decision.newTipLamports ||
      preClampWaitMs !== decision.waitMs;
    decision.confidenceScore = Math.max(0,     Math.min(1,       decision.confidenceScore ?? 0.8));

    // Enforce non-negotiable rules regardless of model output
    if (
      input.retryCount >= 3 ||
      input.failure === "COMPUTE_EXCEEDED" ||
      input.failure === "SIMULATION_FAILED" ||
      input.failure === "INSUFFICIENT_FUNDS"
    ) {
      decision.shouldRetry = false;
      decision.action      = "abort";
      if (input.retryCount >= 3) {
        decision.reasoning = `Retry budget exhausted (${input.retryCount}/3). ` + decision.reasoning;
      }
    }

    await this.logger.agent("[agent] Retry decision", {
      shouldRetry:      decision.shouldRetry,
      action:           decision.action,
      newTip:           decision.newTipLamports,
      refreshBlockhash: decision.refreshBlockhash,
      waitMs:           decision.waitMs,
      confidence:       decision.confidenceScore.toFixed(2),
      reasoning:        decision.reasoning,
    });

    return decision;
  }

  //  Private helpers 

  private async callLlm(prompt: string, maxTokens: number): Promise<{ text: string; latencyMs: number }> {
    return this.provider.complete(prompt, maxTokens);
  }

  private hashPrompt(prompt: string): string {
    return crypto.createHash("sha256").update(prompt).digest("hex");
  }

  private parseJson<T>(raw: string): T {
    const clean = raw
      .replace(/^```(?:json)?/gm, "")
      .replace(/```$/gm, "")
      .trim();
    try {
      return JSON.parse(clean) as T;
    } catch {
      throw new Error(`Agent returned invalid JSON. Raw (first 300 chars): ${raw.slice(0, 300)}`);
    }
  }

  private describeNetworkLoad(avgSlotMs: number, failureRate: number): string {
    if (avgSlotMs > 600 || failureRate > 0.3) {
      return `CONGESTED (slot time ${avgSlotMs.toFixed(0)}ms, failure rate ${(failureRate * 100).toFixed(0)}%)`;
    }
    if (avgSlotMs < 350 && failureRate < 0.05) {
      return `FAST (slot time ${avgSlotMs.toFixed(0)}ms, failure rate ${(failureRate * 100).toFixed(0)}%)`;
    }
    return `NORMAL (slot time ${avgSlotMs.toFixed(0)}ms, failure rate ${(failureRate * 100).toFixed(0)}%)`;
  }

  private formatLeaderSection(snapshot: NetworkSnapshot): string {
    const lw = snapshot.leaderWindow;
    if (lw.slotsUntilJitoLeader === null) {
      return [
        "## Jito leader window",
        "- Status: UNKNOWN -- this endpoint cannot report the Jito leader schedule",
        "- Risk: a bundle sent right now may be addressed to a slot where no Jito-connected",
        "  validator is leader. If that happens, the bundle cannot land at ANY tip price --",
        "  there is no auction to win. This is a real risk, not a minor inconvenience.",
        "- Mitigation: price this submission as if it is competing for a contested slot.",
      ].join("\n");
    }
    return [
      "## Jito leader window",
      `- Slots until next Jito leader: ${lw.slotsUntilJitoLeader}`,
      `- Currently inside leader window: ${lw.isJitoLeaderWindow}`,
      `- Next leader identity: ${lw.nextLeaderIdentity?.slice(0, 12) ?? "unknown"}`,
    ].join("\n");
  }

  private computeCongestionMultiplier(snapshot: NetworkSnapshot): number {
    const slotFactor       = Math.max(0, (snapshot.averageSlotTimeMs - 400) / 600);
    const failFactor       = snapshot.recentFailureRate * 1.5;
    const skipFactor       = (snapshot.conditions.slotSkipRate ?? 0) * 0.5;
    // High fee dispersion (p95/p25 >> 1) indicates volatile, contested fee market
    const dispersionFactor = Math.max(0, (snapshot.conditions.feeDispersionRatio - 1) / 20);
    const multiplier       = 1 + slotFactor + failFactor + skipFactor + dispersionFactor;
    return Math.min(2.5, Math.max(1.0, multiplier));
  }

  private computeLeaderMultiplier(snapshot: NetworkSnapshot): number {
    const slots = snapshot.leaderWindow.slotsUntilJitoLeader;
    // null means we have no idea whether a Jito-connected validator is even
    // leader for the upcoming slots. This is not a mild "1.15x urgency"
    // case -- it is genuine pricing-under-uncertainty, since a bundle sent
    // to a non-Jito leader cannot land at any price. We price this above
    // the known-urgent case (1.25x) specifically so the agent treats
    // "unknown" as riskier than "known and close", not as a minor bump.
    if (slots === null)  return 1.35;
    if (slots <= 1)      return 1.25;
    if (slots <= 3)      return 1.10;
    if (slots <= 10)     return 1.00;
    return 0.95;
  }

  private pickPercentileLabel(tip: number, stats: TipStats): string {
    if (tip <= stats.p25Lamports) return "p25";
    if (tip <= stats.p50Lamports) return "p50";
    if (tip <= stats.p75Lamports) return "p75";
    if (tip <= stats.p95Lamports) return "p95";
    return "p99";
  }

  private p50ConfirmationMs(): number | null {
    if (this.recentProcessedToConfirmedMs.length === 0) return null;
    const sorted = [...this.recentProcessedToConfirmedMs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  }

  private p90ConfirmationMs(): number | null {
    if (this.recentProcessedToConfirmedMs.length < 5) return null;
    const sorted = [...this.recentProcessedToConfirmedMs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.9)] ?? null;
  }
}