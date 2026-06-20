/**
 * BlockhashCache unit tests.
 * Run: npx ts-node test/blockhash-cache.test.ts
 */

import assert from "assert";
import { BlockhashCache } from "../src/bundle/bundle-builder";

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
  console.log("\nBlockhashCache");

  await test("should detect expired blockhash using block height", async () => {
    const mockConnection = {
      getLatestBlockhash: async () => ({
        blockhash: "test",
        lastValidBlockHeight: 100,
      }),
      getBlockHeight: async () => 105,
    } as any;

    const cache = new BlockhashCache(mockConnection);
    const bh    = await cache.get(90);
    assert.strictEqual(bh.lastValidBlockHeight, 100);

    const expired = await cache.isExpiredNow();
    assert.strictEqual(expired, true);
  });

  await test("should not mark as expired when within safety margin", async () => {
    const mockConnection = {
      getLatestBlockhash: async () => ({
        blockhash: "test",
        lastValidBlockHeight: 100,
      }),
      getBlockHeight: async () => 97, // 97 < 100 - 2 safety margin
    } as any;

    const cache = new BlockhashCache(mockConnection);
    await cache.get(90);

    const expired = await cache.isExpiredNow();
    assert.strictEqual(expired, false);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
