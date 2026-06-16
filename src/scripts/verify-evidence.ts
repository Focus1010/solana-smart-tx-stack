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
  const mainnetRecords = count(entries, (e) => e.explorerUrl?.includes("mainnet-beta") ?? false);
  const devnetRecords = count(entries, (e) => e.explorerUrl?.includes("devnet") ?? false);
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
  const traces = count(entries, (e) => (e.agentDecisionTrace?.length ?? 0) > 0);
  const decisionFamilies = new Set(entries.flatMap((e) => (e.agentDecisionTrace ?? []).map((d) => d.decisionType)));
  const blockhashRecovery = count(entries, (e) =>
    e.failure === "EXPIRED_BLOCKHASH" &&
    (e.agentDecisionTrace ?? []).some((d) => d.refreshBlockhash || d.action === "retry_refresh_blockhash")
  );
  const jitoBundleIds = count(entries, (e) => hasText(e.bundleId));
  const marinadeTriggered = count(entries, (e) => e.triggerEvent?.type === "marinade_staking");

  const pct = (value: number) => entries.length === 0 ? 0 : value / entries.length;

  const checks: Check[] = [
    {
      level: entries.length >= 40 ? "PASS" : entries.length >= 10 ? "WARN" : "FAIL",
      name: "10/10 lifecycle volume",
      detail: `${entries.length} total records; target is 40+ across devnet and mainnet.`,
    },
    {
      level: mainnetRecords >= 10 ? "PASS" : mainnetRecords > 0 ? "WARN" : "FAIL",
      name: "Mainnet evidence",
      detail: `${mainnetRecords} mainnet-beta records with explorer URLs; target is 10+.`,
    },
    {
      level: devnetRecords >= 10 ? "PASS" : devnetRecords > 0 ? "WARN" : "FAIL",
      name: "Devnet evidence",
      detail: `${devnetRecords} devnet records with explorer URLs; target is 10+.`,
    },
    {
      level: successes >= 10 ? "PASS" : successes > 0 ? "WARN" : "FAIL",
      name: "Successful submissions",
      detail: `${successes} confirmed/finalized records.`,
    },
    {
      level: classifiedFailures.length >= 5 ? "PASS" : classifiedFailures.length >= 2 ? "WARN" : "FAIL",
      name: "Classified failures",
      detail: `${classifiedFailures.length} classified failure records; target is 5+.`,
    },
    {
      level: distinctFailures >= 3 ? "PASS" : classifiedFailures.length >= 2 ? "WARN" : "FAIL",
      name: "Failure diversity",
      detail: `${distinctFailures} distinct classified failure types observed; target is 3+.`,
    },
    {
      level: faultRuns >= 1 ? "PASS" : "WARN",
      name: "Fault injection marker",
      detail: `${faultRuns} records include faultInjected metadata; rerun npm run run:inject if this is 0.`,
    },
    {
      level: uniqueTips >= 5 ? "PASS" : uniqueTips > 1 ? "WARN" : "FAIL",
      name: "Dynamic tip evidence",
      detail: `${uniqueTips} unique positive tip values observed; target is 5+.`,
    },
    {
      level: reasoning === entries.length && entries.length > 0 ? "PASS" : reasoning > 0 ? "WARN" : "FAIL",
      name: "AI reasoning traces",
      detail: `${reasoning}/${entries.length} records include non-trivial reasoning.`,
    },
    {
      level: pct(traces) >= 0.9 ? "PASS" : traces > 0 ? "WARN" : "FAIL",
      name: "Structured AI decision traces",
      detail: `${traces}/${entries.length} records include agentDecisionTrace; families: ${[...decisionFamilies].join(", ") || "none"}.`,
    },
    {
      level: blockhashRecovery >= 1 ? "PASS" : "FAIL",
      name: "Blockhash recovery proof",
      detail: `${blockhashRecovery} EXPIRED_BLOCKHASH records include refresh-blockhash retry trace.`,
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
      level: successes > 0 && explorerUrls >= successes ? "PASS" : explorerUrls > 0 ? "WARN" : "FAIL",
      name: "Explorer verification",
      detail: `${explorerUrls} records include explorer URLs for judge cross-checking.`,
    },
    {
      level: pct(networkSnapshots) >= 0.9 ? "PASS" : networkSnapshots > 0 ? "WARN" : "FAIL",
      name: "Network snapshots",
      detail: `${networkSnapshots}/${entries.length} records include NetworkSnapshot data.`,
    },
    {
      level: pct(leaderWindows) >= 0.9 ? "PASS" : leaderWindows > 0 ? "WARN" : "FAIL",
      name: "Leader-window context",
      detail: `${leaderWindows}/${entries.length} records include leader-window snapshots.`,
    },
    {
      level: pct(p2cLatency) >= 0.9 ? "PASS" : p2cLatency > 0 ? "WARN" : "FAIL",
      name: "Commitment latency deltas",
      detail: `${p2cLatency}/${entries.length} records include processed-to-confirmed latency.`,
    },
    {
      level: jitoBundleIds >= 5 ? "PASS" : jitoBundleIds > 0 ? "WARN" : "FAIL",
      name: "Mainnet Jito bundle IDs",
      detail: `${jitoBundleIds} records include bundleId; target is 5+ accepted mainnet Jito attempts.`,
    },
    {
      level: marinadeTriggered > 0 ? "PASS" : "WARN",
      name: "Reactive Marinade trigger",
      detail: `${marinadeTriggered} records were triggered by Marinade events. Optional, but strong differentiator.`,
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
