/**
 * Captures dashboard screenshots via Puppeteer.
 * Run: npm run dashboard:screenshot
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer");

const PORT = process.env.DASHBOARD_PORT || "4317";
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = path.join(process.cwd(), "docs", "screenshots");

async function waitForServer(ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(`${BASE}/api/summary`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Dashboard server did not become ready");
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let serverProc = null;
  const serverAlreadyUp = await fetch(`${BASE}/api/summary`)
    .then((r) => r.ok)
    .catch(() => false);

  if (!serverAlreadyUp) {
    serverProc = spawn(process.execPath, [path.join(process.cwd(), "dist", "dashboard", "server.js")], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: { ...process.env, DASHBOARD_PORT: PORT },
    });
    await waitForServer();
  }

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.waitForFunction("window.__DASHBOARD_READY === true", { timeout: 20000 });

  // 01 — overview (header + summary cards + chart)
  await page.screenshot({
    path: path.join(OUT_DIR, "01-overview.png"),
    fullPage: false,
  });

  // 02 — agent reasoning expanded (first row auto-selected)
  const reasoning = await page.$("#reasoning-section");
  if (reasoning) {
    await reasoning.scrollIntoView();
    await page.screenshot({
      path: path.join(OUT_DIR, "02-ai-reasoning.png"),
    });
  }

  // 03 — finalized table
  const table = await page.$("#finalized-table");
  if (table) {
    await table.scrollIntoView();
    await page.screenshot({
      path: path.join(OUT_DIR, "03-finalized-table.png"),
    });
  }

  await browser.close();

  if (serverProc) {
    serverProc.kill("SIGTERM");
  }

  console.log("[screenshot] Saved:");
  console.log("  docs/screenshots/01-overview.png");
  console.log("  docs/screenshots/02-ai-reasoning.png");
  console.log("  docs/screenshots/03-finalized-table.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
