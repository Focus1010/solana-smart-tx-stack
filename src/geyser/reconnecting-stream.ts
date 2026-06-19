import { EventEmitter } from "events";
import {
  createYellowstoneClient,
  isYellowstoneAvailable,
  baseSubscribeRequest,
  pingRequest,
  numericToSlotStatus,
  YS_DEAD,
  YS_PROCESSED,
  YS_CONFIRMED,
  YS_FINALIZED,
} from "./yellowstone-client";
import { Logger } from "../utils/logger";

// ReconnectingYellowstoneStream
// A production-grade wrapper around a Yellowstone gRPC slot subscription that
// handles all reconnection, keepalive, and backpressure concerns so upstream
// consumers only see clean 'data' events.
//
// Events emitted:
//   'connected'    -- emitted each time the gRPC stream is established
//   'disconnected' -- emitted when the stream closes (before any retry)
//   'data'         -- emitted for each raw slot update (pong frames are filtered)
//   'backpressure' -- emitted when bufferedEvents exceeds the high watermark
//   'error'        -- emitted on non-retryable errors
//   'fallback'     -- emitted when the native binding is missing or all retries
//                     are exhausted; signals callers to switch to SlotPoller
//
// Configuration:
//   endpoint          Yellowstone gRPC endpoint URL
//   token             Auth token (pass empty string if not required)
//   highWatermark     bufferedEvents threshold for backpressure emission (default 5000)
//   resumeWatermark   bufferedEvents level at which backpressure is considered
//                     resolved (default 2500); not enforced here but exposed so
//                     callers can decide when to resume
//   maxRetries        consecutive failures before emitting 'fallback' (default 3)

const PING_INTERVAL_MS = 30_000;
const BACKOFF_BASE_MS  = 1_000;
const BACKOFF_MAX_MS   = 16_000;

export interface ReconnectingStreamConfig {
  endpoint:        string;
  token:           string;
  highWatermark?:  number;
  resumeWatermark?: number;
  maxRetries?:     number;
}

export class ReconnectingYellowstoneStream extends EventEmitter {
  private readonly endpoint:       string;
  private readonly token:          string;
  private readonly highWatermark:  number;
  private readonly maxRetries:     number;

  private running          = false;
  private bufferedEvents   = 0;
  private consecutiveFails = 0;
  private lastProcessedSlot = 0;
  private pingId           = 1;
  private activeStream:    any = null;
  private pingTimer:       NodeJS.Timeout | null = null;
  private readonly logger: Logger;

  constructor(cfg: ReconnectingStreamConfig, logger: Logger) {
    super();
    this.endpoint      = cfg.endpoint;
    this.token         = cfg.token;
    this.highWatermark = cfg.highWatermark  ?? 5_000;
    this.maxRetries    = cfg.maxRetries     ?? 3;
    this.logger        = logger;
  }

  // Public accessors used by SlotStream to track high-water marks
  getLastProcessedSlot(): number { return this.lastProcessedSlot; }

  async start(): Promise<void> {
    if (!isYellowstoneAvailable()) {
      await this.logger.warn(
        "[reconnecting-stream] @triton-one/yellowstone-grpc native binding unavailable. " +
        "Emitting fallback."
      );
      this.emit("fallback");
      return;
    }

    if (!this.endpoint) {
      await this.logger.warn(
        "[reconnecting-stream] No Yellowstone endpoint configured. Emitting fallback."
      );
      this.emit("fallback");
      return;
    }

    this.running = true;
    this.runLoop().catch(async (err) => {
      await this.logger.warn("[reconnecting-stream] Run loop exited with error: " + String(err));
      this.emit("fallback");
    });
  }

  stop(): void {
    this.running = false;
    this.destroyActiveStream();
  }

  // Decrement buffered count so callers can track drain
  ack(): void {
    if (this.bufferedEvents > 0) {
      this.bufferedEvents--;
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.logger.info(
          `[reconnecting-stream] Connecting (attempt ${this.consecutiveFails + 1})...`
        );
        await this.subscribe();
        // Clean exit -- reset the failure counter
        this.consecutiveFails = 0;
      } catch (err) {
        this.consecutiveFails++;
        const msg = err instanceof Error ? err.message : String(err);
        await this.logger.warn(
          `[reconnecting-stream] Connection failed (${this.consecutiveFails}/${this.maxRetries}): ${msg}`
        );
        this.emit("disconnected");

        if (this.consecutiveFails >= this.maxRetries) {
          await this.logger.warn(
            `[reconnecting-stream] ${this.maxRetries} consecutive failures. Emitting fallback.`
          );
          this.running = false;
          this.emit("fallback");
          return;
        }
      }

      if (!this.running) break;

      const delay = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, this.consecutiveFails - 1),
        BACKOFF_MAX_MS
      );
      await this.logger.info(`[reconnecting-stream] Reconnecting in ${delay}ms...`);
      await sleep(delay);
    }
  }

  private async subscribe(): Promise<void> {
    const client = createYellowstoneClient(this.endpoint, this.token);
    await client.connect();

    const stream = await client.subscribe();
    this.activeStream = stream;

    return new Promise<void>((resolve, reject) => {
      this.clearPingTimer();

      // Ping keepalive -- must include all empty maps per Triton spec
      this.pingTimer = setInterval(() => {
        if (this.activeStream) {
          const frame = pingRequest(this.pingId++);
          this.activeStream.write(frame, () => {});
        }
      }, PING_INTERVAL_MS);

      stream.on("data", (data: any) => {
        // Filter pong frames
        if (data?.pong) return;
        if (!data?.slot) return;

        this.bufferedEvents++;

        if (this.bufferedEvents >= this.highWatermark) {
          this.emit("backpressure", { bufferedEvents: this.bufferedEvents });
        }

        const raw       = data.slot;
        const slot      = Number(raw.slot ?? 0);
        const parent    = Number(raw.parent ?? slot - 1);
        const statusNum = typeof raw.status === "number" ? raw.status : YS_PROCESSED;
        const status    = numericToSlotStatus(statusNum);

        if (statusNum === YS_PROCESSED && slot > this.lastProcessedSlot) {
          this.lastProcessedSlot = slot;
        }

        this.emit("data", { slot, parent, status, statusNum, timestamp: Date.now(), raw });
      });

      stream.on("error", (err: Error) => {
        this.clearPingTimer();
        this.destroyActiveStream();
        reject(err);
      });

      stream.on("end", () => {
        this.clearPingTimer();
        resolve();
      });

      stream.on("close", () => {
        this.clearPingTimer();
        resolve();
      });

      // Initial subscription request
      const fromSlot = this.lastProcessedSlot > 0
        ? String(this.lastProcessedSlot)
        : undefined;

      const request = baseSubscribeRequest("processed", fromSlot as any);

      stream.write(request, (err: Error | null | undefined) => {
        if (err) {
          this.clearPingTimer();
          reject(err);
        }
      });

      this.emit("connected");
    });
  }

  private destroyActiveStream(): void {
    if (this.activeStream) {
      try { this.activeStream.destroy(); } catch { /* ignore */ }
      this.activeStream = null;
    }
    this.clearPingTimer();
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}