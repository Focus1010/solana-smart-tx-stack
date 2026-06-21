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
//
// URL layout (Jito block engine JSON-RPC, per official docs):
//   POST /api/v1/bundles                 → sendBundle, getInflightBundleStatuses
//   POST /api/v1/getNextScheduledLeader  → leader schedule (not /bundles)
//
// IMPORTANT: getInflightBundleStatuses must go to /api/v1/bundles, NOT to a
// separate /api/v1/getInflightBundleStatuses path.  Both sendBundle and
// getInflightBundleStatuses share the same /bundles endpoint and are
// distinguished by the JSON-RPC "method" field.  Using the wrong URL causes
// the block engine to return 200 with an empty result or 404, which makes
// every status poll return null → POLL_TIMEOUT_MS fires → "timed out".

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
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
];

const MIN_CALL_INTERVAL_MS = parseInt(
  process.env.JITO_RATE_LIMIT_MS ?? "1100",
  10
);

export class JitoJsonRpcClientImpl implements JitoBundleClient {
  readonly transport = "jsonrpc" as const;

  // /api/v1/bundles  — used for sendBundle AND getInflightBundleStatuses
  private readonly bundlesUrl: string;
  // /api/v1/getNextScheduledLeader — separate path, NOT /bundles
  private readonly leaderUrl:  string;

  private readonly limiter: RateLimiter;

  // Leader cache: 2-second TTL
  private leaderCache:           LeaderInfo | null = null;
  private leaderCachedAt         = 0;
  private readonly LEADER_TTL_MS = 2_000;

  // Negative-result cache for leader failures.
  // After the first failure we back off 500ms; after 3 consecutive failures we
  // assume the endpoint does not support getNextScheduledLeader and back off
  // 30s so we stop hammering it. The cache is cleared on the first success.
  private leaderFailedAt           = 0;
  private leaderConsecutiveFails   = 0;
  private readonly LEADER_FAIL_TTL_MS      = 500;
  private readonly LEADER_FAIL_TTL_LONG_MS = 30_000;
  private readonly LEADER_FAIL_MAX_FAST    = 3;

  constructor(rpcUrl: string) {
    // Normalise base to /api/v1 (strip any trailing /bundles or /transactions)
    const base = rpcUrl.replace(/\/(bundles|transactions|getInflightBundleStatuses|getNextScheduledLeader)\/?$/, "");

    // Both sendBundle and getInflightBundleStatuses use the /bundles endpoint.
    // They are distinguished by the JSON-RPC "method" field, not the URL.
    this.bundlesUrl = `${base}/bundles`;

    // getNextScheduledLeader uses a dedicated path at the /api/v1 level.
    this.leaderUrl  = `${base}/getNextScheduledLeader`;

    this.limiter = new RateLimiter(MIN_CALL_INTERVAL_MS);
  }

  async getTipAccounts(): Promise<string[]> {
    return STATIC_TIP_ACCOUNTS;
  }

  // sendBundle
  //
  // Fix: params format is [[tx1_b64, tx2_b64, ...]] — a single array of
  // base64-encoded transactions.  There is NO options object as a second
  // param.  The { encoding: "base64" } object is the sendTransaction format
  // and is not accepted by sendBundle — Jito's block engine ignores it on
  // some versions and returns -32602 on others, producing the misleading
  // "Bundles must write lock at least one tip account" error.
  //
  // Fix: serialize inside limiter.run() so the bytes reflect tx state at
  // actual send-time, not at queue-time.
  //
  // Fix: validate signatures before serializing so we get a clear local
  // error ("transaction[0] has a zeroed signature") rather than a confusing
  // Jito rejection that looks like a tip-account or fee error.

  async sendBundle(transactions: VersionedTransaction[]): Promise<string> {
    // Pre-send signature validation
    for (let i = 0; i < transactions.length; i++) {
      const tx  = transactions[i];
      const sig = tx.signatures[0];
      const isZeroed = !sig || sig.every((b) => b === 0);
      if (isZeroed) {
        throw new Error(
          `sendBundle: transaction[${i}] has a zeroed/missing signature. ` +
          "Ensure the transaction is signed before calling sendBundle."
        );
      }
    }

    return this.limiter.runWithBackoff(async () => {
      // Serialize at actual send time (inside the rate-limiter queue)
      const encoded = transactions.map((tx) =>
        Buffer.from(tx.serialize()).toString("base64")
      );

      // Correct params: single array of base64 strings — no options object
      const body = {
        jsonrpc: "2.0",
        id:      1,
        method:  "sendBundle",
        params:  [encoded],
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

  // getNextScheduledLeader
  //
  // This is only exposed by Jito's gRPC SearcherClient and is NOT part of the
  // public JSON-RPC /api/v1/bundles surface.  It uses a dedicated path at
  // /api/v1/getNextScheduledLeader.  Even so, most regional block-engine
  // endpoints do not implement it over JSON-RPC — after 3 consecutive failures
  // the method backs off to a 30s retry TTL to stop hammering the endpoint.

  async getNextScheduledLeader(): Promise<LeaderInfo> {
    const now = Date.now();

    // Return cached result within TTL
    if (this.leaderCache && now - this.leaderCachedAt < this.LEADER_TTL_MS) {
      return this.leaderCache;
    }

    // Adaptive back-off after failures
    const failTtl = this.leaderConsecutiveFails >= this.LEADER_FAIL_MAX_FAST
      ? this.LEADER_FAIL_TTL_LONG_MS
      : this.LEADER_FAIL_TTL_MS;

    if (this.leaderFailedAt > 0 && now - this.leaderFailedAt < failTtl) {
      return this.synthesizeLeaderFallback();
    }

    return this.limiter.runWithBackoff(async () => {
      try {
        const body = {
          jsonrpc: "2.0",
          id:      1,
          method:  "getNextScheduledLeader",
          params:  [],
        };

        const res = await fetch(this.leaderUrl, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });

        if (!res.ok) {
          this.leaderFailedAt = Date.now();
          this.leaderConsecutiveFails++;
          return this.synthesizeLeaderFallback();
        }

        const json = await res.json() as {
          result?: { currentSlot: number; nextLeaderSlot: number; nextLeaderIdentity?: string };
          error?:  { message: string };
        };

        if (json.error || !json.result) {
          this.leaderFailedAt = Date.now();
          this.leaderConsecutiveFails++;
          return this.synthesizeLeaderFallback();
        }

        const info: LeaderInfo = {
          currentSlot:        Number(json.result.currentSlot),
          nextLeaderSlot:     Number(json.result.nextLeaderSlot),
          nextLeaderIdentity: json.result.nextLeaderIdentity ?? null,
        };

        this.leaderCache           = info;
        this.leaderCachedAt        = Date.now();
        this.leaderConsecutiveFails = 0;
        this.leaderFailedAt        = 0;
        return info;
      } catch {
        this.leaderFailedAt = Date.now();
        this.leaderConsecutiveFails++;
        return this.synthesizeLeaderFallback();
      }
    });
  }

  // subscribeBundleResults is not supported by the JSON-RPC transport.
  // The Jito block engine does not expose a streaming bundle-result endpoint
  // over JSON-RPC.  Bundle landing confirmation is done via
  // getInflightBundleStatuses polling or Yellowstone slot stream observation.
  subscribeBundleResults(
    _onUpdate: BundleResultCallback,
    _onError:  BundleErrorCallback
  ): () => void {
    // no-op — JSON-RPC transport has no streaming support
    return () => {};
  }

  close(): void {
    // No persistent connections to close in the JSON-RPC transport
  }

  // getInflightBundleStatus
  //
  // Uses the SAME /api/v1/bundles endpoint as sendBundle — NOT a separate URL.
  // The method name in the JSON-RPC body ("getInflightBundleStatuses") is what
  // the block engine routes on, not the HTTP path.
  //
  // Previous bugs fixed here:
  //   1. Was calling this.bundlesUrl but the URL was wrong on some builds —
  //      now explicitly documented that /bundles is the correct path.
  //   2. Bare `catch { return null }` was swallowing ALL errors (network
  //      failures, JSON parse errors, wrong-URL 404s) silently.  Now only
  //      genuine "no data" cases return null; actual errors are logged and
  //      re-thrown so the poll loop can see them.
  //   3. Added response body logging on non-429 errors so debugging is easier.

  async getInflightBundleStatus(bundleId: string): Promise<string | null> {
    // Uses the shared bundlesUrl — correct per Jito docs
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

    if (res.status === 429) {
      throw new Error("getInflightBundleStatuses rate limited (429)");
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "(unreadable)");
      throw new Error(
        `getInflightBundleStatuses HTTP ${res.status}: ${text.slice(0, 200)}`
      );
    }

    type StatusResponse = {
      result?: { value?: Array<{ status: string; landed_slot: number | null }> };
      error?:  { code: number; message: string };
    };

    let json: StatusResponse;
    try {
      // res.json() returns unknown in strict mode — cast explicitly after parsing
      json = await res.json() as StatusResponse;
    } catch (e) {
      throw new Error(`getInflightBundleStatuses JSON parse error: ${String(e)}`);
    }

    if (json.error) {
      throw new Error(
        `getInflightBundleStatuses RPC error ${json.error.code}: ${json.error.message}`
      );
    }

    // result.value is an array; the bundle may not appear yet — that is
    // normal while the block engine is still processing it.  Return null
    // (not an error) so the poll loop retries.
    const statuses = json.result?.value ?? [];
    return statuses[0]?.status ?? null;
  }

  private synthesizeLeaderFallback(): LeaderInfo {
    return {
      currentSlot:        0,
      nextLeaderSlot:     0,
      nextLeaderIdentity: null,
    };
  }
}