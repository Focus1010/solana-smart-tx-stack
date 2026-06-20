import type { VersionedTransaction } from "@solana/web3.js";
import { searcherClient, type SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";
import type { BundleResult } from "jito-ts/dist/gen/block-engine/bundle";
import { RateLimiter } from "../utils/rate-limiter";
import { Logger } from "../utils/logger";
import {
  JitoBundleClient,
  LeaderInfo,
  BundleResultCallback,
  BundleErrorCallback,
  BundleResultUpdate,
  BundleResultState,
} from "./jito-bundle-client";

// Official Jito tip accounts (mainnet) — fallback when gRPC call fails
const STATIC_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZpGwDcEt",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
];

const LEADER_TTL_MS = 2_000;

/**
 * JitoGrpcClientImpl
 * gRPC searcher transport with rate-limiting and bundle-result subscription.
 * All calls are wrapped with RateLimiter.runWithBackoff to handle 429 rate-limits.
 */
export class JitoGrpcClientImpl implements JitoBundleClient {
  readonly transport = "grpc" as const;

  private readonly client: SearcherClient;
  private readonly limiter: RateLimiter;
  private readonly logger: Logger;
  private readonly statusUrl: string;

  private leaderCache:    LeaderInfo | null = null;
  private leaderCachedAt   = 0;

  constructor(endpoint: string, logger: Logger, minIntervalMs = 1_100) {
    this.logger  = logger;
    this.limiter = new RateLimiter(minIntervalMs);
    this.client  = searcherClient(endpoint, undefined);

    // Hybrid status polling via JSON-RPC (gRPC has no inflight-status endpoint)
    const base = endpoint.replace(/^grpc:\/\//, "https://").replace(/\/$/, "");
    this.statusUrl = `${base}/api/v1/bundles`;
  }

  async getTipAccounts(): Promise<string[]> {
    return this.limiter.runWithBackoff(async () => {
      const res = await this.client.getTipAccounts();
      if (!res.ok) {
        await this.logger.warn("[jito-grpc] getTipAccounts failed; using static list", {
          error: String(res.error),
        });
        return STATIC_TIP_ACCOUNTS;
      }
      return res.value;
    });
  }

  async sendBundle(transactions: VersionedTransaction[]): Promise<string> {
    return this.limiter.runWithBackoff(async () => {
      const bundle = new Bundle(transactions, 5);
      const res    = await this.client.sendBundle(bundle);
      if (!res.ok) {
        throw new Error(`sendBundle failed: ${String(res.error)}`);
      }
      return res.value;
    });
  }

  async getNextScheduledLeader(): Promise<LeaderInfo> {
    const now = Date.now();
    if (this.leaderCache && now - this.leaderCachedAt < LEADER_TTL_MS) {
      return this.leaderCache;
    }

    return this.limiter.runWithBackoff(async () => {
      const res = await this.client.getNextScheduledLeader();
      if (!res.ok) {
        throw new Error(`getNextScheduledLeader failed: ${String(res.error)}`);
      }

      const info: LeaderInfo = {
        currentSlot:        res.value.currentSlot,
        nextLeaderSlot:     res.value.nextLeaderSlot,
        nextLeaderIdentity: res.value.nextLeaderIdentity ?? null,
      };

      this.leaderCache  = info;
      this.leaderCachedAt = Date.now();
      return info;
    });
  }

  subscribeBundleResults(
    onUpdate: BundleResultCallback,
    onError: BundleErrorCallback
  ): () => void {
    return this.client.onBundleResult(
      (result: BundleResult) => {
        onUpdate(this.mapBundleResult(result));
      },
      onError
    );
  }

  async getInflightBundleStatus(bundleId: string): Promise<string | null> {
    return this.limiter.runWithBackoff(async () => {
      try {
        const body = {
          jsonrpc: "2.0",
          id:      1,
          method:  "getInflightBundleStatuses",
          params:  [[bundleId]],
        };

        const res = await fetch(this.statusUrl, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });

        if (res.status === 429) {
          throw new Error("getInflightBundleStatuses rate limited (429)");
        }
        if (!res.ok) return null;

        const json = await res.json() as {
          result?: { value?: Array<{ status: string }> };
        };

        return json.result?.value?.[0]?.status ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("429")) throw err;
        return null;
      }
    });
  }

  close(): void {
    try {
      (this.client as unknown as { client?: { close?: () => void } })?.client?.close?.();
    } catch {
      /* best effort */
    }
  }

  private mapBundleResult(result: BundleResult): BundleResultUpdate {
    let state: BundleResultState = "accepted";
    let slot:  number | undefined;

    if (result.rejected) {
      state = "rejected";
    } else if (result.dropped) {
      state = "dropped";
    } else if (result.finalized) {
      state = "finalized";
    } else if (result.processed) {
      state = "processed";
      slot  = result.processed.slot;
    } else if (result.accepted) {
      state = "accepted";
      slot  = result.accepted.slot;
    }

    return {
      bundleId: result.bundleId,
      state,
      slot,
      raw: result,
    };
  }
}

/** Alias for documentation / imports that reference JitoGrpcClient */
export { JitoGrpcClientImpl as JitoGrpcClient };
