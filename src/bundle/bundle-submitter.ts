import { JitoJsonRpcClient } from "jito-js-rpc";
import { Connection, Transaction } from "@solana/web3.js";
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
// Sends a Jito bundle via the JSON-RPC block engine API, then polls
// getInflightBundleStatuses for confirmation.
//
// Key correctness notes (source: Jito docs + jito-js-rpc source):
//
// 1. Transactions must be base58-encoded (NOT base64).
//    The block engine API uses the same wire format as sendTransaction.
//
// 2. sendBundle(params) expects params = [[tx1, tx2, ...]] -- an array
//    containing ONE array of encoded transactions.
//    jito-js-rpc wraps this in { params: [[...]] } for you.
//
// 3. No auth key is required for public endpoints. The JitoJsonRpcClient
//    constructor second argument is the uuid for priority access; leave
//    empty ("") for the public rate-limited tier.
//
// 4. Jito does NOT operate on devnet. On devnet JITO_RPC_URL should point
//    to a testnet block engine (https://dallas.testnet.block-engine.jito.wtf/api/v1)
//    or submissions will fail with NOTFOUND. This is expected behaviour and
//    the stack logs it clearly rather than crashing.

export class BundleSubmitter {
  private jitoClient: JitoJsonRpcClient;
  private connection: Connection;
  private logger:     Logger;

  // How long to poll for inflight bundle status after submission
  private readonly POLL_TIMEOUT_MS  = 30_000;
  private readonly POLL_INTERVAL_MS = 2_000;

  constructor(connection: Connection, logger: Logger) {
    this.connection = connection;
    this.logger     = logger;
    // Second arg is uuid for priority tier; empty string uses public tier
    this.jitoClient = new JitoJsonRpcClient(config.jito.rpcUrl, "");
  }

  async submit(built: BuiltBundle, currentSlot: number): Promise<SubmitResult> {
    const submittedAt = Date.now();
    const sig         = this.extractSignatureBase58(built.transaction);

    await this.logger.info("[submitter] Sending bundle to Jito block engine", {
      url:    config.jito.rpcUrl,
      tip:    built.tipLamports,
      sig:    shortKey(sig),
      slot:   currentSlot,
    });

    try {
      // Serialize to base58 -- this is the required encoding for Jito's
      // sendBundle API (same as the Solana wire transaction format)
      const encodedTxs = this.serializeToBase58(built);

      // sendBundle expects [[tx1, tx2, ...]] as params
      // jito-js-rpc's sendBundle(params) sends { params: params } directly
      const response = await this.jitoClient.sendBundle([encodedTxs]);

      if (response?.result) {
        const bundleId = response.result as string;
        await this.logger.ok("[submitter] Bundle accepted by block engine", {
          bundleId: bundleId.slice(0, 16) + "...",
          sig:      shortKey(sig),
        });

        // Poll for landing confirmation
        const landed = await this.pollBundleStatus(bundleId);

        return {
          success:          landed,
          bundleId,
          signature:        sig,
          failure:          landed ? null : "BUNDLE_DROPPED",
          slotAtSubmission: currentSlot,
          submittedAt,
        };
      }

      // Block engine returned a JSON-RPC error in response.error
      const failure = this.classifyJitoError(response?.error);
      await this.logger.warn("[submitter] Bundle rejected by block engine", {
        failure,
        error: JSON.stringify(response?.error ?? "no error body").slice(0, 200),
      });

      return {
        success:          false,
        bundleId:         null,
        signature:        sig,
        failure,
        slotAtSubmission: currentSlot,
        submittedAt,
      };

    } catch (err) {
      const failure = this.classifyException(err);
      const msg     = err instanceof Error ? err.message : String(err);

      await this.logger.warn("[submitter] Bundle submission threw", {
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

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private serializeToBase58(built: BuiltBundle): string[] {
    return [built.transaction].map((tx: Transaction) =>
      bs58.encode(tx.serialize())
    );
  }

  private extractSignatureBase58(tx: Transaction): string {
    if (tx.signatures.length > 0 && tx.signatures[0].signature) {
      return bs58.encode(tx.signatures[0].signature);
    }
    return "unknown";
  }

  // Poll getInflightBundleStatuses until the bundle lands, fails, or times out.
  // Returns true if landed, false otherwise.

  private async pollBundleStatus(bundleId: string): Promise<boolean> {
    const deadline = Date.now() + this.POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const resp = await this.jitoClient.getInFlightBundleStatuses([[bundleId]]);
        const statuses = resp?.result?.value ?? [];

        if (statuses.length > 0) {
          const status = statuses[0].status as string;
          const landedSlot = statuses[0].landed_slot as number | null;

          await this.logger.debug("[submitter] Bundle inflight status", {
            bundleId: bundleId.slice(0, 12) + "...",
            status,
            landedSlot,
          });

          if (status === "Landed") {
            await this.logger.ok("[submitter] Bundle landed", {
              bundleId:   bundleId.slice(0, 12) + "...",
              landedSlot,
            });
            return true;
          }

          if (status === "Failed") {
            await this.logger.warn("[submitter] Bundle failed on-chain", {
              bundleId: bundleId.slice(0, 12) + "...",
            });
            return false;
          }

          // "Pending" or "Invalid" -- keep polling
        }
      } catch {
        // Transient polling error -- keep trying
      }

      await sleep(this.POLL_INTERVAL_MS);
    }

    await this.logger.warn("[submitter] Bundle status poll timed out", {
      bundleId: bundleId.slice(0, 12) + "...",
    });
    return false;
  }

  private classifyJitoError(error: unknown): FailureReason {
    if (!error) return "UNKNOWN";
    const msg = JSON.stringify(error).toLowerCase();

    if (msg.includes("blockhash") || msg.includes("expired"))              return "EXPIRED_BLOCKHASH";
    if (msg.includes("tip") && msg.includes("1000"))                       return "FEE_TOO_LOW";
    if (msg.includes("fee") || msg.includes("tip"))                        return "FEE_TOO_LOW";
    if (msg.includes("compute") || msg.includes("exceeded"))               return "COMPUTE_EXCEEDED";
    if (msg.includes("dropped") || msg.includes("no connected leader"))    return "BUNDLE_DROPPED";
    if (msg.includes("simulation") || msg.includes("preflight"))           return "SIMULATION_FAILED";
    if (msg.includes("not found") || msg.includes("notfound"))             return "BUNDLE_DROPPED";
    if (msg.includes("429") || msg.includes("rate"))                       return "RATE_LIMITED";

    return "UNKNOWN";
  }

  private classifyException(err: unknown): FailureReason {
    if (!(err instanceof Error)) return "UNKNOWN";
    const msg = err.message.toLowerCase();

    if (msg.includes("blockhash"))                                          return "EXPIRED_BLOCKHASH";
    if (msg.includes("tip") && msg.includes("1000"))                       return "FEE_TOO_LOW";
    if (msg.includes("insufficient") || msg.includes("fee"))               return "FEE_TOO_LOW";
    if (msg.includes("compute"))                                            return "COMPUTE_EXCEEDED";
    if (msg.includes("timeout") || msg.includes("timed out"))              return "TIMEOUT";
    if (msg.includes("network") || msg.includes("econnrefused"))           return "BUNDLE_DROPPED";
    if (msg.includes("not found") || msg.includes("notfound"))             return "BUNDLE_DROPPED";
    if (msg.includes("429") || msg.includes("rate"))                       return "RATE_LIMITED";

    return "UNKNOWN";
  }
}
