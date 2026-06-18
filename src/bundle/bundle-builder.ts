import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  BlockhashWithExpiryBlockHeight,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { bundle as JitoBundle } from "jito-ts";
import { Logger } from "../utils/logger";

const { Bundle } = JitoBundle;

// ─── Jito tip accounts ────────────────────────────────────────────────────────
// Full list of 8 official Jito tip accounts (mainnet).
// Source: https://docs.jito.wtf/lowlatencytxnsend/#tip-accounts
// Picked at random per submission to reduce contention.

const TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "juLesoSmdTcRtzjrcVaBdQKzewoU7DR9AL8GCFmFKYc",
];

function pickTipAccount(): PublicKey {
  const idx = Math.floor(Math.random() * TIP_ACCOUNTS.length);
  return new PublicKey(TIP_ACCOUNTS[idx]);
}

// ─── BlockhashCache ───────────────────────────────────────────────────────────

export class BlockhashCache {
  private connection: Connection;
  private cached: BlockhashWithExpiryBlockHeight | null = null;
  private fetchedAtSlot = 0;
  private readonly REFRESH_SLOTS = 100;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async get(currentSlot: number, forceRefresh = false): Promise<BlockhashWithExpiryBlockHeight> {
    const needsRefresh =
      forceRefresh ||
      !this.cached ||
      currentSlot - this.fetchedAtSlot > this.REFRESH_SLOTS;

    if (needsRefresh) {
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
  transaction: VersionedTransaction;
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

  // Build a VersionedTransaction bundle containing a self-transfer + tip.
  // Uses TransactionMessage + VersionedTransaction (V0) which is required
  // by the Jito block engine -- legacy Transaction serialization causes
  // bundles to be marked Invalid and never land.

  async build(
    tipLamports: number,
    currentSlot: number,
    forceBlockhashRefresh = false
  ): Promise<BuiltBundle> {
    const blockhashInfo = await this.blockhashCache.get(currentSlot, forceBlockhashRefresh);
    const tipAccount    = pickTipAccount();

    const message = new TransactionMessage({
      payerKey:        this.payer.publicKey,
      recentBlockhash: blockhashInfo.blockhash,
      instructions: [
        // Primary: zero-lamport self-transfer (minimal cost, real verifiable sig)
        SystemProgram.transfer({
          fromPubkey: this.payer.publicKey,
          toPubkey:   this.payer.publicKey,
          lamports:   0,
        }),
        // Tip: pays the Jito tip account to enter the block engine auction
        SystemProgram.transfer({
          fromPubkey: this.payer.publicKey,
          toPubkey:   tipAccount,
          lamports:   tipLamports,
        }),
      ],
    }).compileToV0Message();

    const vtx = new VersionedTransaction(message);
    vtx.sign([this.payer]);

    const jitoBundle = new Bundle([vtx], 5);

    return {
      bundle:      jitoBundle,
      transaction: vtx,
      tipAccount:  tipAccount.toBase58(),
      tipLamports,
      blockhash:   blockhashInfo.blockhash,
    };
  }

  isBlockhashExpired(slot: number): boolean {
    return this.blockhashCache.isExpiredAt(slot);
  }

  invalidateBlockhash(): void {
    this.blockhashCache.invalidate();
  }
}