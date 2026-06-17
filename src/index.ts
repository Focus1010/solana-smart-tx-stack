import "dotenv/config";
import { Stack }  from "./stack";
import { Logger } from "./utils/logger";
import { loadWalletFromEnv, requestAirdropIfNeeded } from "./utils/wallet";
import { Connection } from "@solana/web3.js";
import { config } from "./config";

async function main(): Promise<void> {
  const logger = new Logger(config.stack.logDir);

  await logger.divider("Solana Smart Transaction Stack");
  await logger.info("Loading wallet");

  let payer;
  try {
    payer = loadWalletFromEnv();
  } catch (err) {
    await logger.error("Failed to load wallet from WALLET_PRIVATE_KEY", {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  await logger.info(`Wallet loaded: ${payer.publicKey.toBase58()}`);

  // On devnet, ensure the wallet has enough SOL to cover tips + fees
  if (config.solana.network === "devnet") {
    const connection = new Connection(config.solana.rpcUrl, "confirmed");
    await requestAirdropIfNeeded(connection, payer, 0.1);
  }

  const stack = new Stack(payer, logger);

  // Graceful shutdown on SIGINT / SIGTERM
  const shutdown = async () => {
    await logger.warn("\n[main] Shutting down");
    stack.stop();
    process.exit(0);
  };
  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await stack.start();
    await stack.runBatch(config.stack.bundleCount);
  } catch (err) {
    await logger.error("[main] Fatal error", {
      message: err instanceof Error ? err.message : String(err),
      stack:   err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  }

  stack.stop();
}

main();