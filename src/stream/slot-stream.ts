import Client, {
  CommitmentLevel as YellowstoneCommitment,
  SubscribeRequest,
} from "@triton-one/yellowstone-grpc";
import { EventEmitter } from "events";
import { SlotEvent } from "../types";
import { Logger } from "../utils/logger";
import { sleep } from "../utils/helpers";
import { config } from "../config";

// ─── SlotStream ───────────────────────────────────────────────────────────────
// Wraps the Yellowstone gRPC subscription in a reconnecting EventEmitter.
// Emits:
//   "slot"  → SlotEvent
//   "error" → Error
//   "close" → void

export class SlotStream extends EventEmitter {
  private logger: Logger;
  private client: Client | null = null;
  private running = false;
  private currentSlot = 0;
  private slotTimestamps: number[] = [];
  private readonly MAX_SLOT_HISTORY = 20;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getCurrentSlot(): number {
    return this.currentSlot;
  }

  getRecentSlotTimes(): number[] {
    return [...this.slotTimestamps];
  }

  async start(): Promise<void> {
    if (!config.yellowstone.endpoint) {
      await this.logger.warn(
        "[stream] YELLOWSTONE_ENDPOINT not set — use SlotPoller instead"
      );
      return;
    }

    this.running = true;
    // Run in background so a connection failure does not crash the process
    this.connectWithRetry().catch(async (err) => {
      await this.logger.warn("[stream] Yellowstone stream terminated: " + String(err));
    });
  }

  stop(): void {
    this.running = false;
    this.client = null;
  }

  // ── gRPC subscription ───────────────────────────────────────────────────────

  private async connectWithRetry(): Promise<void> {
    let attempt = 0;

    while (this.running) {
      attempt++;
      try {
        await this.logger.info(`[stream] Connecting to Yellowstone (attempt ${attempt})…`);
        await this.subscribe();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.logger.warn(`[stream] Connection lost: ${msg}`);

        // After 3 failed attempts, stop trying and let the stack run without it
        if (attempt >= 3) {
          await this.logger.warn(
            "[stream] Giving up on Yellowstone after 3 attempts — stack will continue without it"
          );
          this.running = false;
          return;
        }

        this.emit("error", err);
      }

      if (!this.running) break;

      const delay = Math.min(1000 * attempt, 15_000);
      await this.logger.info(`[stream] Reconnecting in ${delay}ms…`);
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
      throw new Error(`Yellowstone connect() failed: ${msg}. Check your endpoint and token.`);
    }

    const request: SubscribeRequest = {
      slots: { solana: { filterByCommitment: true } },
      accounts: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: YellowstoneCommitment.PROCESSED,
      accountsDataSlice: [],
      ping: undefined,
    };

    const stream = await this.client.subscribe();

    return new Promise<void>((resolve, reject) => {
      stream.on("data", (data: any) => {
        if (!data?.slot) return;

        const slot = Number(data.slot.slot);
        const now  = Date.now();

        if (this.slotTimestamps.length >= this.MAX_SLOT_HISTORY) {
          this.slotTimestamps.shift();
        }
        this.slotTimestamps.push(now);
        this.currentSlot = slot;

        const event: SlotEvent = {
          slot,
          parent: Number(data.slot.parent ?? slot - 1),
          status: this.mapStatus(data.slot.status),
          timestamp: now,
        };

        this.emit("slot", event);
      });

      stream.on("error", (err: Error) => {
        stream.destroy();
        reject(err);
      });

      stream.on("end", () => resolve());
      stream.on("close", () => resolve());

      // Send the subscription request
      stream.write(request, (err: Error | null | undefined) => {
        if (err) reject(err);
      });
    });
  }

  private mapStatus(raw: any): SlotEvent["status"] {
    const s = String(raw).toLowerCase();
    if (s.includes("root") || s.includes("finalized")) return "rooted";
    if (s.includes("confirmed")) return "confirmed";
    return "processed";
  }
}

// ─── RPC Slot Poller ──────────────────────────────────────────────────────────
// Fallback when no Yellowstone endpoint is configured.
// Polls getSlot() on a ~400ms interval, simulating the stream interface.

import { Connection } from "@solana/web3.js";

export class SlotPoller extends EventEmitter {
  private connection: Connection;
  private logger: Logger;
  private currentSlot = 0;
  private slotTimestamps: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly MAX_SLOT_HISTORY = 20;
  private readonly POLL_INTERVAL_MS = 400;

  constructor(connection: Connection, logger: Logger) {
    super();
    this.connection = connection;
    this.logger     = logger;
  }

  getCurrentSlot(): number {
    return this.currentSlot;
  }

  getRecentSlotTimes(): number[] {
    return [...this.slotTimestamps];
  }

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
        const slot = await this.connection.getSlot("processed");
        const now  = Date.now();

        if (slot !== this.currentSlot) {
          if (this.slotTimestamps.length >= this.MAX_SLOT_HISTORY) {
            this.slotTimestamps.shift();
          }
          this.slotTimestamps.push(now);
          this.currentSlot = slot;

          const event: SlotEvent = {
            slot,
            parent: slot - 1,
            status: "processed",
            timestamp: now,
          };
          this.emit("slot", event);
        }
      } catch {
        // Transient RPC error — just continue polling
      }
      this.poll();
    }, this.POLL_INTERVAL_MS);
  }
}
