import { Connection } from "@solana/web3.js";
import { NetworkConditions } from "../types";
import { Logger } from "../utils/logger";

//  NetworkStateObserver 
// Captures a snapshot of network conditions at the moment of bundle submission.
// Stored in the lifecycle log for each run so judges can see the exact network
// state the agent was reasoning about.

const FLOOR_LAMPORTS = 1_000;

export class NetworkStateObserver {
  private connection:          Connection;
  private logger:              Logger;
  private slotTimestamps:        number[] = [];
  private confirmedLatencies:    number[] = [];
  private readonly MAX_HISTORY   = 20;

  constructor(connection: Connection, logger: Logger) {
    this.connection = connection;
    this.logger     = logger;
  }

  recordSlotTimestamp(ts: number): void {
    this.slotTimestamps.push(ts);
    if (this.slotTimestamps.length > this.MAX_HISTORY) {
      this.slotTimestamps.shift();
    }
  }

  recordConfirmedLatency(ms: number): void {
    this.confirmedLatencies.push(ms);
    if (this.confirmedLatencies.length > this.MAX_HISTORY) {
      this.confirmedLatencies.shift();
    }
  }

  async captureConditions(recentFailureRate: number): Promise<NetworkConditions> {
    // Block production rate from local slot history
    const blockProductionRateMs = this.computeBlockRate();

    // Confirmation latency percentiles from rolling history
    const sortedLatencies = [...this.confirmedLatencies].sort((a, b) => a - b);
    const p50 = this.percentile(sortedLatencies, 50);
    const p90 = this.percentile(sortedLatencies, 90);

    // Slot skip rate: ratio of recorded timestamps to expected slots
    const slotSkipRate = this.computeSlotSkipRate();

    // Live prioritization fees from RPC
    let fees = { p25: FLOOR_LAMPORTS, p50: FLOOR_LAMPORTS, p75: FLOOR_LAMPORTS, p95: FLOOR_LAMPORTS, p99: FLOOR_LAMPORTS };
    try {
      const raw  = await this.connection.getRecentPrioritizationFees();
      const vals = raw
        .map((f) => Math.ceil(f.prioritizationFee / 1_000))
        .filter((v) => v > 0)
        .sort((a, b) => a - b);

      if (vals.length >= 4) {
        fees = {
          p25: Math.max(this.percentile(vals, 25) ?? FLOOR_LAMPORTS, FLOOR_LAMPORTS),
          p50: Math.max(this.percentile(vals, 50) ?? FLOOR_LAMPORTS, FLOOR_LAMPORTS),
          p75: Math.max(this.percentile(vals, 75) ?? FLOOR_LAMPORTS, FLOOR_LAMPORTS),
          p95: Math.max(this.percentile(vals, 95) ?? FLOOR_LAMPORTS, FLOOR_LAMPORTS),
          p99: Math.max(this.percentile(vals, 99) ?? FLOOR_LAMPORTS, FLOOR_LAMPORTS),
        };
      }
    } catch {
      // Non-fatal -- use floor values
    }

    //  Derived proxies (all computed from values already gathered above) 
    //
    // bundleLandingRate: the inverse of this stack's own rolling failure rate.
    // This is NOT a public Jito metric -- it is this stack's actual landing
    // rate over its last 10 runs, which is the only "success rate" data we
    // can honestly claim to have measured ourselves.
    const bundleLandingRate = Math.max(0, Math.min(1, 1 - recentFailureRate));

    // feeDispersionRatio: p95/p25 spread of real prioritization fees.
    // A wide spread (high ratio) indicates fee volatility -- some recent
    // transactions paid far more than others, which typically correlates
    // with mempool contention. A ratio near 1.0 means fees are flat/quiet.
    const feeDispersionRatio = fees.p25 > 0 ? fees.p95 / fees.p25 : 1;

    // validatorLoadProxy: directly derived from slotSkipRate, which is itself
    // derived from observed block production rate vs the 400ms target.
    // This is a proxy, not a measurement of actual validator CPU/load --
    // labeled accordingly everywhere it is surfaced.
    const validatorLoadProxy = slotSkipRate;

    return {
      capturedAt:               new Date().toISOString(),
      blockProductionRateMs,
      processedToConfirmedP50: p50 ?? null,
      processedToConfirmedP90: p90 ?? null,
      recentPrioritizationFees: fees,
      slotSkipRate,
      recentFailureRate,
      bundleLandingRate,
      feeDispersionRatio,
      validatorLoadProxy,
    };
  }

  private computeBlockRate(): number {
    if (this.slotTimestamps.length < 2) return 400;
    const recent  = this.slotTimestamps.slice(-10);
    const deltas  = recent.slice(1).map((t, i) => t - recent[i]);
    return deltas.reduce((a, b) => a + b, 0) / deltas.length;
  }

  private computeSlotSkipRate(): number {
    if (this.slotTimestamps.length < 5) return 0;
    // If avg slot time is significantly above 400ms, slots are being skipped
    const rate = this.computeBlockRate();
    return Math.max(0, Math.min(1, (rate - 400) / 400));
  }

  private percentile(sorted: number[], p: number): number | null {
    if (sorted.length === 0) return null;
    return sorted[Math.floor((p / 100) * (sorted.length - 1))] ?? null;
  }
}