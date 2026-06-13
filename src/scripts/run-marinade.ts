/**
 * run-marinade.ts
 *
 * Runs the stack in reactive mode: listens for large Marinade Finance
 * staking events on mainnet and submits a bundle in response to each one.
 *
 * Mainnet only -- Marinade Finance does not operate on devnet.
 *
 * Run: npm run run:marinade
 */

import "dotenv/config";
import { Stack }  from "../stack";
import { Logger } from "../utils/logger";
import { loadWalletFromEnv, requestAirdropIfNeeded } from "../utils/wallet";
import { Connection } from "@solana/web3.js";
import { config } from "../config";

async function main(): Promise<void> {
  const logger = new Logger(config.stack.logDir);

  await logger.divider("Marinade-Triggered Bundle Submission");

  if (config.solana.network !== "mainnet-beta") {
    await logger.error(
      "[marinade] This script requires SOLANA_NETWORK=mainnet-beta. " +
      "Marinade Finance does not operate on devnet."
    );
    process.exit(1);
  }

  const payer = loadWalletFromEnv();
  await logger.info(`Payer: ${payer.publicKey.toBase58()}`);

  const connection = new Connection(config.solana.rpcUrl, "confirmed");
  await requestAirdropIfNeeded(connection, payer, 0.01);

  const stack = new Stack(payer, logger);
  await stack.start();

  const shutdown = async () => {
    await logger.warn("[marinade] Shutting down...");
    stack.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const entries = await stack.runWithMarinadeTriggering(3, 5 * 60_000);

  await logger.divider("Marinade run complete");
  await logger.info(`Triggered ${entries.length} bundle submission(s) from real staking events`);

  stack.stop();
}

main().catch((err) => { console.error(err); process.exit(1); });
