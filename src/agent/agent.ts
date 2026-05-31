import Groq from "groq-sdk";
import {
  TipDecision,
  TipDecisionInput,
  RetryDecision,
  RetryDecisionInput,
} from "../types";
import { Logger } from "../utils/logger";
import { config } from "../config";

// ─── Agent ────────────────────────────────────────────────────────────────────
// This is the reasoning layer. Each public method accepts structured context,
// constructs a prompt, calls Groq, and returns a typed decision.
// Reasoning text is preserved so it can be written to the lifecycle log.

export class Agent {
  private groq: Groq;
  private logger: Logger;
  private readonly model: string;

  constructor(logger: Logger) {
    this.groq   = new Groq({ apiKey: config.groq.apiKey });
    this.logger = logger;
    this.model  = config.groq.model;
  }

  // ── Tip Intelligence ────────────────────────────────────────────────────────
  // Given live tip account percentiles + current slot conditions, decide
  // exactly how many lamports to tip this bundle.

  async decideTip(input: TipDecisionInput): Promise<TipDecision> {
    const avgSlotMs = input.recentSlotTimes.length > 1
      ? this.average(input.recentSlotTimes)
      : 400;

    const networkLoad = avgSlotMs > 600
      ? "congested (slots > 600ms)"
      : avgSlotMs < 350
      ? "fast (slots < 350ms)"
      : "normal";

    const prompt = `
You are the tip-intelligence module inside a Solana transaction stack.
Your only job: decide the optimal tip in lamports for a Jito bundle.

## Current network snapshot
- Slot: ${input.currentSlot}
- Average slot time (last ${input.recentSlotTimes.length} slots): ${avgSlotMs.toFixed(0)}ms
- Network assessment: ${networkLoad}

## Live tip account percentiles (lamports)
- p25: ${input.tipStats.p25Lamports}
- p50: ${input.tipStats.p50Lamports}
- p75: ${input.tipStats.p75Lamports}
- p95: ${input.tipStats.p95Lamports}
- Sampled: ${new Date(input.tipStats.sampledAt).toISOString()}

## Previous submission context
- Previous tip: ${input.previousTipLamports ?? "none (first run)"}
- Previous outcome: ${input.previousOutcome ?? "none"}

## Decision rules
- Use p50 as baseline on a normal network
- Use p75 when network is congested (higher competition)
- Use p25 when network is fast and previous outcome was successful (save cost)
- Never tip below 1000 lamports (too low, bundle will be dropped)
- Never exceed p95 unless previous outcome was a drop/timeout

Respond with ONLY valid JSON — no markdown, no explanation outside the JSON:
{
  "tipLamports": <integer>,
  "reasoning": "<one concise sentence explaining the decision>",
  "confidenceScore": <float 0.0–1.0>
}
`.trim();

    const raw = await this.callGroq(prompt);
    const decision = this.parseJson<TipDecision>(raw);

    // Hard safety bounds — agent output can't go below floor or above ceiling
    decision.tipLamports = Math.max(1_000, Math.min(decision.tipLamports, 500_000));
    decision.confidenceScore = Math.max(0, Math.min(1, decision.confidenceScore));

    await this.logger.agent("[agent] Tip decision", {
      tip:        decision.tipLamports,
      confidence: decision.confidenceScore.toFixed(2),
      reasoning:  decision.reasoning,
    });

    return decision;
  }

  // ── Retry Reasoning ─────────────────────────────────────────────────────────
  // Given a failure, decide whether to retry, with what tip, and how long to wait.

  async decideRetry(input: RetryDecisionInput): Promise<RetryDecision> {
    const prompt = `
You are the retry-reasoning module inside a Solana transaction stack.
A bundle submission just failed. Decide if and how to retry.

## Failure details
- Failure type: ${input.failure}
- Retry attempt: ${input.retryCount} (0 = first failure)
- Blockhash expired: ${input.blockhashExpired}
- Previous tip: ${input.previousTipLamports} lamports
- Current slot: ${input.currentSlot}

## Live tip percentiles (lamports)
- p25: ${input.tipStats.p25Lamports}
- p50: ${input.tipStats.p50Lamports}
- p75: ${input.tipStats.p75Lamports}

## Failure reference
- EXPIRED_BLOCKHASH: blockhash too old — must refresh before retry
- FEE_TOO_LOW: tip was not competitive — increase to at least p75
- COMPUTE_EXCEEDED: tx computation limit hit — do NOT increase tip, fix the tx
- BUNDLE_DROPPED: Jito leader skipped their slot — retry with fresh blockhash after 2 slots
- TIMEOUT: no confirmation within window — retry with p75 tip
- SIMULATION_FAILED: tx logic error — do not retry (pointless)
- UNKNOWN: retry once with p75 tip

## Rules
- Max 3 retries total; if retryCount >= 3, set shouldRetry: false
- SIMULATION_FAILED: always shouldRetry: false
- COMPUTE_EXCEEDED: shouldRetry: false (tip won't help)
- waitMs: at least 800ms, at most 5000ms

Respond with ONLY valid JSON — no markdown:
{
  "shouldRetry": <boolean>,
  "newTipLamports": <integer>,
  "reasoning": "<one concise sentence>",
  "refreshBlockhash": <boolean>,
  "waitMs": <integer>
}
`.trim();

    const raw      = await this.callGroq(prompt);
    const decision = this.parseJson<RetryDecision>(raw);

    // Enforce hard limits
    decision.newTipLamports = Math.max(1_000, Math.min(decision.newTipLamports, 500_000));
    decision.waitMs         = Math.max(800, Math.min(decision.waitMs, 10_000));

    if (input.retryCount >= 3) {
      decision.shouldRetry = false;
      decision.reasoning   = `Max retry limit (3) reached. ${decision.reasoning}`;
    }

    await this.logger.agent("[agent] Retry decision", {
      shouldRetry:      decision.shouldRetry,
      newTip:           decision.newTipLamports,
      refreshBlockhash: decision.refreshBlockhash,
      waitMs:           decision.waitMs,
      reasoning:        decision.reasoning,
    });

    return decision;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  private async callGroq(prompt: string): Promise<string> {
    const completion = await this.groq.chat.completions.create({
      model:       this.model,
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.2,   // Low temperature — we want consistent, deterministic decisions
      max_tokens:  256,
    });

    const content = completion.choices[0]?.message?.content ?? "";
    return content.trim();
  }

  private parseJson<T>(raw: string): T {
    // Strip any accidental markdown fences
    const clean = raw
      .replace(/^```(?:json)?/m, "")
      .replace(/```$/m, "")
      .trim();

    try {
      return JSON.parse(clean) as T;
    } catch (err) {
      throw new Error(`Agent returned invalid JSON: ${raw}`);
    }
  }

  private average(values: number[]): number {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
}
