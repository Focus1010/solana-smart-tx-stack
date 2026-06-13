import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import { bundle as JitoBundle } from "jito-ts";
import { Logger } from "../utils/logger";

const { Bundle } = JitoBundle;

// ─── Known Jito tip accounts (used to attach tip instruction) ─────────────────

const TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
];

function pickTipAccount(): PublicKey {
  const idx = Math.floor(Math.random() * TIP_ACCOUNTS.length);
  return new PublicKey(TIP_ACCOUNTS[idx]);
}

// ─── BlockhashCache ───────────────────────────────────────────────────────────
// Caches a recent blockhash and tracks whether it has expired.
// Solana blockhashes are valid for ~150 slots (~60 seconds).

export class BlockhashCache {
  private connection: Connection;
  private cached: BlockhashWithExpiryBlockHeight | null = null;
  private fetchedAtSlot = 0;
  private readonly REFRESH_SLOTS = 100; // Proactively refresh before expiry

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async get(currentSlot: number, forceRefresh = false): Promise<BlockhashWithExpiryBlockHeight> {
    const needsRefresh =
      forceRefresh ||
      !this.cached ||
      currentSlot - this.fetchedAtSlot > this.REFRESH_SLOTS;

    if (needsRefresh) {
      // Always fetch at "confirmed" -- never "finalized" (too stale)
      this.cached        = await this.connection.getLatestBlockhash("confirmed");
      this.fetchedAtSlot = currentSlot;
    }

    return this.cached!;
  }

  isExpiredAt(slot: number): boolean {
    if (!this.cached) return true;
    return slot > this.cached.lastValidBlockHeight + 5;
  }

  invalidate(): void {
    this.cached        = null;
    this.fetchedAtSlot = 0;
  }
}

// ─── BundleBuilder ────────────────────────────────────────────────────────────

export interface BuiltBundle {
  bundle:      InstanceType<typeof Bundle>;
  transaction: Transaction;
  tipAccount:  string;
  tipLamports: number;
  blockhash:   string;
}

export class BundleBuilder {
  private connection: Connection;
  private payer: Keypair;
  private logger: Logger;
  private blockhashCache: BlockhashCache;

  constructor(connection: Connection, payer: Keypair, logger: Logger) {
    this.connection     = connection;
    this.payer          = payer;
    this.logger         = logger;
    this.blockhashCache = new BlockhashCache(connection);
  }

  // ── Build a bundle containing a self-transfer + tip instruction ──────────────
  // The self-transfer is a zero-lamport send back to self -- it is valid,
  // cheap, and produces a real signature that can be tracked on-chain.

  async build(
    tipLamports: number,
    currentSlot: number,
    forceBlockhashRefresh = false
  ): Promise<BuiltBundle> {
    const blockhashInfo = await this.blockhashCache.get(currentSlot, forceBlockhashRefresh);
    const tipAccount    = pickTipAccount();

    const tx = new Transaction({
      recentBlockhash: blockhashInfo.blockhash,
      feePayer:        this.payer.publicKey,
    });

    // Primary instruction: zero-lamport self-transfer (minimal cost, real tx)
    tx.add(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey:   this.payer.publicKey,
        lamports:   0,
      })
    );

    // Tip instruction: pays the Jito tip account
    tx.add(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey:   tipAccount,
        lamports:   tipLamports,
      })
    );

    tx.sign(this.payer);

    // Jito Bundle: max 5 transactions per bundle.
    // Cast to `any` here because jito-ts type defs expect VersionedTransaction
    // but the runtime serializeTransactions() handles legacy Transaction correctly.
    const jitoBundle = new Bundle([tx as any], 5);

    return {
      bundle:      jitoBundle,
      transaction: tx,
      tipAccount:  tipAccount.toBase58(),
      tipLamports,
      blockhash:   blockhashInfo.blockhash,
    };
  }

  // ── Expose blockhash cache for external expiry checks ─────────────────────

  isBlockhashExpired(slot: number): boolean {
    return this.blockhashCache.isExpiredAt(slot);
  }

  invalidateBlockhash(): void {
    this.blockhashCache.invalidate();
  }
}
