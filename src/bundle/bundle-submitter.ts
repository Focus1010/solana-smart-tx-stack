import { Connection, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { BuiltBundle } from "./bundle-builder";
import { FailureReason } from "../types";
import { Logger } from "../utils/logger";
import { shortKey, sleep } from "../utils/helpers";
import { config } from "../config";

// ─── Submission result ────────────────────────────────────────────────────────

export interface SubmitResult {
  success:          boolean;
  bundleId:         string | null;
  signature:        string | null;
  failure:          FailureReason | null;
  slotAtSubmission: number;
  submittedAt:      number;
}

// ─── BundleSubmitter ──────────────────────────────────────────────────────────
// Sends a Jito bundle via direct fetch to the block engine JSON-RPC API.
//
// Why fetch instead of jito-js-rpc SDK?
//   The SDK encodes transactions as base58 (deprecated). Jito still accepts
//   the request and returns a bundleId, but silently drops the bundle --
//   every poll returns Invalid. Using fetch gives us direct control over
//   encoding (base64) and removes the SDK's internal axios 429-spam loop.
//
// Why a regional endpoint?
//   mainnet.block-engine.jito.wtf is load-balanced across multiple servers.
//   sendBundle may hit server A; getInflightBundleStatuses may hit server B.
//   Server B has no record of the bundle -> returns Invalid immediately.
//   Pinning to one regional endpoint (frankfurt for EU/Africa latency)
//   guarantees both calls reach the same cluster.
//   Override with JITO_RPC_URL env var if you want a different region:
//     frankfurt: https://frankfurt.mainnet.block-engine.jito.wtf/api/v1
//     amsterdam: https://amsterdam.mainnet.block-engine.jito.wtf/api/v1
//     ny:        https://ny.mainnet.block-engine.jito.wtf/api/v1
//     tokyo:     https://tokyo.mainnet.block-engine.jito.wtf/api/v1
//
// Encoding: base64 required. base58 is deprecated.
//
// Endpoint layout (both methods use /api/v1/bundles):
//   sendBundle                -> POST /api/v1/bundles
//   getInflightBundleStatuses -> POST /api/v1/bundles

// Default to Frankfurt -- closest block engine to Nigeria/EU.
// User can override via JITO_RPC_URL in .env.
const DEFAULT_REGIONAL = "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1";

const BUNDLES_URL = (() => {
  const base = (config.jito.rpcUrl || DEFAULT_REGIONAL)
    .replace(/\/(bundles|transactions)\/?$/, "");
  return `${base}/bundles`;
})();

export class BundleSubmitter {
  private connection: Connection;
  private logger:     Logger;

  private readonly POLL_TIMEOUT_MS  = 30_000;
  private readonly POLL_INTERVAL_MS = 4_000;

  constructor(connection: Connection, logger: Logger) {
    this.connection = connection;
    this.logger     = logger;
  }

  async submit(built: BuiltBundle, currentSlot: number): Promise<SubmitResult> {
    const submittedAt = Date.now();
    const sig         = this.extractSignature(built.transaction);

    await this.logger.info("[submitter] Sending bundle to Jito block engine", {
      url:    BUNDLES_URL,
      tip:    built.tipLamports,
      sig:    shortKey(sig),
      slot:   currentSlot,
    });

    try {
      const encoded  = this.encodeBase64(built.transaction);
      const bundleId = await this.sendBundle(encoded);

      await this.logger.ok("[submitter] Bundle accepted by block engine", {
        bundleId: bundleId.slice(0, 16) + "...",
        sig:      shortKey(sig),
      });

      const landed = await this.pollBundleStatus(bundleId);

      return {
        success:          landed,
        bundleId,
        signature:        sig,
        failure:          landed ? null : "BUNDLE_DROPPED",
        slotAtSubmission: currentSlot,
        submittedAt,
      };

    } catch (err) {
      const failure = this.classifyException(err);
      const msg     = err instanceof Error ? err.message : String(err);

      await this.logger.warn("[submitter] Bundle submission failed", {
        failure,
        message: msg.slice(0, 200),
      });

      return {
        success:          false,
        bundleId:         null,
        signature:        sig,
        failure,
        slotAtSubmission: currentSlot,
        submittedAt,
      };
    }
  }

  // ── Core RPC calls ─────────────────────────────────────────────────────────

  private async sendBundle(encodedTx: string): Promise<string> {
    const body = {
      jsonrpc: "2.0",
      id:      1,
      method:  "sendBundle",
      params:  [[encodedTx], { encoding: "base64" }],
    };

    const res = await fetch(BUNDLES_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`sendBundle HTTP ${res.status}: ${await res.text()}`);
    }

    const json = await res.json() as { result?: string; error?: { message: string } };

    if (json.error) throw new Error(`sendBundle RPC error: ${json.error.message}`);
    if (!json.result) throw new Error("sendBundle returned no bundleId");

    return json.result;
  }

  private async pollBundleStatus(bundleId: string): Promise<boolean> {
    const deadline = Date.now() + this.POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(this.POLL_INTERVAL_MS);

      try {
        const body = {
          jsonrpc: "2.0",
          id:      1,
          method:  "getInflightBundleStatuses",
          params:  [[bundleId]],
        };

        const res = await fetch(BUNDLES_URL, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });

        if (!res.ok) {
          await this.logger.debug("[submitter] Status poll non-200", { status: res.status });
          continue;
        }

        const json = await res.json() as {
          result?: { value?: Array<{ status: string; landed_slot: number | null }> };
        };

        const statuses = json.result?.value ?? [];
        if (statuses.length === 0) continue;

        const { status, landed_slot } = statuses[0];

        await this.logger.debug("[submitter] Bundle inflight status", {
          bundleId:   bundleId.slice(0, 12) + "...",
          status,
          landedSlot: landed_slot,
        });

        if (status === "Landed") {
          await this.logger.ok("[submitter] Bundle landed", {
            bundleId:   bundleId.slice(0, 12) + "...",
            landedSlot: landed_slot,
          });
          return true;
        }

        if (status === "Failed") {
          await this.logger.warn("[submitter] Bundle failed on-chain", {
            bundleId: bundleId.slice(0, 12) + "...",
          });
          return false;
        }

        // "Invalid" = bundle ID no longer in this server's 5-min window.
        // At 4s poll this means the bundle lost the auction or was never
        // forwarded to the validator. Either way it won't land -- bail early.
        if (status === "Invalid") {
          await this.logger.warn("[submitter] Bundle dropped (lost auction or expired)", {
            bundleId: bundleId.slice(0, 12) + "...",
          });
          return false;
        }

        // "Pending" -- keep polling
      } catch {
        // Transient network error -- keep polling
      }
    }

    await this.logger.warn("[submitter] Bundle status poll timed out", {
      bundleId: bundleId.slice(0, 12) + "...",
    });
    return false;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private encodeBase64(tx: VersionedTransaction): string {
    return Buffer.from(tx.serialize()).toString("base64");
  }

  private extractSignature(tx: VersionedTransaction): string {
    if (tx.signatures.length > 0 && tx.signatures[0]) {
      return bs58.encode(tx.signatures[0]);
    }
    return "unknown";
  }

  private classifyException(err: unknown): FailureReason {
    if (!(err instanceof Error)) return "UNKNOWN";
    const msg = err.message.toLowerCase();

    if (msg.includes("blockhash"))                              return "EXPIRED_BLOCKHASH";
    if (msg.includes("tip") || msg.includes("fee"))            return "FEE_TOO_LOW";
    if (msg.includes("compute"))                               return "COMPUTE_EXCEEDED";
    if (msg.includes("timeout") || msg.includes("timed out")) return "TIMEOUT";
    if (msg.includes("429") || msg.includes("rate"))          return "RATE_LIMITED";
    if (msg.includes("not found") || msg.includes("dropped")) return "BUNDLE_DROPPED";

    return "UNKNOWN";
  }
}