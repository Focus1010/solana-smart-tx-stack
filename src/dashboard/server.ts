import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { buildDashboardSummary, readLifecycleEntries } from "./summary";
import type { LifecycleEntry } from "../types";

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "4317", 10);

function lifecyclePath(): string {
  return path.join(process.cwd(), "logs", "lifecycle.json");
}

function evidenceSummaryPath(): string {
  return path.join(process.cwd(), "evidence", "run-summary.json");
}

function loadEntries(): LifecycleEntry[] {
  const p = lifecyclePath();
  if (!fs.existsSync(p)) return [];
  try {
    return readLifecycleEntries(JSON.parse(fs.readFileSync(p, "utf-8")));
  } catch {
    return [];
  }
}

export function createDashboardApp(): express.Express {
  const app = express();

  const webRoot = path.join(process.cwd(), "web", "dashboard");
  app.use(express.static(webRoot));

  app.get("/api/summary", (_req, res) => {
    const evidencePath = evidenceSummaryPath();
    if (fs.existsSync(evidencePath)) {
      try {
        const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
        const entries  = loadEntries();
        const live     = buildDashboardSummary(entries);
        res.json({
          source: "evidence+live",
          evidence,
          live,
          summary: live,
        });
        return;
      } catch {
        /* fall through */
      }
    }

    const entries = loadEntries();
    res.json({ source: "lifecycle", summary: buildDashboardSummary(entries) });
  });

  app.get("/api/entries", (_req, res) => {
    const entries = loadEntries();
    const recent  = [...entries].reverse().slice(0, 50).map((e) => ({
      runId:           e.runId,
      finalStage:      e.finalStage,
      tipLamports:     e.tipLamports,
      failure:         e.failure,
      signature:       e.signature,
      bundleTxSignature: e.bundleTxSignature ?? null,
      explorerUrl:     e.explorerUrl,
      bundleExplorerUrl: e.bundleExplorerUrl ?? null,
      agentReasoning:  e.agentReasoning,
      agentConfidence: e.agentConfidence,
      agentDecision:   e.agentDecision ?? null,
      triggerEvent:    e.triggerEvent,
      submittedAtIso:  e.submittedAtIso,
      latencyMs:       e.latencyMs,
    }));
    res.json({ entries: recent, total: entries.length });
  });

  app.use((_req, res) => {
    res.sendFile(path.join(webRoot, "index.html"));
  });

  return app;
}

export function startDashboardServer(): void {
  const app = createDashboardApp();
  app.listen(PORT, () => {
    console.log(`[dashboard] listening on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startDashboardServer();
}
