/**
 * generate-mainnet-report.ts
 *
 * Reads logs/lifecycle.json after a mainnet run and produces
 * evidence/mainnet-observations.md -- a report with real observed
 * percentiles, fee pressure timeline, and an updated README Q1 answer
 * using actual numbers from the run. No placeholder or estimated values.
 *
 * Only meaningful when logs/lifecycle.json contains mainnet-beta entries.
 *
 * Run: npm run generate:mainnet-report
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";
import { LifecycleEntry } from "../types";

const LIFECYCLE_PATH = path.join(process.cwd(), "logs", "lifecycle.json");
const EVIDENCE_DIR   = path.join(process.cwd(), "evidence");

function readLifecycle(): LifecycleEntry[] {
  if (!fs.existsSync(LIFECYCLE_PATH)) {
    console.error("logs/lifecycle.json not found. Run npm start first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(LIFECYCLE_PATH, "utf-8")) as LifecycleEntry[];
}

function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.floor((p / 100) * (sorted.length - 1))] ?? null;
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function isMainnet(e: LifecycleEntry): boolean {
  return (e.explorerUrl ?? "").includes("mainnet");
}

async function main(): Promise<void> {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const all      = readLifecycle();
  const mainnet  = all.filter(isMainnet).filter((e) => e.faultInjected === "none");

  if (mainnet.length === 0) {
    console.log(
      "No mainnet-beta entries found in logs/lifecycle.json.\n" +
      "This script only produces output after running on mainnet:\n" +
      "  SOLANA_NETWORK=mainnet-beta npm start\n"
    );
    // Write a placeholder file explaining the situation honestly, rather
    // than leaving nothing or writing fabricated numbers.
    const placeholder = `# Mainnet Observations

No mainnet-beta runs have been recorded yet in logs/lifecycle.json.

This stack was validated on devnet (see logs/lifecycle.json and
evidence/verification-report.md for devnet results, which are real and
verifiable on Solana Explorer devnet).

To generate this report with real mainnet data:

\`\`\`bash
# In .env:
SOLANA_NETWORK=mainnet-beta
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WS_URL=wss://api.mainnet-beta.solana.com
JITO_RPC_URL=https://mainnet.block-engine.jito.wtf/api/v1

npm start
npm run generate:mainnet-report
\`\`\`

This will populate the percentile tables, fee pressure timeline, and the
README Q1 answer below using only values observed by this stack's own
NetworkStateObserver during the run. No estimated or placeholder values
are used in the populated version of this report.
`;
    fs.writeFileSync(path.join(EVIDENCE_DIR, "mainnet-observations.md"), placeholder);
    console.log("Written: evidence/mainnet-observations.md (placeholder, explains how to populate)");
    return;
  }

  // ── Real mainnet data is present -- compute everything from it ────────────

  const p2cValues = mainnet
    .map((e) => e.latencyMs?.processedToConfirmed)
    .filter((v): v is number => v !== null && v !== undefined);

  const c2fValues = mainnet
    .map((e) => e.latencyMs?.confirmedToFinalized)
    .filter((v): v is number => v !== null && v !== undefined);

  const sortedP2c = [...p2cValues].sort((a, b) => a - b);
  const sortedC2f = [...c2fValues].sort((a, b) => a - b);

  const p50 = pct(sortedP2c, 50);
  const p90 = pct(sortedP2c, 90);
  const p99 = pct(sortedP2c, 99);
  const avgP2c = avg(p2cValues);

  // Block production rate from networkSnapshot across runs
  const blockRates = mainnet
    .map((e) => e.networkSnapshot?.conditions.blockProductionRateMs)
    .filter((v): v is number => v !== undefined && v !== null);
  const avgBlockRate = avg(blockRates);
  const sortedBlockRates = [...blockRates].sort((a, b) => a - b);
  const blockP50 = pct(sortedBlockRates, 50);
  const blockP90 = pct(sortedBlockRates, 90);
  const blockP99 = pct(sortedBlockRates, 99);

  // Percentile selection trend (what the agent actually chose, run by run)
  // Reconstructed from tip vs tipStats at time of decision is not stored
  // directly, so we report agentAction and tipLamports per run instead --
  // this is the real, stored data.
  const runRows = mainnet.map((e, i) => ({
    run:        i + 1,
    runId:      e.runId,
    tip:        e.tipLamports,
    action:     e.agentAction,
    finalStage: e.finalStage,
    p2c:        e.latencyMs?.processedToConfirmed ?? null,
  }));

  // Confirmed count
  const confirmedCount = mainnet.filter((e) =>
    e.finalStage === "confirmed" || e.finalStage === "finalized"
  ).length;
  const landingRate = (confirmedCount / mainnet.length) * 100;

  // Trend: first half vs second half average p2c (only if enough samples)
  let trendLine = "Not enough samples to compute a meaningful trend (need 6+ runs with confirmation data).";
  if (p2cValues.length >= 6) {
    const half = Math.floor(p2cValues.length / 2);
    const firstHalfAvg  = avg(p2cValues.slice(0, half));
    const secondHalfAvg = avg(p2cValues.slice(half));
    const changePct = firstHalfAvg > 0 ? ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100 : 0;
    const direction = changePct > 0 ? "increased" : "decreased";
    trendLine = `processed-to-confirmed latency ${direction} by ${Math.abs(changePct).toFixed(1)}% from the first half of the run sequence (avg ${firstHalfAvg.toFixed(0)}ms) to the second half (avg ${secondHalfAvg.toFixed(0)}ms).`;
  }

  const runRowsTable = runRows
    .map((r) => `| ${r.run} | ${r.runId} | ${r.tip} | ${r.action} | ${r.finalStage} | ${r.p2c !== null ? r.p2c + "ms" : "-"} |`)
    .join("\n");

  const report = `# Mainnet Observations

Generated: ${new Date().toISOString()}
Source: logs/lifecycle.json (${mainnet.length} mainnet-beta normal runs, fault injection entries excluded)

All values below are computed directly from this stack's own recorded runs.
No estimated, placeholder, or third-party "public metrics" values are used.

---

## Run Summary

- Total mainnet runs: ${mainnet.length}
- Confirmed or finalized: ${confirmedCount}
- Landing rate: ${landingRate.toFixed(0)}%

## Processed to Confirmed Latency

| Metric | Value |
|---|---|
| Samples | ${p2cValues.length} |
| Average | ${avgP2c.toFixed(0)}ms |
| p50 | ${p50 !== null ? p50 + "ms" : "n/a"} |
| p90 | ${p90 !== null ? p90 + "ms" : "n/a"} |
| p99 | ${p99 !== null ? p99 + "ms" : "n/a"} |

## Block Production Rate (observed by SlotPoller / SlotStream)

| Metric | Value |
|---|---|
| Samples | ${blockRates.length} |
| Average | ${avgBlockRate.toFixed(0)}ms/slot |
| p50 | ${blockP50 !== null ? blockP50.toFixed(0) + "ms" : "n/a"} |
| p90 | ${blockP90 !== null ? blockP90.toFixed(0) + "ms" : "n/a"} |
| p99 | ${blockP99 !== null ? blockP99.toFixed(0) + "ms" : "n/a"} |

## Latency Trend Across the Run Sequence

${trendLine}

This trend is fed back into the agent via \`processedToConfirmedMsP50\` and
\`processedToConfirmedMsP90\` on subsequent runs within the same session,
influencing the congestion multiplier on later tip decisions.

## Per-Run Detail

| Run | Run ID | Tip (lamports) | Agent Action | Final Stage | Processed to Confirmed |
|---|---|---|---|---|---|
${runRowsTable}

---

## README Question 1 (Updated With Mainnet Data)

### What does the delta between processed_at and confirmed_at tell you about network health?

The processed to confirmed delta measures the time for the validator set to
reach supermajority consensus (66%+ stake weight) on the block containing
the transaction.

In this stack's ${mainnet.length} mainnet-beta runs, the observed
processed-to-confirmed delta averaged ${avgP2c.toFixed(0)}ms, with a p50 of
${p50 !== null ? p50 + "ms" : "n/a"} and a p90 of ${p90 !== null ? p90 + "ms" : "n/a"}.
${p90 !== null && p50 !== null && p50 > 0
    ? `The p90 was ${(((p90 - p50) / p50) * 100).toFixed(0)}% higher than the p50, showing the tail of the distribution is meaningfully slower than the median.`
    : ""}

${trendLine}

This stack feeds the rolling p50 and p90 into \`NetworkSnapshot.processedToConfirmedMsP50\`
and \`processedToConfirmedMsP90\`, which are used directly in the agent's
congestion multiplier calculation (\`computeCongestionMultiplier\` in
\`src/agent/agent.ts\`). A rising p90 relative to p50 increases the multiplier,
pushing the agent toward higher tip percentiles on the next submission.

---

All slot numbers and signatures referenced in \`logs/lifecycle.json\` for these
runs are verifiable at https://explorer.solana.com/?cluster=mainnet-beta
`;

  fs.writeFileSync(path.join(EVIDENCE_DIR, "mainnet-observations.md"), report);
  console.log("Written: evidence/mainnet-observations.md");
  console.log(`\nMainnet runs analyzed: ${mainnet.length}`);
  console.log(`Confirmed: ${confirmedCount}`);
  console.log(`Avg processed-to-confirmed: ${avgP2c.toFixed(0)}ms`);
}

main().catch((err) => { console.error(err); process.exit(1); });
