import { EventEmitter } from "events";
import { Connection }   from "@solana/web3.js";
import { SlotEvent }    from "../types";
import { Logger }       from "../utils/logger";
import { config }       from "../config";
import { ReconnectingYellowstoneStream } from "../geyser/reconnecting-stream";

// SlotStream
// Production Yellowstone gRPC slot subscription built on top of
// ReconnectingYellowstoneStream. All reconnection, ping keepalive, fromSlot
// replay, and backpressure logic live in the reconnecting wrapper; this class
// only translates raw geyser data events into typed SlotEvents and maintains
// the three commitment high-water marks the rest of the stack reads.
//
// If the Yellowstone native binding is absent or YELLOWSTONE_ENDPOINT is not
// set, start() emits 'fallback' immediately so the stack can switch to
// SlotPoller without any code changes in the orchestrator.

export class SlotStream extends EventEmitter {
  private readonly logger:  Logger;
  private inner:            ReconnectingYellowstoneStream | null = null;

  private latestProcessedSlot = 0;
  private latestConfirmedSlot = 0;
  private latestFinalizedSlot = 0;
  private slotTimestamps:      number[] = [];
  private deadSlotsDetected    = 0;
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
    const endpoint = config.yellowstone.endpoint;
    const token    = config.yellowstone.token;

    const stream = new ReconnectingYellowstoneStream(
      {
        endpoint,
        token,
        highWatermark:  parseInt(process.env.STREAM_HIGH_WATERMARK  ?? "5000", 10),
        resumeWatermark: parseInt(process.env.STREAM_RESUME_WATERMARK ?? "2500", 10),
        maxRetries:     3,
      },
      this.logger
    );

    this.inner = stream;

    // Forward fallback signal
    stream.on("fallback", () => {
      this.emit("fallback");
    });

    // Forward backpressure signal
    stream.on("backpressure", (info: { bufferedEvents: number }) => {
      this.emit("backpressure", info);
    });

    stream.on("connected", () => {
      this.logger.info("[stream] Yellowstone connected").catch(() => {});
    });

    stream.on("disconnected", () => {
      this.logger.info("[stream] Yellowstone disconnected").catch(() => {});
    });

    // Translate raw data events into typed SlotEvents
    stream.on("data", (raw: any) => {
      stream.ack();

      const { slot, parent, status, statusNum, timestamp } = raw as {
        slot: number;
        parent: number;
        status: SlotEvent["status"];
        statusNum: number;
        timestamp: number;
      };

      if (status === "dead") {
        this.deadSlotsDetected++;
        this.emit("slot", { slot, parent, status: "dead", timestamp } as SlotEvent);
        return;
      }

      // Update high-water marks
      if (status === "processed") {
        if (slot > this.latestProcessedSlot) {
          this.latestProcessedSlot = slot;
          if (this.slotTimestamps.length >= this.MAX_SLOT_HISTORY) {
            this.slotTimestamps.shift();
          }
          this.slotTimestamps.push(timestamp);
        }
      }

      if (status === "confirmed") {
        this.latestConfirmedSlot = Math.max(this.latestConfirmedSlot, slot);
      }

      if (status === "finalized") {
        this.latestFinalizedSlot = Math.max(this.latestFinalizedSlot, slot);
        this.latestConfirmedSlot = Math.max(this.latestConfirmedSlot, slot);
      }

      this.emit("slot", { slot, parent, status, timestamp } as SlotEvent);
    });

    await stream.start();
  }

  stop(): void {
    this.inner?.stop();
  }
}

// SlotPoller
// RPC fallback for when Yellowstone is unavailable or the native binding is
// missing on the current platform. Behaviour is unchanged from the previous
// implementation; this class is kept stable so all upstream consumers that
// listen for 'slot' events work identically regardless of which source is
// active.

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