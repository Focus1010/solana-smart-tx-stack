import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  BlockhashWithExpiryBlockHeight,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { bundle as JitoBundle } from "jito-ts";
import { Logger } from "../utils/logger";

const { Bundle } = JitoBundle;

// ─── Jito tip accounts ────────────────────────────────────────────────────────
// Full set of 8 official Jito tip accounts (mainnet).
// Source: https://docs.jito.wtf/lowlatencytxnsend/#tip-accounts
// Pick one at random per submission to distribute contention.

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
  return new PublicKey(TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]);
}

// ─── BlockhashCache ───────────────────────────────────────────────────────────

export class BlockhashCache {
  private connection:    Connection;
  private cached:        BlockhashWithExpiryBlockHeight | null = null;
  private fetchedAtSlot  = 0;
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
  private connection:     Connection;
  private payer:          Keypair;
  private logger:         Logger;
  private blockhashCache: BlockhashCache;

  constructor(connection: Connection, payer: Keypair, logger: Logger) {
    this.connection     = connection;
    this.payer          = payer;
    this.logger         = logger;
    this.blockhashCache = new BlockhashCache(connection);
  }

  // Build a VersionedTransaction (V0) bundle with:
  //   - ComputeBudget instructions (required for block engine cost-model check)
  //   - A 1-lamport self-transfer as the primary instruction
  //   - A Jito tip transfer as the last instruction
  //
  // Key points:
  //   1. Must be VersionedTransaction -- legacy Transaction is rejected
  //   2. Transactions are sent base64-encoded; the submitter handles that
  //   3. Tip must be >= 1000 lamports and go to one of the 8 tip accounts
  //   4. Do NOT use Address Lookup Tables for tip account (Jito requirement)
  //   5. 1 lamport self-transfer (not 0) avoids dust-spam heuristic filters

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
        // Explicit compute unit limit -- required for block engine cost-model check
        ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 }),
        // Jito tip -- the ONLY SOL-transfer instruction in this transaction.
        // Keeping this as the sole transfer (no self-transfer) ensures this tx
        // always has a different signature from the sendRealTx self-transfer,
        // even when they share a blockhash. Jito marks duplicate-signature bundles
        // as Invalid immediately. Do NOT use an ALT for the tip account.
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