import { Connection } from "@solana/web3.js";
import { TipStats }   from "../types";
import { Logger }     from "../utils/logger";
import { config }     from "../config";

// ─── TipOracle ────────────────────────────────────────────────────────────────
// Primary source: Jito tip floor API (bundles.jito.wtf/api/v1/bundles/tip_floor)
// This is the real Jito auction data — it returns actual percentiles of tips
// paid in recent Jito bundles, which is exactly what you need to price
// competitively in the Jito block auction.
//
// Fallback: getRecentPrioritizationFees() from the RPC node.
// This is always available on both devnet and mainnet.
//
// Second fallback: conservative floor values, logged transparently.

const JITO_TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
const FLOOR_LAMPORTS     = 1_000;

export class TipOracle {
  private connection: Connection;
  private logger:     Logger;
  private lastStats:  TipStats | null = null;
  private readonly CACHE_TTL_MS = 10_000;

  constructor(connection: Connection, logger: Logger) {
    this.connection = connection;
    this.logger     = logger;
  }

  async fetchTipStats(): Promise<TipStats> {
    if (this.lastStats && Date.now() - this.lastStats.sampledAt < this.CACHE_TTL_MS) {
      return this.lastStats;
    }

    // Try Jito tip floor API first (mainnet only, best data)
    const jitoStats = await this.fetchFromJitoApi();
    if (jitoStats) {
      this.lastStats = jitoStats;
      return this.lastStats;
    }

    // Fallback to RPC prioritization fees (works on devnet too)
    const rpcStats = await this.fetchFromRpc();
    if (rpcStats) {
      this.lastStats = rpcStats;
      return this.lastStats;
    }

    // Conservative floor
    this.lastStats = {
      p25Lamports: FLOOR_LAMPORTS,
      p50Lamports: FLOOR_LAMPORTS * 2,
      p75Lamports: FLOOR_LAMPORTS * 5,
      p95Lamports: FLOOR_LAMPORTS * 20,
      p99Lamports: FLOOR_LAMPORTS * 50,
      sampledAt:   Date.now(),
      source:      "fallback",
    };

    await this.logger.warn(
      "[tip-oracle] Using conservative floor values — no live fee data available. " +
      "Normal on devnet or when Jito tip floor API is unreachable."
    );

    return this.lastStats;
  }

  getLastStats(): TipStats | null { return this.lastStats; }

  private async fetchFromJitoApi(): Promise<TipStats | null> {
    try {
      const res = await fetch(JITO_TIP_FLOOR_URL, {
        headers: { accept: "application/json" },
        signal:  AbortSignal.timeout(6_000),
      });

      if (!res.ok) return null;

      const raw  = await res.json();
      const row  = Array.isArray(raw) ? raw[0] : raw;
      if (!row || typeof row !== "object") return null;

      const get = (key: string): number => {
        const v = (row as any)[key];
        const n = Number(v);
        return Number.isFinite(n) ? Math.round(n * 1e9) : 0; // API returns SOL, convert to lamports
      };

      const p25 = get("ema_landed_tips_25th_percentile") || get("landed_tips_25th_percentile") || 0;
      const p50 = get("ema_landed_tips_50th_percentile") || get("landed_tips_50th_percentile") || 0;
      const p75 = get("ema_landed_tips_75th_percentile") || get("landed_tips_75th_percentile") || 0;
      const p95 = get("ema_landed_tips_95th_percentile") || get("landed_tips_95th_percentile") || 0;
      const p99 = get("ema_landed_tips_99th_percentile") || get("landed_tips_99th_percentile") || 0;

      if (p50 === 0) return null;

      const stats: TipStats = {
        p25Lamports: Math.max(p25, FLOOR_LAMPORTS),
        p50Lamports: Math.max(p50, FLOOR_LAMPORTS),
        p75Lamports: Math.max(p75, FLOOR_LAMPORTS),
        p95Lamports: Math.max(p95, FLOOR_LAMPORTS),
        p99Lamports: Math.max(p99, FLOOR_LAMPORTS),
        sampledAt:   Date.now(),
        source:      "jito-tip-floor",
      };

      await this.logger.info("[tip-oracle] Live Jito tip floor data", {
        p50: stats.p50Lamports,
        p75: stats.p75Lamports,
        p99: stats.p99Lamports,
      });

      return stats;

    } catch {
      return null;
    }
  }

  private async fetchFromRpc(): Promise<TipStats | null> {
    try {
      const raw = await this.connection.getRecentPrioritizationFees();
      if (!raw || raw.length === 0) return null;

      const fees = raw
        .map((f) => Math.ceil(f.prioritizationFee / 1000))
        .filter((f) => f > 0);

      if (fees.length < 4) return null;

      const sorted = [...fees].sort((a, b) => a - b);
      const n      = sorted.length;
      const pct    = (p: number) =>
        Math.max(sorted[Math.floor((p / 100) * (n - 1))] ?? 0, FLOOR_LAMPORTS);

      const stats: TipStats = {
        p25Lamports: pct(25),
        p50Lamports: pct(50),
        p75Lamports: pct(75),
        p95Lamports: pct(95),
        p99Lamports: pct(99),
        sampledAt:   Date.now(),
        source:      "rpc-prioritization-fees",
      };

      await this.logger.info("[tip-oracle] RPC prioritization fee data", {
        samples: fees.length,
        p50:     stats.p50Lamports,
        p75:     stats.p75Lamports,
      });

      return stats;

    } catch {
      return null;
    }
  }
}
