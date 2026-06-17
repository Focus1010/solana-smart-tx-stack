import fs from "fs";
import path from "path";
import { LifecycleEntry } from "../types";

// Dynamic chalk import (ESM compatibility)
let _chalk: any = null;

async function getChalk() {
  if (_chalk) return _chalk;
  _chalk = (await import("chalk")).default;
  return _chalk;
}

//  Log levels 

export type LogLevel = "info" | "warn" | "error" | "success" | "debug" | "agent";

const LEVEL_LABELS: Record<LogLevel, string> = {
  info:    "INFO ",
  warn:    "WARN ",
  error:   "ERROR",
  success: "  OK ",
  debug:   "DEBUG",
  agent:   "  AI ",
};

export class Logger {
  private logDir: string;
  private sessionFile: string;
  private lifecycleFile: string;

  constructor(logDir: string) {
    this.logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.sessionFile   = path.join(logDir, `session-${ts}.log`);
    this.lifecycleFile = path.join(logDir, "lifecycle.json");

    // Safe initialization
    this.initializeLifecycleFile();
  }

  private initializeLifecycleFile(): void {
    try {
      if (!fs.existsSync(this.lifecycleFile) || fs.statSync(this.lifecycleFile).size === 0) {
        fs.writeFileSync(this.lifecycleFile, JSON.stringify([], null, 2));
      }
    } catch (err) {
      console.warn("[Logger] Could not initialize lifecycle file, will create on first write.");
    }
  }

  // Core logging
  async log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    const c = await getChalk();
    const now = new Date();
    const time = now.toISOString();
    const label = LEVEL_LABELS[level];

    const colorFn: Record<LogLevel, (s: string) => string> = {
      info:    c.cyan,
      warn:    c.yellow,
      error:   c.red,
      success: c.green,
      debug:   c.gray,
      agent:   c.magenta,
    };

    const colored = colorFn[level](`[${label}]`);
    const line = `${c.gray(time)} ${colored} ${message}`;

    console.log(line);
    if (meta && Object.keys(meta).length > 0) {
      console.log(c.gray("       " + JSON.stringify(meta)));
    }

    // Write to session log
    const plain = `${time} [${label}] ${message}${meta ? " " + JSON.stringify(meta) : ""}\n`;
    fs.appendFileSync(this.sessionFile, plain);
  }

  // Convenience methods
  info   = (msg: string, meta?: Record<string, unknown>) => this.log("info",    msg, meta);
  warn   = (msg: string, meta?: Record<string, unknown>) => this.log("warn",    msg, meta);
  error  = (msg: string, meta?: Record<string, unknown>) => this.log("error",   msg, meta);
  ok     = (msg: string, meta?: Record<string, unknown>) => this.log("success", msg, meta);
  debug  = (msg: string, meta?: Record<string, unknown>) => this.log("debug",   msg, meta);
  agent  = (msg: string, meta?: Record<string, unknown>) => this.log("agent",   msg, meta);

  // ==================== FIXED LIFECYCLE METHODS ====================

  appendLifecycle(entry: LifecycleEntry): void {
    let entries: LifecycleEntry[] = [];

    // Read existing data safely
    try {
      const raw = fs.readFileSync(this.lifecycleFile, "utf-8").trim();
      if (raw.length > 0) {
        entries = JSON.parse(raw) as LifecycleEntry[];
      }
    } catch (err: any) {
      console.warn(`[Logger] Lifecycle file read/parse failed, starting fresh.`, err.message);
      entries = [];
    }

    entries.push(entry);

    // Atomic write (temp file + rename)
    const tempPath = this.lifecycleFile + '.tmp';
    try {
      fs.writeFileSync(tempPath, JSON.stringify(entries, null, 2));
      fs.renameSync(tempPath, this.lifecycleFile);
    } catch (err) {
      console.error(`[Logger] Failed to write lifecycle file:`, err);
      // Fallback
      try {
        fs.writeFileSync(this.lifecycleFile, JSON.stringify(entries, null, 2));
      } catch (fallbackErr) {
        console.error(`[Logger] Critical: Could not save lifecycle data`, fallbackErr);
      }
    }
  }

  readLifecycle(): LifecycleEntry[] {
    try {
      const raw = fs.readFileSync(this.lifecycleFile, "utf-8").trim();
      if (raw.length === 0) return [];
      return JSON.parse(raw) as LifecycleEntry[];
    } catch (err: any) {
      console.warn(`[Logger] Could not read lifecycle file:`, err.message);
      return [];
    }
  }

  // Section dividers
  async divider(title?: string) {
    const c = await getChalk();
    const line = "=".repeat(60);
    if (title) {
      console.log(c.gray(`\n${line}`));
      console.log(c.white.bold(`  ${title}`));
      console.log(c.gray(`${line}\n`));
    } else {
      console.log(c.gray(line));
    }
  }
}