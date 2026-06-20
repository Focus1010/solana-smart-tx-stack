import type { LifecycleEntry } from "../types";

export interface DashboardSummary {
  totalRuns:      number;
  confirmed:      number;
  failed:         number;
  avgTipLamports: number;
  uniqueTips:     number;
  topTips:        Array<{ tipLamports: number; count: number }>;
  latencyP50Ms:   number;
  latencyP90Ms:   number;
  agentConfidenceP50: number;
  failureBreakdown: Record<string, number>;
  networks:       string[];
  generatedAt:    string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

export function buildDashboardSummary(entries: LifecycleEntry[]): DashboardSummary {
  const confirmed = entries.filter(
    (e) => e.finalStage === "confirmed" || e.finalStage === "finalized"
  ).length;
  const failed = entries.filter((e) => e.finalStage === "failed").length;

  const tips = entries.map((e) => e.tipLamports).filter((t) => t > 0);
  const avgTip =
    tips.length === 0 ? 0 : Math.round(tips.reduce((a, b) => a + b, 0) / tips.length);

  const tipCounts = new Map<number, number>();
  for (const t of tips) {
    tipCounts.set(t, (tipCounts.get(t) ?? 0) + 1);
  }
  const topTips = [...tipCounts.entries()]
    .map(([tipLamports, count]) => ({ tipLamports, count }))
    .sort((a, b) => b.tipLamports - a.tipLamports)
    .slice(0, 5);

  const latencies = entries
    .map((e) => e.latencyMs?.processedToConfirmed)
    .filter((v): v is number => v !== null && v !== undefined && v > 0)
    .sort((a, b) => a - b);

  const confidences = entries
    .map((e) => e.agentConfidence)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  const failureBreakdown: Record<string, number> = {};
  for (const e of entries.filter((x) => x.finalStage === "failed")) {
    const k = e.failure ?? "UNKNOWN";
    failureBreakdown[k] = (failureBreakdown[k] ?? 0) + 1;
  }

  const networks = [
    ...new Set(
      entries.map((e) =>
        e.explorerUrl?.includes("mainnet") ? "mainnet-beta" : e.network ?? "devnet"
      )
    ),
  ];

  return {
    totalRuns:          entries.length,
    confirmed,
    failed,
    avgTipLamports:     avgTip,
    uniqueTips:         new Set(tips).size,
    topTips,
    latencyP50Ms:       percentile(latencies, 50),
    latencyP90Ms:       percentile(latencies, 90),
    agentConfidenceP50:   percentile(confidences, 50),
    failureBreakdown,
    networks,
    generatedAt:        new Date().toISOString(),
  };
}

export function readLifecycleEntries(raw: unknown): LifecycleEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw as LifecycleEntry[];
}
