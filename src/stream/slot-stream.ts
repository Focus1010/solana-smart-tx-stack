import Client, {
  CommitmentLevel as YellowstoneCommitment,
  SubscribeRequest,
} from "@triton-one/yellowstone-grpc";
import { EventEmitter } from "events";
import { Connection }   from "@solana/web3.js";
import { SlotEvent }    from "../types";
import { Logger }       from "../utils/logger";
import { sleep }        from "../utils/helpers";
import { config }       from "../config";

// ─── SlotStream ───────────────────────────────────────────────────────────────
// Yellowstone gRPC slot subscription with reconnect and backpressure handling.
// Tracks latestProcessedSlot, latestConfirmedSlot, and latestFinalizedSlot
// separately so CommitmentTracker can resolve purely from stream events.

export class SlotStream extends EventEmitter {
  private logger:   Logger;
  private client:   Client | null = null;
  private running = false;

  private latestProcessedSlot  = 0;
  private latestConfirmedSlot  = 0;
  private latestFinalizedSlot  = 0;
  private slotTimestamps:        number[] = [];
  private readonly MAX_SLOT_HISTORY = 20;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  getCurrentSlot():          number   { return this.latestProcessedSlot; }
  getLatestConfirmedSlot():  number   { return this.latestConfirmedSlot; }
  getLatestFinalizedSlot():  number   { return this.latestFinalizedSlot; }
  getRecentSlotTimes():      number[] { return [...this.slotTimestamps]; }

  async start(): Promise<void> {
    if (!config.yellowstone.endpoint) {
      await this.logger.warn("[stream] YELLOWSTONE_ENDPOINT not set — use SlotPoller");
      return;
    }
    this.running = true;
    this.connectWithRetry().catch(async (err) => {
      await this.logger.warn("[stream] Stream terminated: " + String(err));
    });
  }

  stop(): void {
    this.running = false;
    this.client  = null;
  }

  private async connectWithRetry(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      attempt++;
      try {
        await this.logger.info(`[stream] Connecting to Yellowstone (attempt ${attempt})...`);
        await this.subscribe();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.logger.warn(`[stream] Connection lost: ${msg}`);
        if (attempt >= 3) {
          await this.logger.warn("[stream] Giving up after 3 attempts — using RPC poller");
          this.running = false;
          return;
        }
        this.emit("error", err);
      }
      if (!this.running) break;
      const delay = Math.min(1000 * attempt, 15_000);
      await this.logger.info(`[stream] Reconnecting in ${delay}ms...`);
      await sleep(delay);
    }
  }

  private async subscribe(): Promise<void> {
    this.client = new Client(
      config.yellowstone.endpoint,
      config.yellowstone.token || undefined,
      { "grpc.max_receive_message_length": 64 * 1024 * 1024 } as any
    );

    try {
      await this.client.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Yellowstone connect() failed: ${msg}`);
    }

    const request: SubscribeRequest = {
      slots:              { solana: { filterByCommitment: false } },
      accounts:           {},
      transactions:       {},
      transactionsStatus: {},
      blocks:             {},
      blocksMeta:         {},
      entry:              {},
      commitment:         YellowstoneCommitment.PROCESSED,
      accountsDataSlice:  [],
      ping:               undefined,
    };

    const stream = await this.client.subscribe();

    return new Promise<void>((resolve, reject) => {
      stream.on("data", (data: any) => {
        if (!data?.slot) return;

        const slot   = Number(data.slot.slot);
        const now    = Date.now();
        const status = this.normalizeStatus(data.slot.status);

        // Track per-commitment high-water marks
        this.latestProcessedSlot = Math.max(this.latestProcessedSlot, slot);
        if (status === "confirmed") {
          this.latestConfirmedSlot = Math.max(this.latestConfirmedSlot, slot);
        }
        if (status === "finalized") {
          this.latestFinalizedSlot = Math.max(this.latestFinalizedSlot, slot);
          this.latestConfirmedSlot = Math.max(this.latestConfirmedSlot, slot);
        }

        if (this.slotTimestamps.length >= this.MAX_SLOT_HISTORY) {
          this.slotTimestamps.shift();
        }
        this.slotTimestamps.push(now);

        const event: SlotEvent = {
          slot,
          parent:    Number(data.slot.parent ?? slot - 1),
          status,
          timestamp: now,
        };
        this.emit("slot", event);
      });

      stream.on("error", (err: Error) => { stream.destroy(); reject(err); });
      stream.on("end",   () => resolve());
      stream.on("close", () => resolve());

      stream.write(request, (err: Error | null | undefined) => {
        if (err) reject(err);
      });
    });
  }

  private normalizeStatus(raw: any): SlotEvent["status"] {
    if (typeof raw === "number") {
      if (raw >= 2) return "finalized";
      if (raw === 1) return "confirmed";
      return "processed";
    }
    const s = String(raw ?? "").toLowerCase();
    if (s.includes("final") || s.includes("root")) return "finalized";
    if (s.includes("confirm"))                      return "confirmed";
    return "processed";
  }
}

// ─── SlotPoller ───────────────────────────────────────────────────────────────
// RPC fallback. Polls getSlot() and getEpochInfo() to track all three
// commitment levels without a gRPC connection.

export class SlotPoller extends EventEmitter {
  private connection:          Connection;
  private logger:              Logger;
  private latestProcessedSlot  = 0;
  private latestConfirmedSlot  = 0;
  private latestFinalizedSlot  = 0;
  private slotTimestamps:        number[] = [];
  private timer:                 NodeJS.Timeout | null = null;
  private readonly MAX_SLOT_HISTORY  = 20;
  private readonly POLL_INTERVAL_MS  = 400;
  private pollCycle                  = 0;

  constructor(connection: Connection, logger: Logger) {
    super();
    this.connection = connection;
    this.logger     = logger;
  }

  getCurrentSlot():          number   { return this.latestProcessedSlot; }
  getLatestConfirmedSlot():  number   { return this.latestConfirmedSlot; }
  getLatestFinalizedSlot():  number   { return this.latestFinalizedSlot; }
  getRecentSlotTimes():      number[] { return [...this.slotTimestamps]; }

  async start(): Promise<void> {
    await this.logger.info("[poller] Starting RPC slot polling (Yellowstone fallback)");
    this.poll();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private poll(): void {
    this.timer = setTimeout(async () => {
      try {
        this.pollCycle++;
        const processed = await this.connection.getSlot("processed");
        const now       = Date.now();

        if (processed !== this.latestProcessedSlot) {
          if (this.slotTimestamps.length >= this.MAX_SLOT_HISTORY) {
            this.slotTimestamps.shift();
          }
          this.slotTimestamps.push(now);
          this.latestProcessedSlot = processed;

          this.emit("slot", {
            slot: processed, parent: processed - 1,
            status: "processed", timestamp: now,
          } as SlotEvent);
        }

        // Poll confirmed and finalized every 5 cycles to reduce RPC load
        if (this.pollCycle % 5 === 0) {
          const [confirmed, finalized] = await Promise.all([
            this.connection.getSlot("confirmed"),
            this.connection.getSlot("finalized"),
          ]);
          this.latestConfirmedSlot = Math.max(this.latestConfirmedSlot, confirmed);
          this.latestFinalizedSlot = Math.max(this.latestFinalizedSlot, finalized);

          this.emit("slot", {
            slot: confirmed, parent: confirmed - 1,
            status: "confirmed", timestamp: Date.now(),
          } as SlotEvent);
          this.emit("slot", {
            slot: finalized, parent: finalized - 1,
            status: "finalized", timestamp: Date.now(),
          } as SlotEvent);
        }
      } catch {
        // Transient RPC error — keep polling
      }
      this.poll();
    }, this.POLL_INTERVAL_MS);
  }
}
