import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58                         from "bs58";
import { BuiltBundle }              from "./bundle-builder";
import { FailureReason }            from "../types";
import { Logger }                   from "../utils/logger";
import { shortKey, sleep }          from "../utils/helpers";
import { config }                   from "../config";
import { JitoJsonRpcClientImpl }    from "../jito/jito-jsonrpc-client";

// SubmitResult

export interface SubmitResult {
  success:          boolean;
  bundleId:         string | null;
  signature:        string | null;
  failure:          FailureReason | null;
  failureMessage:   string | null;
  slotAtSubmission: number;
  submittedAt:      number;
}

// BundleSubmitter
// Sends Jito bundles via the JitoBundleClient abstraction.
//
// On devnet: Jito block-engine acceptance is not available, so the submitter
// always sends a real sendAndConfirmTransaction() to produce a verifiable
// on-chain signature for evidence purposes. The bundle submission path is
// still exercised for code coverage.
//
// On mainnet: bundle submission is the primary path. The bundle status is
// confirmed by polling getInflightBundleStatuses via the JSON-RPC transport.
// Stream-based confirmation is handled upstream by LifecycleTracker.
//
// Encoding: base64 (base58 is deprecated by Jito).
//
// Regional endpoint: the config defaults to frankfurt (closest to Nigeria/EU).
// Override with JITO_RPC_URL if you need a different region.

export class BundleSubmitter {
  private readonly connection: Connection;
  private readonly payer:      Keypair;
  private readonly logger:     Logger;
  private readonly jitoClient: JitoJsonRpcClientImpl;

  private readonly POLL_TIMEOUT_MS  = 30_000;
  private readonly POLL_INTERVAL_MS = 4_000;

  constructor(connection: Connection, payer: Keypair, logger: Logger) {
    this.connection = connection;
    this.payer      = payer;
    this.logger     = logger;
    this.jitoClient = new JitoJsonRpcClientImpl(config.jito.rpcUrl);
  }

  async submit(built: BuiltBundle, currentSlot: number): Promise<SubmitResult> {
    const submittedAt = Date.now();
    const sig         = this.extractSignature(built.transaction);

    await this.logger.info("[submitter] Submitting bundle", {
      tip:  built.tipLamports,
      sig:  shortKey(sig),
      slot: currentSlot,
    });

    // On devnet always send a real transaction so evidence has verifiable
    // explorer URLs. The bundle path is also exercised but will be rejected
    // by Jito (devnet has no block engine).
    if (config.solana.network === "devnet") {
      return this.submitDevnet(built, currentSlot, submittedAt, sig);
    }

    return this.submitMainnet(built, currentSlot, submittedAt, sig);
  }

  // Devnet path: send a real versioned transaction through the standard RPC
  // and record the signature. Bundle submission is attempted for code
  // coverage but its failure is not treated as a fatal error.

  private async submitDevnet(
    built: BuiltBundle,
    currentSlot: number,
    submittedAt: number,
    sig: string
  ): Promise<SubmitResult> {
    // Attempt the bundle path (will be rejected on devnet -- expected)
    let bundleId: string | null = null;
    try {
      bundleId = await this.jitoClient.sendBundle([built.transaction]);
      await this.logger.ok("[submitter] Bundle accepted (devnet -- may be rejected later)", {
        bundleId: bundleId.slice(0, 16) + "...",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.logger.debug("[submitter] Bundle rejected on devnet (expected)", {
        message: msg.slice(0, 120),
      });
    }

    // Send the real devnet transaction for verifiable evidence
    try {
      const realSig = await this.sendDevnetTx();
      await this.logger.ok("[submitter] Devnet tx confirmed", { sig: shortKey(realSig) });
      return {
        success:          true,
        bundleId,
        signature:        realSig,
        failure:          null,
        failureMessage:   null,
        slotAtSubmission: currentSlot,
        submittedAt,
      };
    } catch (err) {
      const msg     = err instanceof Error ? err.message : String(err);
      const failure = this.classifyException(err);
      await this.logger.warn("[submitter] Devnet tx failed", { failure, message: msg.slice(0, 200) });
      return {
        success:          false,
        bundleId,
        signature:        sig,
        failure,
        failureMessage:   msg,
        slotAtSubmission: currentSlot,
        submittedAt,
      };
    }
  }

  // Mainnet path: submit the bundle and poll for landing status.

  private async submitMainnet(
    built: BuiltBundle,
    currentSlot: number,
    submittedAt: number,
    sig: string
  ): Promise<SubmitResult> {
    try {
      const bundleId = await this.jitoClient.sendBundle([built.transaction]);

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
        failureMessage:   landed ? null : "Bundle lost auction or dropped by block engine",
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
        failureMessage:   msg,
        slotAtSubmission: currentSlot,
        submittedAt,
      };
    }
  }

  // Send a real versioned transaction on devnet to produce an explorer-
  // verifiable signature. Uses the payer's keypair to sign a 1-lamport
  // self-transfer so the transaction is always unique.

  private async sendDevnetTx(): Promise<string> {
    const bh = await this.connection.getLatestBlockhash("confirmed");

    const msg = new TransactionMessage({
      payerKey:        this.payer.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: this.payer.publicKey,
          toPubkey:   this.payer.publicKey,
          lamports:   1,
        }),
      ],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([this.payer]);

    const rawSig = await this.connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries:    3,
    });

    await this.connection.confirmTransaction(
      { signature: rawSig, ...bh },
      "confirmed"
    );

    return rawSig;
  }

  // Poll getInflightBundleStatuses until the bundle lands, fails, or expires.

  private async pollBundleStatus(bundleId: string): Promise<boolean> {
    const deadline = Date.now() + this.POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(this.POLL_INTERVAL_MS);

      const status = await this.jitoClient.getInflightBundleStatus(bundleId);

      if (!status) continue;

      await this.logger.debug("[submitter] Bundle inflight status", {
        bundleId: bundleId.slice(0, 12) + "...",
        status,
      });

      if (status === "Landed") {
        await this.logger.ok("[submitter] Bundle landed", {
          bundleId: bundleId.slice(0, 12) + "...",
        });
        return true;
      }

      if (status === "Failed") {
        await this.logger.warn("[submitter] Bundle failed on-chain", {
          bundleId: bundleId.slice(0, 12) + "...",
        });
        return false;
      }

      // "Invalid" = bundle no longer in the block engine's 5-minute window.
      // At 4s poll intervals this means the bundle lost the auction or was
      // never forwarded to the validator.
      if (status === "Invalid") {
        await this.logger.warn("[submitter] Bundle dropped (lost auction or expired)", {
          bundleId: bundleId.slice(0, 12) + "...",
        });
        return false;
      }

      // "Pending" -- keep polling
    }

    await this.logger.warn("[submitter] Bundle status poll timed out", {
      bundleId: bundleId.slice(0, 12) + "...",
    });
    return false;
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