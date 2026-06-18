import { EventEmitter } from "events";
import { Connection }   from "@solana/web3.js";
import { SlotEvent }    from "../types";
import { Logger }       from "../utils/logger";
import { sleep }        from "../utils/helpers";
import { config }       from "../config";

// ─── Yellowstone slot status constants ────────────────────────────────────────
// Dragon's Mouth proto: PROCESSED=0, CONFIRMED=1, FINALIZED=2

const YS_PROCESSED  = 0;
const YS_CONFIRMED  = 1;
const YS_FINALIZED  = 2;
const YS_DEAD       = 6;

// Ping interval -- keeps gRPC stream alive through cloud load balancers

const PING_INTERVAL_MS = 30_000;

// ─── Safe Yellowstone import ──────────────────────────────────────────────────
// @triton-one/yellowstone-grpc v5 uses a native Rust binding that may not be
// available on the current platform (e.g. Windows). We catch the import error
// and fall back to SlotPoller gracefully rather than crashing the process.

let YellowstoneClient: any  = null;
let YellowstoneCommitment: any = null;

try {
  const mod = require("@triton-one/yellowstone-grpc");
  YellowstoneClient     = mod.default ?? mod;
  YellowstoneCommitment = mod.CommitmentLevel;
} catch {
  // Native binding unavailable on this platform -- SlotPoller will be used
}

// ─── SlotStream ───────────────────────────────────────────────────────────────
// Production Yellowstone gRPC slot subscription.
//
// Correctness notes:
// - endpoint must have https:// prefix (SDK v5 requires it)
// - slots filter: { solana: { filterByCommitment: false } } -- "solana" is an
//   arbitrary label, filterByCommitment:false means we receive all levels
// - fromSlot must be a string (proto int64 serialized as string in JS)
// - Ping frame: must include full empty subscription fields alongside ping ID
// - Token is passed as the second constructor arg (no x-token header needed)
// - If native binding is unavailable, start() logs a warning and emits
//   "fallback" so the stack switches to SlotPoller automatically

export class SlotStream extends EventEmitter {
  private logger:  Logger;
  private client:  any    = null;
  private running  = false;

  private latestProcessedSlot = 0;
  private latestConfirmedSlot = 0;
  private latestFinalizedSlot = 0;
  private lastProcessedSlot   = 0;
  private slotTimestamps:       number[] = [];
  private deadSlotsDetected     = 0;
  private readonly MAX_SLOT_HISTORY = 20;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  getCurrentSlot():          number   { return this.latestProcessedSlot; }
  getLatestConfirmedSlot():  number   { return this.latestConfirmedSlot; }
  getLatestFinalizedSlot():  number   { return this.latestFinalizedSlot; }
  getRecentSlotTimes():      number[] { return [...this.slotTimestamps];  }
  getDeadSlotsDetected():    number   { return this.deadSlotsDetected;    }

  async start(): Promise<void> {
    if (!YellowstoneClient) {
      await this.logger.warn(
        "[stream] @triton-one/yellowstone-grpc native binding unavailable on this platform. " +
        "Falling back to RPC slot poller."
      );
      this.emit("fallback");
      return;
    }

    if (!config.yellowstone.endpoint) {
      await this.logger.warn("[stream] YELLOWSTONE_ENDPOINT not set -- using SlotPoller fallback");
      this.emit("fallback");
      return;
    }

    this.running = true;
    this.connectWithRetry().catch(async (err) => {
      await this.logger.warn("[stream] Stream permanently stopped: " + String(err));
      this.running = false;
      this.emit("fallback");
    });
  }

  stop(): void {
    this.running = false;
    this.client  = null;
  }

  // ── Reconnect with exponential backoff ────────────────────────────────────

  private async connectWithRetry(): Promise<void> {
    let attempt = 0;

    while (this.running) {
      attempt++;
      try {
        await this.logger.info(`[stream] Connecting to Yellowstone (attempt ${attempt})...`);
        await this.subscribe();
        // subscribe() returned cleanly -- reset counter
        attempt = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.logger.warn(`[stream] Connection lost: ${msg}`);

        if (attempt >= 3) {
          await this.logger.warn(
            "[stream] 3 consecutive failures -- falling back to RPC poller."
          );
          this.running = false;
          this.emit("fallback");
          return;
        }
      }

      if (!this.running) break;

      const delayMs = Math.min(1_000 * Math.pow(2, attempt - 1), 16_000);
      await this.logger.info(`[stream] Reconnecting in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  // ── Core gRPC subscription ────────────────────────────────────────────────

  private async subscribe(): Promise<void> {
    // SDK v5 requires https:// prefix
    const endpoint = config.yellowstone.endpoint.startsWith("http")
      ? config.yellowstone.endpoint
      : `https://${config.yellowstone.endpoint}`;

    this.client = new YellowstoneClient(
      endpoint,
      config.yellowstone.token || undefined,
      { "grpc.max_receive_message_length": 64 * 1024 * 1024 }
    );

    await this.client.connect();

    const stream = await this.client.subscribe();

    return new Promise<void>((resolve, reject) => {
      let pingTimer: NodeJS.Timeout | null = null;
      let pingId = 1;

      const cleanup = () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      };

      // Ping keepalive -- required to prevent cloud providers dropping the stream
      // Must include all empty subscription maps alongside ping, per Triton spec

      pingTimer = setInterval(() => {
        const pingReq = {
          ping:               { id: pingId++ },
          slots:              {},
          accounts:           {},
          transactions:       {},
          transactionsStatus: {},
          blocks:             {},
          blocksMeta:         {},
          entry:              {},
          accountsDataSlice:  [],
        };
        stream.write(pingReq, () => {});
      }, PING_INTERVAL_MS);

      // Data handler

      stream.on("data", (data: any) => {
        if (data?.pong) return;
        if (!data?.slot) return;

        const raw       = data.slot;
        const slot      = Number(raw.slot);
        const parent    = Number(raw.parent ?? slot - 1);
        const statusNum = typeof raw.status === "number" ? raw.status : YS_PROCESSED;
        const now       = Date.now();

        if (statusNum === YS_DEAD) {
          this.deadSlotsDetected++;
          this.emit("slot", { slot, parent, status: "dead", timestamp: now } as SlotEvent);
          return;
        }

        const status = this.numericToStatus(statusNum);

        if (statusNum === YS_PROCESSED) {
          if (slot > this.latestProcessedSlot) {
            this.latestProcessedSlot = slot;
            this.lastProcessedSlot   = slot;
            if (this.slotTimestamps.length >= this.MAX_SLOT_HISTORY) {
              this.slotTimestamps.shift();
            }
            this.slotTimestamps.push(now);
          }
        }

        if (statusNum === YS_CONFIRMED) {
          this.latestConfirmedSlot = Math.max(this.latestConfirmedSlot, slot);
        }

        if (statusNum === YS_FINALIZED) {
          this.latestFinalizedSlot = Math.max(this.latestFinalizedSlot, slot);
          this.latestConfirmedSlot = Math.max(this.latestConfirmedSlot, slot);
        }

        this.emit("slot", { slot, parent, status, timestamp: now } as SlotEvent);
      });

      stream.on("error", (err: Error) => {
        cleanup();
        stream.destroy();
        reject(err);
      });

      stream.on("end",   () => { cleanup(); resolve(); });
      stream.on("close", () => { cleanup(); resolve(); });

      // Initial subscription request
      // "solana" is just an arbitrary label for this slot filter slot.
      // filterByCommitment: false means we get all commitment levels.
      // fromSlot must be a string (int64 proto field).

      const request: any = {
        slots:              { solana: { filterByCommitment: false } },
        accounts:           {},
        transactions:       {},
        transactionsStatus: {},
        blocks:             {},
        blocksMeta:         {},
        entry:              {},
        commitment:         YellowstoneCommitment?.PROCESSED ?? 0,
        accountsDataSlice:  [],
        ping:               undefined,
      };

      if (this.lastProcessedSlot > 0) {
        request.fromSlot = String(this.lastProcessedSlot);
      }

      stream.write(request, (err: Error | null | undefined) => {
        if (err) { cleanup(); reject(err); }
      });
    });
  }

  private numericToStatus(n: number): SlotEvent["status"] {
    if (n === YS_FINALIZED) return "finalized";
    if (n === YS_CONFIRMED) return "confirmed";
    if (n === YS_DEAD)      return "dead";
    return "processed";
  }
}

// ─── SlotPoller ───────────────────────────────────────────────────────────────
// RPC fallback for when Yellowstone is unavailable or the native binding is
// missing on the current platform.

export class SlotPoller extends EventEmitter {
  private connection:          Connection;
  private logger:              Logger;
  private latestProcessedSlot = 0;
  private latestConfirmedSlot = 0;
  private latestFinalizedSlot = 0;
  private slotTimestamps:       number[] = [];
  private timer:                NodeJS.Timeout | null = null;
  private pollCycle             = 0;
  private readonly MAX_SLOT_HISTORY = 20;
  private readonly POLL_INTERVAL_MS = 400;
  private readonly DEEP_POLL_EVERY  = 5;

  constructor(connection: Connection, logger: Logger) {
    super();
    this.connection = connection;
    this.logger     = logger;
  }

  getCurrentSlot():          number   { return this.latestProcessedSlot; }
  getLatestConfirmedSlot():  number   { return this.latestConfirmedSlot; }
  getLatestFinalizedSlot():  number   { return this.latestFinalizedSlot; }
  getRecentSlotTimes():      number[] { return [...this.slotTimestamps];  }
  getDeadSlotsDetected():    number   { return 0;                         }

  async start(): Promise<void> {
    await this.logger.info("[poller] Starting RPC slot polling (Yellowstone fallback)");
    this.poll();
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
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

        if (this.pollCycle % this.DEEP_POLL_EVERY === 0) {
          const [confirmed, finalized] = await Promise.all([
            this.connection.getSlot("confirmed"),
            this.connection.getSlot("finalized"),
          ]);

          if (confirmed > this.latestConfirmedSlot) {
            this.latestConfirmedSlot = confirmed;
            this.emit("slot", {
              slot: confirmed, parent: confirmed - 1,
              status: "confirmed", timestamp: Date.now(),
            } as SlotEvent);
          }

          if (finalized > this.latestFinalizedSlot) {
            this.latestFinalizedSlot = finalized;
            this.emit("slot", {
              slot: finalized, parent: finalized - 1,
              status: "finalized", timestamp: Date.now(),
            } as SlotEvent);
          }
        }
      } catch {
        // Transient RPC error -- keep polling
      }

      this.poll();
    }, this.POLL_INTERVAL_MS);
  }
}
