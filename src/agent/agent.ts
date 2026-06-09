import Groq from "groq-sdk";
import {
  TipDecision,
  TipDecisionInput,
  RetryDecision,
  RetryDecisionInput,
  NetworkSnapshot,
  TipStats,
} from "../types";
import { Logger }  from "../utils/logger";
import { config }  from "../config";

// ─── Agent ────────────────────────────────────────────────────────────────────
// Groq/LLaMA 3.3 reasoning engine. Each method receives structured runtime
// data, builds a detailed prompt referencing the exact numbers, and returns
// a typed decision. The reasoning is stored verbatim in the lifecycle log
// so every decision is fully auditable.

export class Agent {
  private groq:  Groq;
  private logger: Logger;
  private readonly model: string;

  // Rolling history for network health signal
  private recentProcessedToConfirmedMs: number[] = [];

  constructor(logger: Logger) {
    this.groq   = new Groq({ apiKey: config.groq.apiKey });
    this.logger = logger;
    this.model  = config.groq.model;
  }

  recordConfirmationLatency(ms: number): void {
    this.recentProcessedToConfirmedMs.push(ms);
    if (this.recentProcessedToConfirmedMs.length > 10) {
      this.recentProcessedToConfirmedMs.shift();
    }
  }

  // ── Tip Intelligence ────────────────────────────────────────────────────────

  async decideTip(input: TipDecisionInput): Promise<TipDecision> {
    const avgSlotMs     = this.averageSlotTime(input.networkSnapshot);
    const networkLoad   = this.classifyNetworkLoad(avgSlotMs);
    const p50ToConfMs   = this.p50ConfirmationMs();
    const leaderContext = this.describeLeaderWindow(input.networkSnapshot);
    const congestion    = this.computeCongestionMultiplier(input.networkSnapshot, avgSlotMs);
    const leaderMult    = this.computeLeaderMultiplier(input.networkSnapshot);

    const baseLamports  = input.tipStats.p50Lamports;
    const estimatedTip  = Math.round(baseLamports * congestion * leaderMult);
    const clampedTip    = Math.max(1_000, Math.min(500_000, estimatedTip));
    const percentileUsed = this.pickPercentileLabel(clampedTip, input.tipStats);

    const prompt = `
You are the tip-intelligence module inside a production Solana transaction stack.
Decide the exact tip in lamports for a Jito bundle.

## Live tip floor data (source: ${input.tipStats.source})
- p25: ${input.tipStats.p25Lamports} lamports
- p50: ${input.tipStats.p50Lamports} lamports  (baseline)
- p75: ${input.tipStats.p75Lamports} lamports
- p95: ${input.tipStats.p95Lamports} lamports
- p99: ${input.tipStats.p99Lamports} lamports
- Sampled: ${new Date(input.tipStats.sampledAt).toISOString()}

## Network conditions
- Current slot: ${input.networkSnapshot.currentSlot}
- Average slot time (last ${input.networkSnapshot.leaderWindow.currentSlot > 0 ? "20" : "0"} slots): ${avgSlotMs.toFixed(0)}ms
- Network load: ${networkLoad}
- Recent processed-to-confirmed p50: ${p50ToConfMs !== null ? p50ToConfMs + "ms" : "no data yet"}
- Recent failure rate: ${(input.networkSnapshot.recentFailureRate * 100).toFixed(0)}%

## Jito leader window
${leaderContext}

## This run context
- Fault mode: ${input.faultMode}
- Retry count: ${input.retryCount}
- Previous tip: ${input.previousTipLamports ?? "none (first run)"}
- Previous outcome: ${input.previousOutcome ?? "none"}
- Previous failure: ${input.previousFailure ?? "none"}

## Pre-computed tip estimate
- Congestion multiplier: ${congestion.toFixed(3)}
- Leader urgency multiplier: ${leaderMult.toFixed(3)}
- Estimated tip: ${clampedTip} lamports (approx ${percentileUsed})

## Decision rules
- Normal network, no leader urgency: use p50 as baseline
- Congested (slot time > 500ms) or recent failures: use p75
- Fast network, previous submission confirmed cleanly: can use p25 to save cost
- Inside leader window (slotsUntilJitoLeader <= 4): apply 1.25x urgency multiplier
- Previous FEE_TOO_LOW: must go above p75
- Fault mode low_tip: intentionally use p25 to demonstrate failure
- Never below 1000 lamports, never above 500000 lamports

Respond with ONLY valid JSON, no markdown fences:
{
  "tipLamports": <integer>,
  "action": "<submit_now|hold_for_leader>",
  "reasoning": "<3-5 sentences referencing the specific numbers above and explaining exactly why this tip was chosen>",
  "confidenceScore": <float 0.0-1.0>,
  "landingProbabilityEstimate": <float 0.0-1.0>,
  "selectedPercentile": <integer 25|50|75|95|99>,
  "congestionMultiplier": <float>,
  "leaderUrgencyMultiplier": <float>
}
`.trim();

    const raw      = await this.callGroq(prompt);
    const decision = this.parseJson<TipDecision>(raw);

    // Hard safety bounds — never trust model output without clamping
    decision.tipLamports               = Math.max(1_000, Math.min(500_000, decision.tipLamports));
    decision.confidenceScore           = Math.max(0, Math.min(1, decision.confidenceScore ?? 0.8));
    decision.landingProbabilityEstimate = Math.max(0, Math.min(1, decision.landingProbabilityEstimate ?? 0.7));
    decision.congestionMultiplier      = decision.congestionMultiplier ?? congestion;
    decision.leaderUrgencyMultiplier   = decision.leaderUrgencyMultiplier ?? leaderMult;
    decision.selectedPercentile        = decision.selectedPercentile ?? 50;

    await this.logger.agent("[agent] Tip decision", {
      tip:         decision.tipLamports,
      action:      decision.action,
      confidence:  decision.confidenceScore.toFixed(2),
      landingProb: decision.landingProbabilityEstimate.toFixed(2),
      percentile:  `p${decision.selectedPercentile}`,
      reasoning:   decision.reasoning,
    });

    return decision;
  }

  // ── Retry Reasoning ─────────────────────────────────────────────────────────

  async decideRetry(input: RetryDecisionInput): Promise<RetryDecision> {
    const avgSlotMs   = this.averageSlotTime(input.networkSnapshot);
    const leaderCtx   = this.describeLeaderWindow(input.networkSnapshot);

    const prompt = `
You are the retry-reasoning module inside a production Solana transaction stack.
A bundle submission failed. Decide whether and how to retry.

## Failure details
- Failure type: ${input.failure}
- Retry attempt: ${input.retryCount} of 3 maximum
- Blockhash expired: ${input.blockhashExpired}
- Fault mode (intentional): ${input.faultMode}
- Previous tip: ${input.previousTipLamports} lamports

## Current network state
- Slot: ${input.networkSnapshot.currentSlot}
- Average slot time: ${avgSlotMs.toFixed(0)}ms
- Recent failure rate: ${(input.networkSnapshot.recentFailureRate * 100).toFixed(0)}%
${leaderCtx}

## Live tip percentiles (source: ${input.tipStats.source})
- p25: ${input.tipStats.p25Lamports} | p50: ${input.tipStats.p50Lamports} | p75: ${input.tipStats.p75Lamports}
- p95: ${input.tipStats.p95Lamports} | p99: ${input.tipStats.p99Lamports}

## Failure reference guide
- EXPIRED_BLOCKHASH: blockhash validity window passed — refresh blockhash before retry
- FEE_TOO_LOW: tip lost the Jito auction — increase to at least p75
- COMPUTE_EXCEEDED: transaction hit compute budget — do NOT retry, tip cannot fix this
- BUNDLE_DROPPED: Jito leader skipped slot — retry after 2 slots with fresh blockhash
- LEADER_SKIPPED: same as BUNDLE_DROPPED
- SIMULATION_FAILED: transaction logic error — do NOT retry
- TIMEOUT: no confirmation within window — retry with p75 tip
- UNKNOWN: retry once with p75 tip

## Hard rules
- SIMULATION_FAILED or COMPUTE_EXCEEDED: always shouldRetry false
- retryCount >= 3: always shouldRetry false
- waitMs: minimum 800ms, maximum 8000ms
- If fault mode is low_tip and failure is FEE_TOO_LOW, this is expected — retry with p75 to demonstrate recovery

Respond ONLY with valid JSON, no markdown:
{
  "shouldRetry": <boolean>,
  "action": "<retry_refresh_blockhash|retry_increase_tip|retry_same_tip|abort>",
  "newTipLamports": <integer>,
  "reasoning": "<3-5 sentences diagnosing exactly why this failure occurred and what change will fix it>",
  "refreshBlockhash": <boolean>,
  "waitMs": <integer>,
  "confidenceScore": <float 0.0-1.0>
}
`.trim();

    const raw      = await this.callGroq(prompt);
    const decision = this.parseJson<RetryDecision>(raw);

    // Enforce hard limits
    decision.newTipLamports  = Math.max(1_000, Math.min(500_000, decision.newTipLamports));
    decision.waitMs          = Math.max(800, Math.min(8_000, decision.waitMs));
    decision.confidenceScore = Math.max(0, Math.min(1, decision.confidenceScore ?? 0.8));

    if (input.retryCount >= 3) {
      decision.shouldRetry = false;
      decision.action      = "abort";
      decision.reasoning   = `Retry budget exhausted after ${input.retryCount} attempts. ${decision.reasoning}`;
    }

    await this.logger.agent("[agent] Retry decision", {
      shouldRetry:      decision.shouldRetry,
      action:           decision.action,
      newTip:           decision.newTipLamports,
      refreshBlockhash: decision.refreshBlockhash,
      waitMs:           decision.waitMs,
      reasoning:        decision.reasoning,
    });

    return decision;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private async callGroq(prompt: string): Promise<string> {
    const completion = await this.groq.chat.completions.create({
      model:       this.model,
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens:  512,
    });
    return (completion.choices[0]?.message?.content ?? "").trim();
  }

  private parseJson<T>(raw: string): T {
    const clean = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
    try {
      return JSON.parse(clean) as T;
    } catch {
      throw new Error(`Agent returned invalid JSON. Raw output: ${raw.slice(0, 200)}`);
    }
  }

  private averageSlotTime(snapshot: NetworkSnapshot): number {
    return snapshot.averageSlotTimeMs > 0 ? snapshot.averageSlotTimeMs : 400;
  }

  private classifyNetworkLoad(avgSlotMs: number): string {
    if (avgSlotMs > 600) return `congested (${avgSlotMs.toFixed(0)}ms/slot, above 600ms threshold)`;
    if (avgSlotMs < 350) return `fast (${avgSlotMs.toFixed(0)}ms/slot, below 350ms threshold)`;
    return `normal (${avgSlotMs.toFixed(0)}ms/slot)`;
  }

  private describeLeaderWindow(snapshot: NetworkSnapshot): string {
    const lw = snapshot.leaderWindow;
    if (lw.slotsUntilJitoLeader === null) {
      return "- Leader window: unknown (getNextScheduledLeader unavailable on this endpoint)";
    }
    return [
      `- Slots until next Jito leader: ${lw.slotsUntilJitoLeader}`,
      `- Inside leader window: ${lw.isJitoLeaderWindow}`,
      `- Next leader identity: ${lw.nextLeaderIdentity?.slice(0, 12) ?? "unknown"}`,
    ].join("\n");
  }

  private computeCongestionMultiplier(snapshot: NetworkSnapshot, avgSlotMs: number): number {
    const failureRate  = snapshot.recentFailureRate ?? 0;
    const slotFactor   = Math.min((avgSlotMs - 400) / 1000, 0.5);
    const multiplier   = 1 + failureRate * 1.5 + Math.max(0, slotFactor);
    return Math.min(2.0, Math.max(1.0, multiplier));
  }

  private computeLeaderMultiplier(snapshot: NetworkSnapshot): number {
    const slots = snapshot.leaderWindow.slotsUntilJitoLeader;
    if (slots === null)   return 1.15;
    if (slots <= 1)       return 1.25;
    if (slots <= 3)       return 1.10;
    if (slots <= 10)      return 1.00;
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
}
