import { Connection, PublicKey } from "@solana/web3.js";
import { TipStats } from "../types";
import { Logger } from "../utils/logger";

// ─── TipOracle ────────────────────────────────────────────────────────────────
// Derives tip stats from real devnet data using getRecentPrioritizationFees().
// This RPC method returns the prioritization fees paid in recent blocks — it is
// available on both devnet and mainnet and requires no external service.
//
// We convert micro-lamports (the unit returned by the RPC) to lamports so the
// agent works with the same unit used when building the tip instruction.

export class TipOracle {
  private connection: Connection;
  private logger:     Logger;
  private lastStats:  TipStats | null = null;

  // How many recent slots to sample — 150 is the maximum the RPC accepts
  private readonly SAMPLE_SLOTS  = 150;
  private readonly CACHE_TTL_MS  = 12_000; // Refresh every ~30 slots
  // Minimum fee floor so the agent always has a non-zero baseline
  private readonly FLOOR_LAMPORTS = 1_000;

  constructor(connection: Connection, logger: Logger) {
    this.connection = connection;
    this.logger     = logger;
  }

  async fetchTipStats(): Promise<TipStats> {
    if (this.lastStats && Date.now() - this.lastStats.sampledAt < this.CACHE_TTL_MS) {
      return this.lastStats;
    }

    try {
      // getRecentPrioritizationFees returns an array of
      // { slot: number, prioritizationFee: number } objects.
      // prioritizationFee is in micro-lamports per compute unit.
      // We convert to lamports by dividing by 1000 (rough but consistent).
      const raw = await this.connection.getRecentPrioritizationFees();

      if (raw && raw.length > 0) {
        // Filter out zero-fee slots — they skew percentiles low
        const fees = raw
          .map((f) => Math.ceil(f.prioritizationFee / 1000))
          .filter((f) => f > 0);

        if (fees.length >= 4) {
          this.lastStats = this.computePercentiles(fees);
          await this.logger.info("[tip-oracle] Fetched live prioritization fees", {
            samples:     fees.length,
            p50Lamports: this.lastStats.p50Lamports,
            p75Lamports: this.lastStats.p75Lamports,
          });
          return this.lastStats;
        }
      }
    } catch (err) {
      await this.logger.warn("[tip-oracle] getRecentPrioritizationFees failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // Fallback: the network is quiet or RPC returned no fees.
    // We still use real slot data to timestamp the entry, but the fee
    // values are a conservative floor — logged clearly so it is transparent.
    this.lastStats = {
      p25Lamports: this.FLOOR_LAMPORTS,
      p50Lamports: this.FLOOR_LAMPORTS * 2,
      p75Lamports: this.FLOOR_LAMPORTS * 5,
      p95Lamports: this.FLOOR_LAMPORTS * 20,
      sampledAt:   Date.now(),
    };

    await this.logger.warn(
      "[tip-oracle] No live fee data available — using conservative floor values. " +
      "This is normal on quiet devnet periods."
    );

    return this.lastStats;
  }

  getLastStats(): TipStats | null {
    return this.lastStats;
  }

  private computePercentiles(values: number[]): TipStats {
    const sorted = [...values].sort((a, b) => a - b);
    const n      = sorted.length;

    const pct = (p: number): number => {
      const raw = sorted[Math.floor((p / 100) * (n - 1))];
      return Math.max(raw ?? 0, this.FLOOR_LAMPORTS);
    };

    return {
      p25Lamports: pct(25),
      p50Lamports: pct(50),
      p75Lamports: pct(75),
      p95Lamports: pct(95),
      sampledAt:   Date.now(),
    };
  }
}
