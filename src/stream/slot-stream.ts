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

//  Yellowstone slot status constants 
// From the Dragon's Mouth proto: PROCESSED=0, CONFIRMED=1, FINALIZED=2
// Dead/skipped slots also appear and must be handled gracefully.

const YS_STATUS_PROCESSED  = 0;
const YS_STATUS_CONFIRMED   = 1;
const YS_STATUS_FINALIZED   = 2;

// Ping interval: some cloud providers close idle gRPC streams after 60s.
// Sending a ping every 30s keeps the connection alive.
const PING_INTERVAL_MS      = 30_000;

//  SlotStream 
// Production Yellowstone gRPC slot subscription.
//
// Features:
// - Correct endpoint format: https:// prefix required by SDK v5+
// - Ping/pong keepalive to prevent cloud provider stream drops
// - fromSlot replay on reconnect to avoid missing slots
// - Separate high-water marks for processed, confirmed, finalized
// - Exponential backoff reconnect, max 3 attempts before graceful fallback
// - Dead slot detection and logging

export class SlotStream extends EventEmitter {
  private logger:  Logger;
  private client:  Client | null = null;
  private running  = false;

  private latestProcessedSlot  = 0;
  private latestConfirmedSlot  = 0;
  private latestFinalizedSlot  = 0;
  private lastProcessedSlot    = 0;  // For fromSlot replay on reconnect
  private slotTimestamps:        number[] = [];
  private deadSlotsDetected      = 0;
  private readonly MAX_SLOT_HISTORY = 20;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  getCurrentSlot():          number   { return this.latestProcessedSlot;  }
  getLatestConfirmedSlot():  number   { return this.latestConfirmedSlot;  }
  getLatestFinalizedSlot():  number   { return this.latestFinalizedSlot;  }
  getRecentSlotTimes():      number[] { return [...this.slotTimestamps];   }
  getDeadSlotsDetected():    number   { return this.deadSlotsDetected;     }

  async start(): Promise<void> {
    if (!config.yellowstone.endpoint) {
      await this.logger.warn("[stream] YELLOWSTONE_ENDPOINT not set -- using SlotPoller fallback");
      return;
    }
    this.running = true;
    this.connectWithRetry().catch(async (err) => {
      await this.logger.warn("[stream] Stream permanently stopped: " + String(err));
      this.running = false;
    });
  }

  stop(): void {
    this.running = false;
    this.client  = null;
  }

  //  Reconnect loop with exponential backoff 

  private async connectWithRetry(): Promise<void> {
    let attempt = 0;

    while (this.running) {
      attempt++;
      try {
        await this.logger.info(`[stream] Connecting to Yellowstone (attempt ${attempt})...`);
        await this.subscribe();
        // subscribe() resolved cleanly -- stream ended, reset attempt counter
        attempt = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.logger.warn(`[stream] Connection lost: ${msg}`);

        if (attempt >= 3) {
          await this.logger.warn(
            "[stream] 3 consecutive failures -- falling back to RPC poller. " +
            "Stack continues normally."
          );
          this.running = false;
          this.emit("fallback");
          return;
        }

        this.emit("error", err);
      }

      if (!this.running) break;

      const delayMs = Math.min(1_000 * Math.pow(2, attempt - 1), 16_000);
      await this.logger.info(`[stream] Reconnecting in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  //  gRPC subscribe with ping keepalive and fromSlot replay 

  private async subscribe(): Promise<void> {
    // Per Triton docs: endpoint must include https:// prefix for SDK v5+
    const endpoint = config.yellowstone.endpoint.startsWith("http")
      ? config.yellowstone.endpoint
      : `https://${config.yellowstone.endpoint}`;

    this.client = new Client(
      endpoint,
      config.yellowstone.token || undefined,
      { "grpc.max_receive_message_length": 64 * 1024 * 1024 } as any
    );

    await this.client.connect();

    const stream = await this.client.subscribe();

    return new Promise<void>((resolve, reject) => {
      let pingTimer: NodeJS.Timeout | null = null;
      let pingId = 1;

      const cleanup = () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      };

      //  Ping keepalive 
      // Triton docs: send ping every 30s, server responds with pong.
      // Required to keep stream alive through cloud load balancers.

      pingTimer = setInterval(() => {
        const pingReq: SubscribeRequest = {
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

      //  Data handler 

      stream.on("data", (data: any) => {
        // Handle pong response
        if (data?.pong) return;

        if (!data?.slot) return;

        const raw       = data.slot;
        const slot      = Number(raw.slot);
        const parent    = Number(raw.parent ?? slot - 1);
        const statusNum = typeof raw.status === "number" ? raw.status : 0;
        const now       = Date.now();

        // Track dead slots
        if (statusNum === 6 /* SLOT_DEAD */) {
          this.deadSlotsDetected++;
          this.emit("slot", {
            slot, parent, status: "dead", timestamp: now,
          } as SlotEvent);
          return;
        }

        const status = this.numericToStatus(statusNum);

        // Update high-water marks per commitment level
        if (status === "processed" || statusNum === YS_STATUS_PROCESSED) {
          if (slot > this.latestProcessedSlot) {
            this.latestProcessedSlot = slot;
            this.lastProcessedSlot   = slot;
            if (this.slotTimestamps.length >= this.MAX_SLOT_HISTORY) {
              this.slotTimestamps.shift();
            }
            this.slotTimestamps.push(now);
          }
        }

        if (statusNum === YS_STATUS_CONFIRMED || status === "confirmed") {
          this.latestConfirmedSlot = Math.max(this.latestConfirmedSlot, slot);
        }

        if (statusNum === YS_STATUS_FINALIZED || status === "finalized") {
          // Per Triton docs: when a slot is finalized, mark all ancestors as
          // finalized too (quirk in how Geyser emits finalization events)
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

      //  Initial subscription request 
      // Subscribe to all slots. No filterByCommitment -- we want all levels
      // so we can track processed, confirmed, finalized independently.
      // fromSlot enables replay if reconnecting after a disconnect.

      const request: SubscribeRequest = {
        // "solana" is just a label for this filter -- the gRPC API keys
        // filters by an arbitrary string name. filterByCommitment: false
        // means we receive updates for ALL commitment levels (processed,
        // confirmed, finalized) so this stack can track each independently.
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
      // Enable replay from last seen slot on reconnect to avoid missing slots.
      // fromSlot is an int64 in the proto, represented as a string in JS to
      // avoid precision loss for large slot numbers.
      if (this.lastProcessedSlot > 0) {
        request.fromSlot = String(this.lastProcessedSlot);
      }

      stream.write(request, (err: Error | null | undefined) => {
        if (err) { cleanup(); reject(err); }
      });
    });
  }

  private numericToStatus(n: number): SlotEvent["status"] {
    if (n === YS_STATUS_FINALIZED) return "finalized";
    if (n === YS_STATUS_CONFIRMED) return "confirmed";
    // SLOT_DEAD check
    if (n === 6) return "dead";
    return "processed";
  }
}

//  SlotPoller 
// RPC fallback for when Yellowstone is unavailable.
// Polls getSlot() at all three commitment levels with cycle-based scheduling
// to avoid excessive RPC load.

export class SlotPoller extends EventEmitter {
  private connection:          Connection;
  private logger:              Logger;
  private latestProcessedSlot  = 0;
  private latestConfirmedSlot  = 0;
  private latestFinalizedSlot  = 0;
  private slotTimestamps:        number[] = [];
  private timer:                 NodeJS.Timeout | null = null;
  private pollCycle              = 0;
  private readonly MAX_SLOT_HISTORY  = 20;
  private readonly POLL_INTERVAL_MS  = 400;
  // Poll confirmed/finalized every 5 cycles (~2s) to reduce RPC load
  private readonly DEEP_POLL_EVERY   = 5;

  constructor(connection: Connection, logger: Logger) {
    super();
    this.connection = connection;
    this.logger     = logger;
  }

  getCurrentSlot():          number   { return this.latestProcessedSlot;  }
  getLatestConfirmedSlot():  number   { return this.latestConfirmedSlot;  }
  getLatestFinalizedSlot():  number   { return this.latestFinalizedSlot;  }
  getRecentSlotTimes():      number[] { return [...this.slotTimestamps];   }
  getDeadSlotsDetected():    number   { return 0; }

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
        // Transient RPC error -- continue polling
      }

      this.poll();
    }, this.POLL_INTERVAL_MS);
  }
}