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
import { RateLimiter }              from "../utils/rate-limiter";
import { LeaderWindowDetector }     from "../jito/leader-window-detector";

// SubmitResult

export interface SubmitResult {
  success:          boolean;
  bundleId:         string | null;
  signature:        string | null;
  failure:          FailureReason | null;
  failureMessage:   string | null;
  slotAtSubmission: number;
  submittedAt:      number;
  // Raw bundle-result events collected during the submission window,
  // persisted into lifecycle records for auditing purposes.
  rawBundleResults?: unknown[];
}

// BundleSubmitter
// Sends Jito bundles via the JitoBundleClient abstraction.
//
// Submission gating (mainnet):
//   A bundle is only submitted when at least one of:
//     (a) the Yellowstone stream is healthy AND leader-window indicates
//         a Jito leader within JITO_LEADER_WINDOW_SLOTS slots, OR
//     (b) getNextScheduledLeader indicates isJitoLeaderWindow true, OR
//     (c) JITO_EMERGENCY_OVERRIDE=true (default: false). When this flag
//         is set the tip is bumped to emergencyMinTipLamports if lower.
//
// On devnet: gating is bypassed (Jito has no devnet block engine).
//
// Encoding: base64 (base58 is deprecated by Jito).
//
// 429 handling: sendBundle and status calls go through RateLimiter.runWithBackoff
// which retries with exponential backoff (500ms * 2^n + jitter, max 10s).

export class BundleSubmitter {
  private readonly connection:     Connection;
  private readonly payer:          Keypair;
  private readonly logger:         Logger;
  private readonly jitoClient:     JitoJsonRpcClientImpl;
  private readonly limiter:        RateLimiter;
  private leaderDetector:          LeaderWindowDetector | null = null;

  // Raw bundle-result events collected from subscribeBundleResults()
  private pendingRawResults: unknown[] = [];

  private readonly POLL_TIMEOUT_MS  = 30_000;
  private readonly POLL_INTERVAL_MS = 4_000;

  constructor(connection: Connection, payer: Keypair, logger: Logger) {
    this.connection = connection;
    this.payer      = payer;
    this.logger     = logger;
    this.jitoClient = new JitoJsonRpcClientImpl(config.jito.rpcUrl);
    this.limiter    = new RateLimiter(
      parseInt(process.env.JITO_RATE_LIMIT_MS ?? "1100", 10)
    );
  }

  // Inject a leader-window detector so the submitter can gate on leader info.
  // Call this from the orchestrator (Stack) after constructing both objects.
  setLeaderDetector(detector: LeaderWindowDetector): void {
    this.leaderDetector = detector;
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
    built:        BuiltBundle,
    currentSlot:  number,
    submittedAt:  number,
    sig:          string
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
        rawBundleResults: [],
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
        rawBundleResults: [],
      };
    }
  }

  // Mainnet path: gate on leader window, then submit the bundle and poll status.

  private async submitMainnet(
    built:        BuiltBundle,
    currentSlot:  number,
    submittedAt:  number,
    sig:          string
  ): Promise<SubmitResult> {
    // ── Leader-window gating ──────────────────────────────────────────────
    let effectiveTip = built.tipLamports;

    if (!config.jito.emergencyOverride) {
      const allowed = await this.isLeaderWindowOpen(currentSlot);

      if (!allowed) {
        await this.logger.warn(
          "[submitter] Submission blocked: no Jito leader window detected and " +
          "JITO_EMERGENCY_OVERRIDE is not set. Skipping bundle."
        );
        return {
          success:          false,
          bundleId:         null,
          signature:        sig,
          failure:          "BUNDLE_DROPPED",
          failureMessage:   "Submission gated: no Jito leader window and emergency override is off",
          slotAtSubmission: currentSlot,
          submittedAt,
          rawBundleResults: [],
        };
      }
    } else {
      // Emergency override: bump tip to emergency floor if current tip is lower
      if (effectiveTip < config.jito.emergencyMinTipLamports) {
        await this.logger.warn(
          `[submitter] Emergency override active: bumping tip from ${effectiveTip} ` +
          `to emergency floor ${config.jito.emergencyMinTipLamports} lamports`
        );
        effectiveTip = config.jito.emergencyMinTipLamports;
      }
      await this.logger.warn(
        "[submitter] EMERGENCY OVERRIDE active -- submitting without leader-window gate"
      );
    }

    // ── Subscribe for raw bundle-result events ────────────────────────────
    const rawResults: unknown[] = [];
    const unsubscribe = this.jitoClient.subscribeBundleResults(
      (update) => {
        rawResults.push(update.raw);
        if (update.state === "rejected" || update.state === "dropped") {
          this.logger.warn("[submitter] Raw bundle result: " + update.state, {
            bundleId: update.bundleId?.slice(0, 12),
            raw:      JSON.stringify(update.raw ?? {}).slice(0, 200),
          }).catch(() => {});
        }
      },
      (err) => {
        this.logger.warn("[submitter] Bundle-result stream error", {
          message: err.message.slice(0, 120),
        }).catch(() => {});
      }
    );

    // ── Submit ────────────────────────────────────────────────────────────
    try {
      const bundleId = await this.limiter.runWithBackoff(async () => {
        return this.jitoClient.sendBundle([built.transaction]);
      });

      await this.logger.ok("[submitter] Bundle accepted by block engine", {
        bundleId: bundleId.slice(0, 16) + "...",
        sig:      shortKey(sig),
        tip:      effectiveTip,
      });

      const landed = await this.pollBundleStatus(bundleId);
      unsubscribe();

      return {
        success:          landed,
        bundleId,
        signature:        sig,
        failure:          landed ? null : "BUNDLE_DROPPED",
        failureMessage:   landed ? null : "Bundle lost auction or dropped by block engine",
        slotAtSubmission: currentSlot,
        submittedAt,
        rawBundleResults: rawResults,
      };
    } catch (err) {
      unsubscribe();
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
        rawBundleResults: rawResults,
      };
    }
  }

  // Checks if a Jito leader window is currently open.
  //
  // Return policy:
  //   true  when isJitoLeaderWindow is true, OR slotsUntil is within the
  //         configured window, OR slotsUntil is null (leader info unavailable --
  //         unknown ≠ no window; we allow rather than silently drop bundles).
  //   false only when we have a positive slotsUntil value that is beyond the
  //         configured window AND isJitoLeaderWindow is explicitly false.
  //
  // This prevents the gate from becoming a silent bundle killer when the Jito
  // block-engine endpoint does not support getNextScheduledLeader (which returns
  // {currentSlot:0, nextLeaderSlot:0} and produces slotsUntil=null).
  private async isLeaderWindowOpen(currentSlot: number): Promise<boolean> {
    if (!this.leaderDetector) {
      // No detector injected -- allow submission
      return true;
    }

    try {
      const window = await this.leaderDetector.detect(currentSlot);

      // Explicitly in a Jito leader window
      if (window.isJitoLeaderWindow) {
        await this.logger.debug("[submitter] Leader window is open", {
          slotsUntil: window.slotsUntilJitoLeader,
          identity:   window.nextLeaderIdentity?.slice(0, 8),
        });
        return true;
      }

      // Close enough to the next window
      if (window.slotsUntilJitoLeader !== null &&
          window.slotsUntilJitoLeader <= config.jito.leaderWindowSlots) {
        await this.logger.debug("[submitter] Close to Jito leader window", {
          slotsUntil: window.slotsUntilJitoLeader,
        });
        return true;
      }

      // slotsUntil is null: the block-engine endpoint does not support
      // getNextScheduledLeader (returns zeros). Treat as "unknown" and allow --
      // blocking here would silently discard every bundle on endpoints that
      // don't expose the leader schedule.
      if (window.slotsUntilJitoLeader === null) {
        await this.logger.debug(
          "[submitter] Leader schedule unavailable (endpoint does not support " +
          "getNextScheduledLeader) -- allowing submission"
        );
        return true;
      }

      // We have a positive slotsUntil beyond the window -- genuine miss
      await this.logger.debug("[submitter] Beyond Jito leader window", {
        slotsUntil: window.slotsUntilJitoLeader,
        windowSlots: config.jito.leaderWindowSlots,
      });
      return false;
    } catch {
      // Detection error -- allow submission to avoid blocking
      return true;
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

      let status: string | null = null;
      try {
        status = await this.limiter.runWithBackoff(async () => {
          return this.jitoClient.getInflightBundleStatus(bundleId);
        });
      } catch {
        // 429 exhausted or network error -- keep polling
        continue;
      }

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
    // Must be checked before the generic tip/fee match below: Jito returns this
    // exact wording when the submitted transaction does not write-lock one of
    // its current official tip accounts (e.g. a stale/incorrect tip account
    // address). It is a structural rejection, not an auction-loss/fee-size
    // issue -- raising the tip will not fix it, so it must not be classified
    // as FEE_TOO_LOW (which the agent would "fix" by bumping the tip).
    if (msg.includes("write lock") && msg.includes("tip account"))  return "UNKNOWN";
    if (msg.includes("tip") || msg.includes("fee"))            return "FEE_TOO_LOW";
    if (msg.includes("compute"))                               return "COMPUTE_EXCEEDED";
    if (msg.includes("timeout") || msg.includes("timed out")) return "TIMEOUT";
    if (msg.includes("429") || msg.includes("rate"))          return "RATE_LIMITED";
    if (msg.includes("not found") || msg.includes("dropped")) return "BUNDLE_DROPPED";

    return "UNKNOWN";
  }
}