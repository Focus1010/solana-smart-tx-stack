import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  TokenBalance,
} from "@solana/web3.js";
import { EventEmitter } from "events";
import bs58 from "bs58";
import { Logger } from "../utils/logger";
import { config } from "../config";
import {
  createYellowstoneClient,
  isYellowstoneAvailable,
  baseSubscribeRequest,
  pingRequest,
} from "../geyser/yellowstone-client";

// SPL Token program
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Known Raydium program IDs (mainnet; configurable via env)
export const DEFAULT_RAYDIUM_PROGRAM_IDS = [
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // CLMM
];

export type ProtocolTriggerKind = "spl_token_transfer" | "raydium_swap";

export interface ProtocolEvent {
  type:           ProtocolTriggerKind;
  txSignature:    string;
  slot:           number;
  programId:      string;
  slotTimestamp?: number;
  parsedDetails:  Record<string, unknown>;
  explorerUrl:    string;
}

export interface ProtocolTriggerConfig {
  protocol:    "usdc" | "raydium" | "none";
  mint:        string;
  minAmount:   number;
  programIds:  string[];
  network:     string;
}

export interface ProtocolInspectInput {
  signature: string;
  slot:      number;
  meta:      ParsedTransactionWithMeta["meta"];
  message:   ParsedTransactionWithMeta["transaction"]["message"];
  logMessages?: string[] | null;
}

function clusterLabel(network: string): string {
  return network === "mainnet-beta" ? "mainnet-beta" : "devnet";
}

function explorerUrl(signature: string, network: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${clusterLabel(network)}`;
}

function tokenAmountRaw(tb: TokenBalance): number {
  const amt = tb.uiTokenAmount?.amount;
  if (amt !== undefined && amt !== null) return parseInt(String(amt), 10) || 0;
  const ui = tb.uiTokenAmount?.uiAmount;
  const dec = tb.uiTokenAmount?.decimals ?? 0;
  if (ui !== null && ui !== undefined) return Math.round(ui * Math.pow(10, dec));
  return 0;
}

function accountKeyStrings(
  message: ProtocolInspectInput["message"]
): string[] {
  return message.accountKeys.map((k) => {
    if (typeof k === "string") return k;
    if (typeof k === "object" && k !== null && "pubkey" in k) {
      const pk = (k as { pubkey: string | { toBase58(): string } }).pubkey;
      return typeof pk === "string" ? pk : pk.toBase58();
    }
    return String(k);
  });
}

/**
 * Pure detection helper — used by live trigger and unit tests.
 */
export function inspectTransactionForProtocolEvent(
  input: ProtocolInspectInput,
  cfg: ProtocolTriggerConfig
): ProtocolEvent | null {
  if (cfg.protocol === "none") return null;

  const { signature, slot, meta, message, logMessages } = input;
  if (!meta) return null;

  const accountKeys = accountKeyStrings(message);

  // ── Raydium swap ──────────────────────────────────────────────────────────
  if (cfg.protocol === "raydium") {
    const raydiumHit = accountKeys.some((k) => cfg.programIds.includes(k));
    const logHit =
      (logMessages ?? meta.logMessages ?? []).some(
        (l) =>
          l.toLowerCase().includes("ray_log") ||
          l.toLowerCase().includes("swap") ||
          l.toLowerCase().includes("raydium")
      );

    if (raydiumHit || logHit) {
      const programId =
        accountKeys.find((k) => cfg.programIds.includes(k)) ??
        cfg.programIds[0] ??
        "raydium";

      return {
        type:          "raydium_swap",
        txSignature:   signature,
        slot,
        programId,
        parsedDetails: {
          accountKeys: accountKeys.slice(0, 8),
          logHit,
          raydiumProgramMatched: raydiumHit,
        },
        explorerUrl: explorerUrl(signature, cfg.network),
      };
    }
    return null;
  }

  // ── SPL token transfer (usdc / mint filter) ───────────────────────────────
  if (!cfg.mint) return null;

  const pre  = meta.preTokenBalances  ?? [];
  const post = meta.postTokenBalances ?? [];

  const deltas: Array<{ mint: string; owner: string; delta: number }> = [];

  for (const postBal of post) {
    if (postBal.mint !== cfg.mint) continue;
    const preBal = pre.find(
      (p) => p.accountIndex === postBal.accountIndex && p.mint === cfg.mint
    );
    const preAmt  = preBal ? tokenAmountRaw(preBal) : 0;
    const postAmt = tokenAmountRaw(postBal);
    const delta   = Math.abs(postAmt - preAmt);
    if (delta <= 0) continue;
    deltas.push({
      mint:  postBal.mint,
      owner: postBal.owner ?? "unknown",
      delta,
    });
  }

  const maxDelta = deltas.reduce((m, d) => Math.max(m, d.delta), 0);
  if (maxDelta < cfg.minAmount) return null;

  const tokenProgramInTx = accountKeys.includes(TOKEN_PROGRAM_ID);

  return {
    type:          "spl_token_transfer",
    txSignature:   signature,
    slot,
    programId:     TOKEN_PROGRAM_ID,
    parsedDetails: {
      mint:           cfg.mint,
      minAmount:      cfg.minAmount,
      matchedDelta:   maxDelta,
      balanceChanges: deltas,
      tokenProgramInTx,
    },
    explorerUrl: explorerUrl(signature, cfg.network),
  };
}

/**
 * ProtocolTrigger — high-traffic on-chain event detector.
 * Prefers Yellowstone transaction subscription when configured; falls back to onLogs.
 */
export class ProtocolTrigger extends EventEmitter {
  private readonly connection: Connection;
  private readonly logger:     Logger;
  private readonly cfg:        ProtocolTriggerConfig;

  private logsSubscriptionId: number | null = null;
  private yellowstoneStream:  any | null     = null;
  private pingTimer:          NodeJS.Timeout | null = null;
  private readonly recentSigs = new Set<string>();
  private readonly MAX_RECENT   = 500;

  constructor(connection: Connection, logger: Logger, triggerCfg?: Partial<ProtocolTriggerConfig>) {
    super();
    this.connection = connection;
    this.logger     = logger;
    this.cfg = {
      protocol:   (triggerCfg?.protocol ?? config.trigger.protocol) as ProtocolTriggerConfig["protocol"],
      mint:       triggerCfg?.mint ?? config.trigger.mint,
      minAmount:  triggerCfg?.minAmount ?? config.trigger.minAmount,
      programIds: triggerCfg?.programIds ?? config.trigger.programIds,
      network:    triggerCfg?.network ?? config.solana.network,
    };
  }

  async start(): Promise<void> {
    if (this.cfg.protocol === "none") {
      await this.logger.info("[trigger] Protocol trigger disabled (TRIGGER_PROTOCOL=none)");
      return;
    }

    if (this.cfg.protocol === "usdc" && !this.cfg.mint) {
      await this.logger.warn(
        "[trigger] TRIGGER_PROTOCOL=usdc but TRIGGER_MINT is empty — trigger disabled"
      );
      return;
    }

    await this.logger.info("[trigger] Starting protocol trigger", {
      protocol:  this.cfg.protocol,
      mint:      this.cfg.mint ? this.cfg.mint.slice(0, 12) + "..." : "(none)",
      minAmount: this.cfg.minAmount,
    });

    const yellowstoneOk =
      isYellowstoneAvailable() &&
      config.yellowstone.endpoint.length > 0;

    if (yellowstoneOk) {
      try {
        await this.startYellowstoneTransactions();
        await this.logger.info("[trigger] Yellowstone transaction subscription active");
        return;
      } catch (err) {
        await this.logger.warn("[trigger] Yellowstone tx subscription failed; using onLogs fallback", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this.startLogsFallback();
  }

  stop(): void {
    if (this.logsSubscriptionId !== null) {
      this.connection.removeOnLogsListener(this.logsSubscriptionId).catch(() => {});
      this.logsSubscriptionId = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.yellowstoneStream) {
      try {
        this.yellowstoneStream.end?.();
        this.yellowstoneStream.destroy?.();
      } catch {
        /* best effort */
      }
      this.yellowstoneStream = null;
    }
  }

  getConfig(): ProtocolTriggerConfig {
    return { ...this.cfg };
  }

  private async startLogsFallback(): Promise<void> {
    const programId =
      this.cfg.protocol === "raydium" && this.cfg.programIds[0]
        ? new PublicKey(this.cfg.programIds[0])
        : new PublicKey(TOKEN_PROGRAM_ID);

    await this.logger.info("[trigger] Subscribing via connection.onLogs", {
      program: programId.toBase58().slice(0, 12) + "...",
    });

    this.logsSubscriptionId = this.connection.onLogs(
      programId,
      (logsResult, ctx) => {
        if (logsResult.err) return;
        void this.processSignature(
          logsResult.signature,
          ctx?.slot ?? 0,
          logsResult.logs
        );
      },
      "confirmed"
    );
  }

  private async startYellowstoneTransactions(): Promise<void> {
    const client = createYellowstoneClient(
      config.yellowstone.endpoint,
      config.yellowstone.token
    );

    this.yellowstoneStream = await client.subscribe();

    const req = baseSubscribeRequest("confirmed");
    req.transactions = {
      client: {
        vote:   false,
        failed: false,
      },
    };

    await new Promise<void>((resolve, reject) => {
      this.yellowstoneStream.write(req, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    let pingId = 0;
    this.pingTimer = setInterval(() => {
      try {
        this.yellowstoneStream?.write(pingRequest(++pingId));
      } catch {
        /* ignore */
      }
    }, 30_000);

    this.yellowstoneStream.on("data", (frame: any) => {
      const tx = frame?.transaction;
      if (!tx?.transaction?.signature) return;
      const sigRaw = tx.transaction.signature;
      let signature: string;
      if (typeof sigRaw === "string") {
        signature = sigRaw;
      } else {
        signature = bs58.encode(Buffer.from(sigRaw));
      }

      void this.processSignature(
        signature,
        Number(tx.slot ?? 0),
        tx.transaction?.meta?.logMessages
      );
    });
  }

  private async processSignature(
    signature: string,
    slot: number,
    logMessages?: string[] | null
  ): Promise<void> {
    if (!signature || this.recentSigs.has(signature)) return;
    this.recentSigs.add(signature);
    if (this.recentSigs.size > this.MAX_RECENT) {
      const first = this.recentSigs.values().next().value;
      if (first) this.recentSigs.delete(first);
    }

    try {
      const parsed = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment:                   "confirmed",
      });

      if (!parsed) return;

      const ev = inspectTransactionForProtocolEvent(
        {
          signature,
          slot:        parsed.slot ?? slot,
          meta:        parsed.meta,
          message:     parsed.transaction.message,
          logMessages: logMessages ?? parsed.meta?.logMessages ?? null,
        },
        this.cfg
      );

      if (ev) {
        await this.logger.info("[trigger] Protocol event detected", {
          type: ev.type,
          sig:  ev.txSignature.slice(0, 12) + "...",
          slot: ev.slot,
        });
        this.emit("protocolEvent", ev);
      }
    } catch (err) {
      await this.logger.debug("[trigger] Failed to inspect transaction", {
        sig: signature.slice(0, 12),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
