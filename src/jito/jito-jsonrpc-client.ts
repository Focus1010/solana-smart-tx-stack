import { VersionedTransaction } from "@solana/web3.js";
import bs58                      from "bs58";
import { RateLimiter }           from "../utils/rate-limiter";
import {
  JitoBundleClient,
  LeaderInfo,
  BundleResultCallback,
  BundleErrorCallback,
} from "./jito-bundle-client";

// JitoJsonRpcClientImpl
// JSON-RPC transport for the Jito block engine. This transport works in any
// environment (no native bindings required) and is the default fallback when
// the gRPC transport is unavailable.
//
// Limitations vs gRPC transport:
//   - subscribeBundleResults is not supported (JSON-RPC has no streaming
//     equivalent); returns a no-op unsubscribe function and documents this.
//   - getNextScheduledLeader may not be available on all endpoints.
//
// Encoding: base64 (base58 is deprecated by Jito and silently dropped).
//
// Rate limiting: all outbound calls go through a shared RateLimiter to avoid
// 429 responses from the block engine.

// Official Jito tip accounts (mainnet)
// Source: https://docs.jito.wtf/lowlatencytxnsend/#tip-accounts
const STATIC_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "juLesoSmdTcRtzjrcVaBdQKzewoU7DR9AL8GCFmFKYc",
];

const MIN_CALL_INTERVAL_MS = parseInt(
  process.env.JITO_RATE_LIMIT_MS ?? "1100",
  10
);

export class JitoJsonRpcClientImpl implements JitoBundleClient {
  readonly transport = "jsonrpc" as const;

  private readonly bundlesUrl:  string;
  private readonly limiter:     RateLimiter;

  // Leader cache: 2-second TTL
  private leaderCache:    LeaderInfo | null = null;
  private leaderCachedAt  = 0;
  private readonly LEADER_TTL_MS = 2_000;

  // Negative-result cache for leader failures: 500ms TTL
  private leaderFailedAt  = 0;
  private readonly LEADER_FAIL_TTL_MS = 500;

  constructor(rpcUrl: string) {
    // Normalise so the URL always ends at /api/v1 and we append /bundles
    const base = rpcUrl.replace(/\/(bundles|transactions)\/?$/, "");
    this.bundlesUrl = `${base}/bundles`;
    this.limiter    = new RateLimiter(MIN_CALL_INTERVAL_MS);
  }

  async getTipAccounts(): Promise<string[]> {
    return STATIC_TIP_ACCOUNTS;
  }

  async sendBundle(transactions: VersionedTransaction[]): Promise<string> {
    const encoded = transactions.map((tx) =>
      Buffer.from(tx.serialize()).toString("base64")
    );

    return this.limiter.run(async () => {
      const body = {
        jsonrpc: "2.0",
        id:      1,
        method:  "sendBundle",
        params:  [encoded, { encoding: "base64" }],
      };

      const res = await fetch(this.bundlesUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });

      if (res.status === 429) {
        throw new Error("sendBundle rate limited (429)");
      }

      if (!res.ok) {
        throw new Error(`sendBundle HTTP ${res.status}: ${await res.text()}`);
      }

      const json = await res.json() as {
        result?: string;
        error?:  { code: number; message: string };
      };

      if (json.error) {
        throw new Error(`sendBundle RPC error ${json.error.code}: ${json.error.message}`);
      }
      if (!json.result) {
        throw new Error("sendBundle returned no bundleId");
      }

      return json.result;
    });
  }

  async getNextScheduledLeader(): Promise<LeaderInfo> {
    const now = Date.now();

    // Return cached result within TTL
    if (this.leaderCache && now - this.leaderCachedAt < this.LEADER_TTL_MS) {
      return this.leaderCache;
    }

    // Back off after a recent failure
    if (now - this.leaderFailedAt < this.LEADER_FAIL_TTL_MS) {
      return this.synthesizeLeaderFallback();
    }

    return this.limiter.run(async () => {
      try {
        const body = {
          jsonrpc: "2.0",
          id:      1,
          method:  "getNextScheduledLeader",
          params:  [],
        };

        const res = await fetch(this.bundlesUrl, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });

        if (!res.ok) {
          this.leaderFailedAt = Date.now();
          return this.synthesizeLeaderFallback();
        }

        const json = await res.json() as {
          result?: { currentSlot: number; nextLeaderSlot: number; nextLeaderIdentity?: string };
          error?:  { message: string };
        };

        if (json.error || !json.result) {
          this.leaderFailedAt = Date.now();
          return this.synthesizeLeaderFallback();
        }

        const info: LeaderInfo = {
          currentSlot:        Number(json.result.currentSlot),
          nextLeaderSlot:     Number(json.result.nextLeaderSlot),
          nextLeaderIdentity: json.result.nextLeaderIdentity ?? null,
        };

        this.leaderCache    = info;
        this.leaderCachedAt = Date.now();
        return info;
      } catch {
        this.leaderFailedAt = Date.now();
        return this.synthesizeLeaderFallback();
      }
    });
  }

  // subscribeBundleResults is not supported by the JSON-RPC transport.
  // The Jito block engine does not expose a streaming bundle-result endpoint
  // over JSON-RPC. Bundle landing confirmation must be done via
  // getInflightBundleStatuses polling or Yellowstone slot stream observation.
  subscribeBundleResults(
    _onUpdate: BundleResultCallback,
    _onError: BundleErrorCallback
  ): () => void {
    // no-op subscription -- JSON-RPC does not support streaming
    return () => {};
  }

  close(): void {
    // No persistent connections to close in the JSON-RPC transport
  }

  // Returns inflight bundle status via polling (used by bundle submitter)
  async getInflightBundleStatus(bundleId: string): Promise<string | null> {
    return this.limiter.run(async () => {
      try {
        const body = {
          jsonrpc: "2.0",
          id:      1,
          method:  "getInflightBundleStatuses",
          params:  [[bundleId]],
        };

        const res = await fetch(this.bundlesUrl, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });

        if (!res.ok) return null;

        const json = await res.json() as {
          result?: { value?: Array<{ status: string; landed_slot: number | null }> };
        };

        const statuses = json.result?.value ?? [];
        return statuses[0]?.status ?? null;
      } catch {
        return null;
      }
    });
  }

  private synthesizeLeaderFallback(): LeaderInfo {
    return {
      currentSlot:        0,
      nextLeaderSlot:     0,
      nextLeaderIdentity: null,
    };
  }
}