import "dotenv/config";
import fs from "fs";
import path from "path";
import { LifecycleEntry } from "../types";

const LIFECYCLE_PATH = path.join(process.cwd(), "logs", "lifecycle.json");

type Level = "PASS" | "WARN" | "FAIL";

interface Check {
  level: Level;
  name: string;
  detail: string;
}

function readLifecycle(): LifecycleEntry[] {
  if (!fs.existsSync(LIFECYCLE_PATH)) {
    throw new Error("logs/lifecycle.json not found. Run the stack before auditing evidence.");
  }
  return JSON.parse(fs.readFileSync(LIFECYCLE_PATH, "utf-8")) as LifecycleEntry[];
}

function count(entries: LifecycleEntry[], pred: (entry: LifecycleEntry) => boolean): number {
  return entries.filter(pred).length;
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function main(): void {
  const entries = readLifecycle();
  const successes = count(entries, (e) => e.finalStage === "confirmed" || e.finalStage === "finalized");
  const failed = entries.filter((e) => e.finalStage === "failed" || (e.failure !== null && e.failure !== undefined));
  const classifiedFailures = failed.filter((e) => e.failure && e.failure !== "UNKNOWN");
  const distinctFailures = new Set(classifiedFailures.map((e) => e.failure)).size;
  const faultRuns = count(entries, (e) => !!e.faultInjected && e.faultInjected !== "none");
  const uniqueTips = new Set(entries.map((e) => e.tipLamports).filter((tip) => tip > 0)).size;
  const reasoning = count(entries, (e) => (e.agentReasoning?.trim().length ?? 0) >= 50);
  const actions = new Set(entries.map((e) => e.agentAction).filter(hasText)).size;
  const realSlots = count(entries, (e) => (e.slotAtSubmission ?? 0) > 0 || e.stages?.some((s) => (s.slot ?? 0) > 0));
  const explorerUrls = count(entries, (e) => hasText(e.explorerUrl));
  const networkSnapshots = count(entries, (e) => e.networkSnapshot != null);
  const leaderWindows = count(entries, (e) => e.leaderWindow != null);
  const p2cLatency = count(entries, (e) => e.latencyMs?.processedToConfirmed != null);
  const finalized = count(entries, (e) => e.finalStage === "finalized" || e.stages?.some((s) => s.stage === "finalized"));

  const checks: Check[] = [
    {
      level: entries.length >= 10 ? "PASS" : "FAIL",
      name: "Lifecycle volume",
      detail: `${entries.length} total records; bounty minimum is 10 real submissions.`,
    },
    {
      level: successes >= 10 ? "PASS" : successes > 0 ? "WARN" : "FAIL",
      name: "Successful submissions",
      detail: `${successes} confirmed/finalized records.`,
    },
    {
      level: classifiedFailures.length >= 2 ? "PASS" : "FAIL",
      name: "Classified failures",
      detail: `${classifiedFailures.length} classified failure records; bounty minimum is 2.`,
    },
    {
      level: distinctFailures >= 2 ? "PASS" : classifiedFailures.length >= 2 ? "WARN" : "FAIL",
      name: "Failure diversity",
      detail: `${distinctFailures} distinct classified failure types observed.`,
    },
    {
      level: faultRuns >= 1 ? "PASS" : "WARN",
      name: "Fault injection marker",
      detail: `${faultRuns} records include faultInjected metadata; rerun npm run run:inject if this is 0.`,
    },
    {
      level: uniqueTips >= 3 ? "PASS" : uniqueTips > 1 ? "WARN" : "FAIL",
      name: "Dynamic tip evidence",
      detail: `${uniqueTips} unique positive tip values observed.`,
    },
    {
      level: reasoning === entries.length && entries.length > 0 ? "PASS" : reasoning > 0 ? "WARN" : "FAIL",
      name: "AI reasoning traces",
      detail: `${reasoning}/${entries.length} records include non-trivial reasoning.`,
    },
    {
      level: actions >= 2 ? "PASS" : actions === 1 ? "WARN" : "FAIL",
      name: "AI action diversity",
      detail: `${actions} distinct agentAction values observed.`,
    },
    {
      level: realSlots >= 10 ? "PASS" : realSlots > 0 ? "WARN" : "FAIL",
      name: "Slot evidence",
      detail: `${realSlots}/${entries.length} records include non-zero slot data.`,
    },
    {
      level: explorerUrls >= successes && successes > 0 ? "PASS" : explorerUrls > 0 ? "WARN" : "FAIL",
      name: "Explorer verification",
      detail: `${explorerUrls} records include explorer URLs for judge cross-checking.`,
    },
    {
      level: networkSnapshots >= 10 ? "PASS" : networkSnapshots > 0 ? "WARN" : "FAIL",
      name: "Network snapshots",
      detail: `${networkSnapshots}/${entries.length} records include NetworkSnapshot data.`,
    },
    {
      level: leaderWindows >= 10 ? "PASS" : leaderWindows > 0 ? "WARN" : "FAIL",
      name: "Leader-window context",
      detail: `${leaderWindows}/${entries.length} records include leader-window snapshots.`,
    },
    {
      level: p2cLatency >= 10 ? "PASS" : p2cLatency > 0 ? "WARN" : "FAIL",
      name: "Commitment latency deltas",
      detail: `${p2cLatency}/${entries.length} records include processed-to-confirmed latency.`,
    },
    {
      level: finalized > 0 ? "PASS" : "WARN",
      name: "Finalized-stage tracking",
      detail: `${finalized} records reached finalized stage. Confirmed-only records are acceptable but weaker.`,
    },
  ];

  const pass = checks.filter((c) => c.level === "PASS").length;
  const warn = checks.filter((c) => c.level === "WARN").length;
  const fail = checks.filter((c) => c.level === "FAIL").length;

  console.log("# Bounty Evidence Audit");
  console.log(`Records: ${entries.length} | PASS ${pass} | WARN ${warn} | FAIL ${fail}`);
  console.log("");
  for (const check of checks) {
    console.log(`${check.level.padEnd(4)}  ${check.name}: ${check.detail}`);
  }

  if (fail > 0) {
    console.error(`\nAudit failed with ${fail} blocking evidence issue(s). Fix the lifecycle log before final submission.`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}