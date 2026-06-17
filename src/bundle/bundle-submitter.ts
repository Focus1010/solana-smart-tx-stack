import { JitoJsonRpcClient } from "jito-js-rpc";
import { Connection, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { BuiltBundle } from "./bundle-builder";
import { FailureReason } from "../types";
import { Logger } from "../utils/logger";
import { shortKey } from "../utils/helpers";
import { config } from "../config";

//  Submission result 

export interface SubmitResult {
  success:   boolean;
  bundleId:  string | null;
  signature: string | null;
  failure:   FailureReason | null;
  slotAtSubmission: number;
  submittedAt: number;
}

//  BundleSubmitter 

export class BundleSubmitter {
  private jitoClient: JitoJsonRpcClient;
  private connection: Connection;
  private logger: Logger;

  constructor(connection: Connection, logger: Logger) {
    this.connection = connection;
    this.logger     = logger;
    this.jitoClient = new JitoJsonRpcClient(config.jito.rpcUrl, "");
  }

  async submit(built: BuiltBundle, currentSlot: number): Promise<SubmitResult> {
    const submittedAt = Date.now();
    const sig         = this.extractSignature(built.transaction);

    await this.logger.info("[submitter] Sending bundle to Jito block engine", {
      tip:    built.tipLamports,
      sig:    shortKey(sig),
      slot:   currentSlot,
    });

    try {
      // Serialize each transaction in the bundle to base64
      const serializedTxs = this.serializeBundle(built);

      const response = await this.jitoClient.sendBundle([serializedTxs]);

      if (response?.result) {
        await this.logger.ok("[submitter] Bundle accepted", {
          bundleId: response.result,
          sig:      shortKey(sig),
        });
        return {
          success:          true,
          bundleId:         response.result,
          signature:        sig,
          failure:          null,
          slotAtSubmission: currentSlot,
          submittedAt,
        };
      }

      // Jito returned a response but no result -- classify the error
      const failure = this.classifyJitoError(response?.error);
      await this.logger.error("[submitter] Bundle rejected", { failure, raw: response?.error });

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
      await this.logger.error("[submitter] Bundle submission threw", {
        failure,
        message: err instanceof Error ? err.message : String(err),
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

  //  Helpers 

  private serializeBundle(built: BuiltBundle): string[] {
    return [built.transaction].map((tx: Transaction) =>
      Buffer.from(tx.serialize()).toString("base64")
    );
  }

  private extractSignature(tx: Transaction): string {
    if (tx.signatures.length > 0 && tx.signatures[0].signature) {
      return bs58.encode(tx.signatures[0].signature);
    }
    return "unknown";
  }

  private classifyJitoError(error: any): FailureReason {
    if (!error) return "UNKNOWN";

    const msg = JSON.stringify(error).toLowerCase();

    if (msg.includes("blockhash") || msg.includes("expired"))     return "EXPIRED_BLOCKHASH";
    if (msg.includes("fee") || msg.includes("tip"))               return "FEE_TOO_LOW";
    if (msg.includes("compute") || msg.includes("exceeded"))      return "COMPUTE_EXCEEDED";
    if (msg.includes("dropped") || msg.includes("leader skip"))   return "BUNDLE_DROPPED";
    if (msg.includes("simulation") || msg.includes("failed"))     return "SIMULATION_FAILED";

    return "UNKNOWN";
  }

  private classifyException(err: unknown): FailureReason {
    if (!(err instanceof Error)) return "UNKNOWN";

    const msg = err.message.toLowerCase();

    if (msg.includes("blockhash"))                                 return "EXPIRED_BLOCKHASH";
    if (msg.includes("insufficient") || msg.includes("fee"))      return "FEE_TOO_LOW";
    if (msg.includes("compute"))                                   return "COMPUTE_EXCEEDED";
    if (msg.includes("timeout") || msg.includes("timed out"))     return "TIMEOUT";

    return "UNKNOWN";
  }
}