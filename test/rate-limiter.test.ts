/**
 * RateLimiter unit tests.
 * Run: npx ts-node test/rate-limiter.test.ts
 */

import assert from "assert";
import { RateLimiter } from "../src/utils/rate-limiter";

let passed = 0;
let failed = 0;

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
  console.log("\nRateLimiter");

  await test("should serialize concurrent calls", async () => {
    const limiter  = new RateLimiter(100);
    const callOrder: number[] = [];

    const start = Date.now();
    const p1 = limiter.run(async () => {
      callOrder.push(1);
      return "call1";
    });
    const p2 = limiter.run(async () => {
      callOrder.push(2);
      return "call2";
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    assert.strictEqual(r1, "call1");
    assert.strictEqual(r2, "call2");
    assert.deepStrictEqual(callOrder, [1, 2]);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 100 - 15, `Expected >= 100ms elapsed, got ${elapsed}ms`);
  });

  await test("should retry on 429 with exponential backoff", async () => {
    const limiter  = new RateLimiter(10);
    let attempts   = 0;

    const result = await limiter.runWithBackoff(async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error("429 Too Many Requests");
      }
      return "success";
    });

    assert.strictEqual(result, "success");
    assert.strictEqual(attempts, 2);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
