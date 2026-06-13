import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { EventEmitter }                             from "events";
import { Logger }                                   from "../utils/logger";

// ─── Marinade Finance program address (mainnet) ───────────────────────────────
// Source: https://marinade.finance/developers

const MARINADE_PROGRAM_ID = new PublicKey(
  "MarBmsSgKXdrQP1zU937A8bLnSZ3xq4b5VW6dcjpyQ"
);

// Minimum SOL value to classify as a "large" event worth reacting to
const LARGE_EVENT_THRESHOLD_SOL = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

export type MarinadeEventType = "stake" | "unstake" | "merge" | "split";

export interface MarinadeLiquidStakingEvent {
  eventType:          MarinadeEventType;
  amountLamports:     number;
  amountSol:          number;
  msolAmountLamports: number;
  userWallet:         string;
  timestamp:          number;
  timestampIso:       string;
  signature:          string;
  slot:               number;
  isLargeEvent:       boolean;
}

// ─── MarinadeLiquidStakingListener ───────────────────────────────────────────
// Subscribes to Marinade Finance program logs via onLogs() and parses
// Deposit (stake) and Unstake events. Emits "event" on each parsed event
// and "large_event" when the amount exceeds LARGE_EVENT_THRESHOLD_SOL.
//
// Used in runWithMarinadeTriggering() to submit a Jito bundle in response to
// real-world DeFi activity on mainnet, demonstrating that the stack can
// operate as reactive infrastructure rather than just a scheduled runner.

export class MarinadeLiquidStakingListener extends EventEmitter {
  private connection:  Connection;
  private logger:      Logger;
  private events:      MarinadeLiquidStakingEvent[] = [];
  private subscriptionId: number | null = null;
  private readonly MAX_EVENTS = 100;

  constructor(connection: Connection, logger: Logger) {
    super();
    this.connection = connection;
    this.logger     = logger;
  }

  async startListening(): Promise<void> {
    await this.logger.info(
      "[marinade] Starting Marinade Finance event listener",
      { program: MARINADE_PROGRAM_ID.toBase58().slice(0, 12) + "..." }
    );

    this.subscriptionId = this.connection.onLogs(
      MARINADE_PROGRAM_ID,
      (logsResult) => {
        if (logsResult.err) return;
        this.parseMarinadeEvent(logsResult);
      },
      "confirmed"
    );
  }

  stopListening(): void {
    if (this.subscriptionId !== null) {
      this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }
  }

  getRecentEvents(limit: number = 10): MarinadeLiquidStakingEvent[] {
    return this.events.slice(-limit);
  }

  getLatestLargeEvent(): MarinadeLiquidStakingEvent | null {
    const largeEvents = this.events.filter((e) => e.isLargeEvent);
    return largeEvents.length > 0 ? largeEvents[largeEvents.length - 1] ?? null : null;
  }

  clearProcessedEvents(): void {
    this.events = [];
  }

  // ── Log parser ──────────────────────────────────────────────────────────────
  // Marinade emits structured program logs. We parse two patterns:
  //   Deposit:  "Program log: Depositing ... amount: X"
  //   Unstake:  "Program log: Unstaking ... amount: X"
  //
  // The exact log format varies across Marinade versions. We use multiple
  // pattern matches to stay robust across upgrades.

  private parseMarinadeEvent(logsResult: any): void {
    const lines: string[] = logsResult.logs ?? [];
    const sig    = logsResult.signature ?? "unknown";
    const slot   = logsResult.slot ?? 0;

    for (const line of lines) {
      if (!line.startsWith("Program log:")) continue;

      const lower = line.toLowerCase();

      // ── Deposit / stake event ──────────────────────────────────────────────
      if (lower.includes("deposit") || lower.includes("stake")) {
        const lamports = this.extractAmount(line);
        if (lamports === null || lamports <= 0) continue;

        const msolLamports = this.extractMsolAmount(line) ?? 0;
        const event        = this.buildEvent(
          "stake", lamports, msolLamports, sig, slot
        );
        this.pushEvent(event);
        return;
      }

      // ── Unstake event ──────────────────────────────────────────────────────
      if (lower.includes("unstake") || lower.includes("liquid_unstake")) {
        const lamports = this.extractAmount(line);
        if (lamports === null || lamports <= 0) continue;

        const event = this.buildEvent("unstake", lamports, 0, sig, slot);
        this.pushEvent(event);
        return;
      }
    }
  }

  private extractAmount(line: string): number | null {
    // Match patterns like: amount=1000000000 | amount: 1000000000 | lamports: 1000000000
    const patterns = [
      /amount[=:\s]+(\d+)/i,
      /lamports[=:\s]+(\d+)/i,
      /sol[=:\s]+([\d.]+)/i,
    ];

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        const raw = parseFloat(match[1]);
        // If value looks like SOL (< 1000), convert to lamports
        return raw < 1_000 ? Math.round(raw * LAMPORTS_PER_SOL) : Math.round(raw);
      }
    }
    return null;
  }

  private extractMsolAmount(line: string): number | null {
    const match = line.match(/msol[_\s]*amount[=:\s]+(\d+)/i);
    if (match?.[1]) return parseInt(match[1], 10);
    return null;
  }

  private buildEvent(
    eventType:          MarinadeEventType,
    amountLamports:     number,
    msolAmountLamports: number,
    signature:          string,
    slot:               number
  ): MarinadeLiquidStakingEvent {
    const amountSol = amountLamports / LAMPORTS_PER_SOL;
    return {
      eventType,
      amountLamports,
      amountSol,
      msolAmountLamports,
      userWallet:   "unknown",
      timestamp:    Date.now(),
      timestampIso: new Date().toISOString(),
      signature,
      slot,
      isLargeEvent: amountSol >= LARGE_EVENT_THRESHOLD_SOL,
    };
  }

  private async pushEvent(event: MarinadeLiquidStakingEvent): Promise<void> {
    if (this.events.length >= this.MAX_EVENTS) {
      this.events.shift();
    }
    this.events.push(event);

    await this.logger.info("[marinade] Event detected", {
      type:        event.eventType,
      amountSol:   event.amountSol.toFixed(2),
      isLarge:     event.isLargeEvent,
      sig:         event.signature.slice(0, 12) + "...",
      slot:        event.slot,
    });

    this.emit("event", event);

    if (event.isLargeEvent) {
      await this.logger.info("[marinade] Large event -- triggering bundle submission", {
        amountSol: event.amountSol.toFixed(2),
        type:      event.eventType,
      });
      this.emit("large_event", event);
    }
  }
}
