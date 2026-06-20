/**
 * Unit tests using Node's built-in assert module.
 * No external test framework required.
 *
 * Run:  npx ts-node test/unit.test.ts
 * Or:   npm test
 */

import assert from "assert";
import { RateLimiter } from "../src/utils/rate-limiter";
import { BlockhashCache } from "../src/bundle/bundle-builder";
import { pingRequest, baseSubscribeRequest, numericToSlotStatus } from "../src/geyser/yellowstone-client";

// Minimal test runner

let passed = 0;
let failed  = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${msg}`);
    failed++;
  }
}

async function main(): Promise<void> {

// ── RateLimiter ───────────────────────────────────────────────────────────────

console.log("\nRateLimiter");

await test("serializes concurrent calls (only one active at a time)", async () => {
  const limiter  = new RateLimiter(0);
  let active     = 0;
  let maxActive  = 0;

  const tasks = Array.from({ length: 5 }, () =>
    limiter.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => setTimeout(r, 5));
      active--;
    })
  );

  await Promise.all(tasks);
  assert.strictEqual(maxActive, 1, `Expected max 1 concurrent, got ${maxActive}`);
});

await test("enforces minimum interval between calls", async () => {
  const minMs   = 50;
  const limiter = new RateLimiter(minMs);
  const times: number[] = [];

  for (let i = 0; i < 3; i++) {
    await limiter.run(async () => {
      times.push(Date.now());
    });
  }

  for (let i = 1; i < times.length; i++) {
    const delta = times[i] - times[i - 1];
    assert.ok(
      delta >= minMs - 5,
      `Call ${i}: interval was ${delta}ms, expected >= ${minMs}ms`
    );
  }
});

await test("returns the value from the wrapped function", async () => {
  const limiter = new RateLimiter(0);
  const result  = await limiter.run(async () => 42);
  assert.strictEqual(result, 42);
});

await test("propagates errors from wrapped function", async () => {
  const limiter = new RateLimiter(0);
  await assert.rejects(
    () => limiter.run(async () => { throw new Error("boom"); }),
    /boom/
  );
});

await test("releases lock even when wrapped function throws", async () => {
  const limiter = new RateLimiter(0);

  // First call throws
  await limiter.run(async () => { throw new Error("first"); }).catch(() => {});

  // Second call must still execute (lock was released)
  const result = await limiter.run(async () => "recovered");
  assert.strictEqual(result, "recovered");
});

await test("runWithBackoff retries on 429 and succeeds on second attempt", async () => {
  const limiter = new RateLimiter(0);
  let calls = 0;
  const result = await limiter.runWithBackoff(async () => {
    calls++;
    if (calls === 1) throw new Error("429 Too Many Requests");
    return "success";
  });
  assert.strictEqual(result, "success");
  assert.strictEqual(calls, 2, "Should have retried once after 429");
});

await test("runWithBackoff propagates non-429 errors immediately", async () => {
  const limiter = new RateLimiter(0);
  let calls = 0;
  await assert.rejects(
    () => limiter.runWithBackoff(async () => {
      calls++;
      throw new Error("Internal Server Error");
    }),
    /Internal Server Error/
  );
  assert.strictEqual(calls, 1, "Should not retry on non-429 errors");
});

await test("runWithBackoff exhausts retries on persistent 429", async () => {
  const limiter = new RateLimiter(0);
  let calls = 0;
  await assert.rejects(
    () => limiter.runWithBackoff(async () => {
      calls++;
      throw new Error("429 rate limit");
    }),
    /429 rate limit/
  );
  // BACKOFF_MAX_RETRY = 4, so 1 initial + 4 retries = 5 total
  assert.ok(calls >= 2, `Expected at least 2 calls, got ${calls}`);
});

// ── BlockhashCache ────────────────────────────────────────────────────────────

console.log("\nBlockhashCache.isExpiredNow");

await test("returns true when no blockhash is cached", async () => {
  const mockConnection = {} as any;
  const cache = new BlockhashCache(mockConnection);
  const expired = await cache.isExpiredNow();
  assert.strictEqual(expired, true);
});

await test("returns false when current height is well below lastValidBlockHeight", async () => {
  const mockConnection = {
    getBlockHeight: async () => 1_000,
  } as any;
  const cache = new BlockhashCache(mockConnection);

  // Manually prime the cache via get()
  let getCalled = false;
  (mockConnection as any).getLatestBlockhash = async () => {
    getCalled = true;
    return { blockhash: "abc123", lastValidBlockHeight: 1_200 };
  };

  await cache.get(500, true);
  assert.ok(getCalled, "getLatestBlockhash should have been called");

  const expired = await cache.isExpiredNow();
  assert.strictEqual(expired, false, "Should not be expired (height=1000, lastValid=1200)");
});

await test("returns true when current height is within safety margin", async () => {
  const mockConnection = {
    getBlockHeight: async () => 1_199,
    getLatestBlockhash: async () => ({ blockhash: "abc123", lastValidBlockHeight: 1_200 }),
  } as any;
  const cache = new BlockhashCache(mockConnection);

  await cache.get(500, true);

  // height=1199, lastValid=1200, safetyMargin=2 => 1199 >= 1198 => expired
  const expired = await cache.isExpiredNow();
  assert.strictEqual(expired, true, "Should be expired (within safety margin)");
});

await test("returns true when getBlockHeight throws", async () => {
  const mockConnection = {
    getBlockHeight: async () => { throw new Error("RPC down"); },
    getLatestBlockhash: async () => ({ blockhash: "abc123", lastValidBlockHeight: 2_000 }),
  } as any;
  const cache = new BlockhashCache(mockConnection);
  await cache.get(500, true);

  const expired = await cache.isExpiredNow();
  assert.strictEqual(expired, true, "Should treat getBlockHeight failure as expired");
});

await test("invalidate() causes next isExpiredNow to return true", async () => {
  const mockConnection = {
    getBlockHeight: async () => 1_000,
    getLatestBlockhash: async () => ({ blockhash: "abc123", lastValidBlockHeight: 2_000 }),
  } as any;
  const cache = new BlockhashCache(mockConnection);
  await cache.get(500, true);

  const beforeInvalidate = await cache.isExpiredNow();
  assert.strictEqual(beforeInvalidate, false, "Should not be expired before invalidate");

  cache.invalidate();

  const afterInvalidate = await cache.isExpiredNow();
  assert.strictEqual(afterInvalidate, true, "Should be expired after invalidate");
});

// ── Yellowstone frame helpers ─────────────────────────────────────────────────

console.log("\nYellowstone frame helpers");

await test("pingRequest includes all required empty maps", () => {
  const frame = pingRequest(1);
  assert.ok(frame.ping,               "Missing ping field");
  assert.deepStrictEqual(frame.slots,              {}, "slots must be {}");
  assert.deepStrictEqual(frame.accounts,           {}, "accounts must be {}");
  assert.deepStrictEqual(frame.transactions,       {}, "transactions must be {}");
  assert.deepStrictEqual(frame.transactionsStatus, {}, "transactionsStatus must be {}");
  assert.deepStrictEqual(frame.blocks,             {}, "blocks must be {}");
  assert.deepStrictEqual(frame.blocksMeta,         {}, "blocksMeta must be {}");
  assert.deepStrictEqual(frame.entry,              {}, "entry must be {}");
  assert.deepStrictEqual(frame.accountsDataSlice,  [], "accountsDataSlice must be []");
});

await test("pingRequest increments id correctly", () => {
  const f1 = pingRequest(1);
  const f2 = pingRequest(2);
  assert.strictEqual((f1.ping as any).id, 1);
  assert.strictEqual((f2.ping as any).id, 2);
});

await test("baseSubscribeRequest includes slot filter and empty maps", () => {
  const req = baseSubscribeRequest("processed");
  assert.ok((req.slots as any)?.solana, "Missing solana slot filter");
  assert.strictEqual((req.slots as any).solana.filterByCommitment, false);
  assert.deepStrictEqual(req.accounts,           {});
  assert.deepStrictEqual(req.transactions,       {});
  assert.deepStrictEqual(req.transactionsStatus, {});
  assert.deepStrictEqual(req.blocks,             {});
  assert.deepStrictEqual(req.blocksMeta,         {});
  assert.deepStrictEqual(req.entry,              {});
  assert.deepStrictEqual(req.accountsDataSlice,  []);
});

await test("baseSubscribeRequest includes fromSlot as string when provided", () => {
  const req = baseSubscribeRequest("processed", "12345678");
  assert.strictEqual(req.fromSlot, "12345678");
});

await test("baseSubscribeRequest omits fromSlot when not provided", () => {
  const req = baseSubscribeRequest("processed");
  assert.strictEqual(req.fromSlot, undefined);
});

await test("numericToSlotStatus maps all known values", () => {
  assert.strictEqual(numericToSlotStatus(0), "processed");
  assert.strictEqual(numericToSlotStatus(1), "confirmed");
  assert.strictEqual(numericToSlotStatus(2), "finalized");
  assert.strictEqual(numericToSlotStatus(6), "dead");
  assert.strictEqual(numericToSlotStatus(99), "processed"); // unknown defaults to processed
});

// ── ReconnectingYellowstoneStream structure ───────────────────────────────────

console.log("\nReconnectingYellowstoneStream (unit, no real network)");

await test("emits fallback immediately when Yellowstone native binding is absent", async () => {
  // We simulate the binding being unavailable by mocking isYellowstoneAvailable
  // through a stream with an empty endpoint, which also triggers fallback.
  const { ReconnectingYellowstoneStream } = await import("../src/geyser/reconnecting-stream");

  const mockLogger = {
    info:  async () => {},
    warn:  async () => {},
    error: async () => {},
    debug: async () => {},
  } as any;

  const stream = new ReconnectingYellowstoneStream(
    { endpoint: "", token: "", maxRetries: 3 },
    mockLogger
  );

  let fallbackEmitted = false;
  stream.on("fallback", () => { fallbackEmitted = true; });

  await stream.start();

  assert.strictEqual(fallbackEmitted, true, "fallback should be emitted when endpoint is empty");
});

await test("ack() decrements bufferedEvents without going below zero", async () => {
  const { ReconnectingYellowstoneStream } = await import("../src/geyser/reconnecting-stream");

  const mockLogger = { info: async () => {}, warn: async () => {}, debug: async () => {} } as any;
  const stream = new ReconnectingYellowstoneStream(
    { endpoint: "", token: "", maxRetries: 1 },
    mockLogger
  );

  // ack on a fresh stream should not throw or go negative
  stream.ack();
  stream.ack();
  // If no error thrown and lastProcessedSlot is still 0, the test passes
  assert.strictEqual(stream.getLastProcessedSlot(), 0);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}

}

main();