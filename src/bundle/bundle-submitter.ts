import crypto from "crypto";
import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58                         from "bs58";
import { BuiltBundle, BundleBuilder } from "./bundle-builder";
import { FailureReason }            from "../types";
import { Logger }                   from "../utils/logger";
import { shortKey, sleep }          from "../utils/helpers";
import { config }                   from "../config";
import { JitoBundleClient }         from "../jito/jito-bundle-client";
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
  // Bundle transaction signature (may differ from evidence tx signature).
  bundleTxSignature?: string | null;
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
  private readonly jitoClient:     JitoBundleClient;
  private readonly builder:        BundleBuilder;
  private readonly limiter:        RateLimiter;
  private readonly statusLimiter:  RateLimiter;
  private leaderDetector:          LeaderWindowDetector | null = null;

  // Raw bundle-result events collected from subscribeBundleResults()
  private pendingRawResults: unknown[] = [];

  // A Jito bundle is only valid for the single target leader slot it is
  // submitted into -- roughly 1 to 4 slots, around 400ms to 1.6s on mainnet.
  // The previous flat 4s interval meant the FIRST status check happened
  // after the bundle's entire live window had already elapsed (roughly 10
  // slots), so every poll was reading a result that was already decided
  // before we ever looked. Jito's own integration guide explicitly warns
  // about this: add a short delay before the first check, then poll fast,
  // because getInflightBundleStatuses can otherwise return Invalid for a
  // bundle that was actually still being processed.
  //
  // FAST_POLL_INTERVAL_MS matches slot cadence so we catch the bundle while
  // it can still report Pending or Landed. After FAST_POLL_WINDOW_MS we
  // back off, since by then the bundle has either landed or is genuinely
  // gone and there is no value in continuing to hammer the endpoint.
  //
  // statusLimiter is intentionally separate from the sendBundle limiter.
  // getInflightBundleStatuses is a read-only lookup; reusing the same
  // 1100ms-minimum limiter used for sendBundle would silently throttle fast
  // polling back down to ~1100ms regardless of FAST_POLL_INTERVAL_MS, which
  // would reintroduce the exact timing problem this fix addresses.
  private readonly POLL_TIMEOUT_MS        = 30_000;
  private readonly INITIAL_POLL_DELAY_MS  = 600;
  private readonly FAST_POLL_INTERVAL_MS  = 500;
  private readonly FAST_POLL_WINDOW_MS    = 4_000;
  private readonly SLOW_POLL_INTERVAL_MS  = 2_000;

  constructor(
    connection: Connection,
    payer: Keypair,
    logger: Logger,
    jitoClient: JitoBundleClient,
    builder: BundleBuilder
  ) {
    this.connection    = connection;
    this.payer         = payer;
    this.logger        = logger;
    this.jitoClient    = jitoClient;
    this.builder       = builder;
    this.limiter       = new RateLimiter(
      parseInt(process.env.JITO_RATE_LIMIT_MS ?? "1500", 10)
    );
    this.statusLimiter = new RateLimiter(
      parseInt(process.env.JITO_STATUS_POLL_RATE_LIMIT_MS ?? "250", 10)
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
    await this.logger.info("[submitter] Signatures", {
      realSig:      sig,
      bundleTxSig:  built.bundleTxSignature ?? null,
    });

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
        bundleTxSignature: built.bundleTxSignature ?? sig,
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
        bundleTxSignature: built.bundleTxSignature ?? sig,
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
    let activeBuilt  = built;
    let bundleSig    = sig;

    await this.logger.info("[submitter] Signatures", {
      realSig:      bundleSig,
      bundleTxSig:  activeBuilt.bundleTxSignature ?? null,
    });

    if (
      activeBuilt.bundleTxSignature &&
      bundleSig === activeBuilt.bundleTxSignature
    ) {
      const memoSeed =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : String(Date.now());

      await this.logger.warn(
        "[submitter] Signature collision: rebuilding bundle with memo to ensure uniqueness",
        { memoSeed }
      );

      activeBuilt = await this.builder.build(
        effectiveTip,
        currentSlot,
        true,
        memoSeed
      );
      bundleSig = this.extractSignature(activeBuilt.transaction);

      await this.logger.info("[submitter] Rebuilt bundle signatures", {
        realSig:      bundleSig,
        bundleTxSig:  activeBuilt.bundleTxSignature ?? null,
      });
    }

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
          signature:        bundleSig,
          failure:          "BUNDLE_DROPPED",
          failureMessage:   "Submission gated: no Jito leader window and emergency override is off",
          slotAtSubmission: currentSlot,
          submittedAt,
          rawBundleResults: [],
          bundleTxSignature: activeBuilt.bundleTxSignature ?? bundleSig,
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
        const raw = update.raw ?? update;
        rawResults.push(raw);

        const state =
          update.state ||
          ((raw as { rejected?: unknown }).rejected
            ? "rejected"
            : (raw as { dropped?: unknown }).dropped
              ? "dropped"
              : "unknown");

        this.logger.debug("[jito] Bundle result update", {
          bundleId: update.bundleId,
          state,
          slot:     update.slot,
          raw,
        }).catch(() => {});

        if (update.state === "rejected" || update.state === "dropped") {
          this.logger.warn("[jito] Raw bundle result: " + update.state, {
            bundleId: update.bundleId?.slice(0, 12),
            raw:      JSON.stringify(raw ?? {}).slice(0, 500),
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
        return this.jitoClient.sendBundle([activeBuilt.transaction]);
      });

      await this.logger.ok("[submitter] Bundle accepted by block engine", {
        bundleId: bundleId.slice(0, 16) + "...",
        sig:      shortKey(bundleSig),
        tip:      effectiveTip,
      });

      // Allow gRPC bundle-result events to arrive before polling status.
      await sleep(500);

      const landed = await this.pollBundleStatus(bundleId);
      unsubscribe();

      if (bundleId && rawResults.length === 0) {
        await this.logger.warn(
          "[submitter] No raw bundle-result events received for bundleId after wait; rawResults empty",
          { bundleId: bundleId.slice(0, 16) + "..." }
        );
      }

      return {
        success:          landed,
        bundleId,
        signature:        bundleSig,
        failure:          landed ? null : "BUNDLE_DROPPED",
        failureMessage:   landed ? null : "Bundle lost auction or dropped by block engine",
        slotAtSubmission: currentSlot,
        submittedAt,
        rawBundleResults: rawResults,
        bundleTxSignature: activeBuilt.bundleTxSignature ?? bundleSig,
      };
    } catch (err) {
      unsubscribe();
      const failure = this.classifyException(err);
      const msg     = err instanceof Error ? err.message : String(err);

      await this.logger.warn("[submitter] Bundle submission failed", {
        failure,
        message: msg.slice(0, 200),
      });

      if (rawResults.length === 0) {
        await this.logger.warn(
          "[submitter] No raw bundle-result events received; rawResults empty",
          { bundleId: null }
        );
      }

      return {
        success:          false,
        bundleId:         null,
        signature:        bundleSig,
        failure,
        failureMessage:   msg,
        slotAtSubmission: currentSlot,
        submittedAt,
        rawBundleResults: rawResults,
        bundleTxSignature: activeBuilt.bundleTxSignature ?? bundleSig,
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
  //
  // Strategy: wait a short fixed delay first (matches Jito's own guidance --
  // checking immediately after sendBundle can race the block engine's own
  // bookkeeping), then poll at FAST_POLL_INTERVAL_MS (roughly slot cadence)
  // for FAST_POLL_WINDOW_MS, since that covers the bundle's actual live
  // window. After that, back off to SLOW_POLL_INTERVAL_MS -- if the bundle
  // hasn't resolved by then it almost certainly already has, and we are
  // just waiting out POLL_TIMEOUT_MS for bookkeeping to catch up.
  //
  // A single "Invalid" read is not treated as final. The block engine's
  // status table can lag the real outcome by a beat right after submission;
  // a genuinely dropped bundle will keep reading Invalid on the next fast
  // poll, while a bundle that actually landed will flip to Landed within
  // one or two polls. Two consecutive Invalid reads are required before we
  // report the bundle as dropped.

  private async pollBundleStatus(bundleId: string): Promise<boolean> {
    const deadline = Date.now() + this.POLL_TIMEOUT_MS;
    const fastUntil = Date.now() + this.FAST_POLL_WINDOW_MS;

    await sleep(this.INITIAL_POLL_DELAY_MS);

    let consecutiveInvalid = 0;

    while (Date.now() < deadline) {
      let status: string | null = null;
      try {
        if (this.jitoClient.getInflightBundleStatus) {
          status = await this.statusLimiter.runWithBackoff(async () => {
            return this.jitoClient.getInflightBundleStatus!(bundleId);
          });
        }
      } catch {
        // 429 exhausted or network error -- keep polling
        await sleep(Date.now() < fastUntil ? this.FAST_POLL_INTERVAL_MS : this.SLOW_POLL_INTERVAL_MS);
        continue;
      }

      if (!status) {
        await sleep(Date.now() < fastUntil ? this.FAST_POLL_INTERVAL_MS : this.SLOW_POLL_INTERVAL_MS);
        continue;
      }

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

      if (status === "Invalid") {
        consecutiveInvalid++;

        // First Invalid read this early could be a bookkeeping race --
        // confirm with one more fast check before concluding it is dropped.
        if (consecutiveInvalid < 2 && Date.now() < fastUntil) {
          await sleep(this.FAST_POLL_INTERVAL_MS);
          continue;
        }

        await this.logger.warn("[submitter] Bundle dropped (lost auction or expired)", {
          bundleId: bundleId.slice(0, 12) + "...",
          confirmedAfterReads: consecutiveInvalid,
        });
        return false;
      }

      // "Pending" -- keep polling, reset the Invalid counter
      consecutiveInvalid = 0;
      await sleep(Date.now() < fastUntil ? this.FAST_POLL_INTERVAL_MS : this.SLOW_POLL_INTERVAL_MS);
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