import fs from "fs";
import path from "path";
import { LifecycleEntry } from "../types";

// We load chalk dynamically because it ships as pure ESM in v5.
// Using require() here lets us stay in CommonJS without ejecting.
let _chalk: any = null;

async function getChalk() {
  if (_chalk) return _chalk;
  // chalk v5 is ESM-only; dynamic import works from CJS in Node 22
  _chalk = (await import("chalk")).default;
  return _chalk;
}

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
    this.sessionFile = path.join(logDir, `session-${ts}.log`);
    this.lifecycleFile = path.join(logDir, "lifecycle.json");

    // Initialize lifecycle file if missing
    if (!fs.existsSync(this.lifecycleFile)) {
      fs.writeFileSync(this.lifecycleFile, JSON.stringify([], null, 2));
    }
  }

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

    // Write to session log (plain, no ANSI)
    const plain = `${time} [${label}] ${message}${meta ? " " + JSON.stringify(meta) : ""}\n`;
    fs.appendFileSync(this.sessionFile, plain);
  }

  info = (msg: string, meta?: Record<string, unknown>) => this.log("info", msg, meta);
  warn = (msg: string, meta?: Record<string, unknown>) => this.log("warn", msg, meta);
  error = (msg: string, meta?: Record<string, unknown>) => this.log("error", msg, meta);
  ok = (msg: string, meta?: Record<string, unknown>) => this.log("success", msg, meta);
  debug = (msg: string, meta?: Record<string, unknown>) => this.log("debug", msg, meta);
  agent = (msg: string, meta?: Record<string, unknown>) => this.log("agent", msg, meta);

  appendLifecycle(entry: LifecycleEntry): void {
    const raw = fs.readFileSync(this.lifecycleFile, "utf-8");
    const entries = JSON.parse(raw) as LifecycleEntry[];
    entries.push(entry);
    fs.writeFileSync(this.lifecycleFile, JSON.stringify(entries, null, 2));
  }

  readLifecycle(): LifecycleEntry[] {
    const raw = fs.readFileSync(this.lifecycleFile, "utf-8");
    return JSON.parse(raw) as LifecycleEntry[];
  }

  async divider(title?: string) {
    const c = await getChalk();
    const line = "=" .repeat(60);
    if (title) {
      console.log(c.gray(`\n${line}`));
      console.log(c.white.bold(`  ${title}`));
      console.log(c.gray(`${line}\n`));
    } else {
      console.log(c.gray(line));
    }
  }
}
