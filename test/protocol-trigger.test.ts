/**
 * Protocol trigger unit tests.
 * Run: npx ts-node test/protocol-trigger.test.ts
 */

import assert from "assert";
import {
  inspectTransactionForProtocolEvent,
  TOKEN_PROGRAM_ID,
  DEFAULT_RAYDIUM_PROGRAM_IDS,
  type ProtocolTriggerConfig,
} from "../src/stream/protocol-trigger";
import { ProtocolTrigger } from "../src/stream/protocol-trigger";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const usdcCfg: ProtocolTriggerConfig = {
  protocol:   "usdc",
  mint:       USDC_MINT,
  minAmount:  1000,
  programIds: DEFAULT_RAYDIUM_PROGRAM_IDS,
  network:    "mainnet-beta",
};

async function main(): Promise<void> {
  console.log("\nProtocolTrigger.inspectTransactionForProtocolEvent");

  await test("detects SPL token transfer when mint delta exceeds threshold", () => {
    const ev = inspectTransactionForProtocolEvent(
      {
        signature: "SampleSig111",
        slot:      12345,
        meta: {
          preTokenBalances: [
            {
              accountIndex: 1,
              mint: USDC_MINT,
              owner: "OwnerA",
              uiTokenAmount: { amount: "5000", decimals: 6, uiAmount: 0.005, uiAmountString: "0.005" },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: USDC_MINT,
              owner: "OwnerA",
              uiTokenAmount: { amount: "15000", decimals: 6, uiAmount: 0.015, uiAmountString: "0.015" },
            },
          ],
          logMessages: [],
          err: null,
          fee: 5000,
          innerInstructions: [],
          preBalances: [],
          postBalances: [],
          status: { Ok: null },
        } as any,
        message: {
          accountKeys: [
            { pubkey: TOKEN_PROGRAM_ID, signer: false, writable: false },
          ],
        } as any,
      },
      usdcCfg
    );

    assert.ok(ev, "Expected protocol event");
    assert.strictEqual(ev!.type, "spl_token_transfer");
    assert.strictEqual(ev!.txSignature, "SampleSig111");
    assert.ok((ev!.parsedDetails.matchedDelta as number) >= 1000);
  });

  await test("ignores transfer below TRIGGER_MIN_AMOUNT", () => {
    const ev = inspectTransactionForProtocolEvent(
      {
        signature: "SmallTransfer",
        slot:      100,
        meta: {
          preTokenBalances: [
            {
              accountIndex: 0,
              mint: USDC_MINT,
              owner: "O",
              uiTokenAmount: { amount: "100", decimals: 6, uiAmount: 0.0001, uiAmountString: "0.0001" },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 0,
              mint: USDC_MINT,
              owner: "O",
              uiTokenAmount: { amount: "500", decimals: 6, uiAmount: 0.0005, uiAmountString: "0.0005" },
            },
          ],
        } as any,
        message: { accountKeys: [] } as any,
      },
      usdcCfg
    );
    assert.strictEqual(ev, null);
  });

  await test("detects Raydium swap via program id in account keys", () => {
    const rayCfg: ProtocolTriggerConfig = {
      protocol:   "raydium",
      mint:       "",
      minAmount:  1000,
      programIds: DEFAULT_RAYDIUM_PROGRAM_IDS,
      network:    "mainnet-beta",
    };

    const ev = inspectTransactionForProtocolEvent(
      {
        signature: "RaySwapSig",
        slot:      999,
        meta: { logMessages: ["Program log: ray_log swap"] } as any,
        message: {
          accountKeys: [
            { pubkey: DEFAULT_RAYDIUM_PROGRAM_IDS[0], signer: false, writable: false },
          ],
        } as any,
      },
      rayCfg
    );

    assert.ok(ev);
    assert.strictEqual(ev!.type, "raydium_swap");
  });

  console.log("\nProtocolTrigger EventEmitter");

  await test("emits protocolEvent when inspect helper matches (simulated path)", async () => {
    const trigger = new ProtocolTrigger(
      { onLogs: () => 0, removeOnLogsListener: async () => {} } as any,
      { info: async () => {}, warn: async () => {}, debug: async () => {} } as any,
      { protocol: "none", mint: "", minAmount: 1000, programIds: [], network: "devnet" }
    );

    let emitted = false;
    trigger.on("protocolEvent", () => { emitted = true; });

    const sample = inspectTransactionForProtocolEvent(
      {
        signature: "EmitTest",
        slot:      1,
        meta: {
          preTokenBalances: [],
          postTokenBalances: [
            {
              accountIndex: 0,
              mint: USDC_MINT,
              owner: "X",
              uiTokenAmount: { amount: "50000", decimals: 6, uiAmount: 0.05, uiAmountString: "0.05" },
            },
          ],
        } as any,
        message: { accountKeys: [{ pubkey: TOKEN_PROGRAM_ID }] } as any,
      },
      usdcCfg
    );

    if (sample) trigger.emit("protocolEvent", sample);
    assert.strictEqual(emitted, true);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
