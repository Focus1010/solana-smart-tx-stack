/**
 * Dashboard summary unit tests.
 * Run: npx ts-node test/dashboard.test.ts
 */

import assert from "assert";
import { buildDashboardSummary } from "../src/dashboard/summary";
import type { LifecycleEntry } from "../src/types";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void): Promise<void> {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

function sampleEntry(overrides: Partial<LifecycleEntry> = {}): LifecycleEntry {
  return {
    runId: "TEST001",
    bundleId: null,
    signature: "sig123",
    network: "devnet",
    dryRun: false,
    tipLamports: 5000,
    tipAccount: "tip",
    submittedAt: Date.now(),
    submittedAtIso: new Date().toISOString(),
    stages: [],
    finalStage: "confirmed",
    failure: null,
    faultInjected: "none",
    agentReasoning: "Test reasoning with enough length to pass audit checks for agent traces.",
    agentConfidence: 0.85,
    agentAction: "submit_now",
    agentDecision: {
      engine: "groq",
      model: "llama-3.3-70b-versatile",
      action: "submit_now",
      selectedTipLamports: 5000,
      landingProbabilityEstimate: 0.7,
      reasoning: "Test",
      promptHash: "abc123",
      llmLatencyMs: 120,
      guardrailAdjusted: false,
    },
    leaderWindow: null,
    networkSnapshot: null,
    networkConditionsAtSubmission: null,
    networkConditionsAtConfirmation: null,
    deltaFromSubmissionToConfirmation: null,
    triggerEvent: null,
    marinadeTriggerEvent: null,
    retryCount: 0,
    blockhashUsed: "bh",
    slotAtSubmission: 100,
    explorerUrl: "https://explorer.solana.com/tx/sig123?cluster=devnet",
    bundleTxSignature: "bundleSig",
    rawBundleResults: [],
    latencyMs: {
      submittedToProcessed: 100,
      processedToConfirmed: 250,
      confirmedToFinalized: null,
      submittedToFinalized: null,
    },
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log("\nDashboard buildDashboardSummary");

  await test("returns expected summary fields", () => {
    const entries = [
      sampleEntry(),
      sampleEntry({ runId: "TEST002", finalStage: "failed", tipLamports: 8000, failure: "TIMEOUT" }),
    ];
    const s = buildDashboardSummary(entries);
    assert.strictEqual(s.totalRuns, 2);
    assert.strictEqual(s.confirmed, 1);
    assert.strictEqual(s.failed, 1);
    assert.ok(s.avgTipLamports > 0);
    assert.ok(typeof s.latencyP50Ms === "number");
    assert.ok(typeof s.agentConfidenceP50 === "number");
    assert.ok(Array.isArray(s.topTips));
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
