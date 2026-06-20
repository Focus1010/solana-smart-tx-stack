import dotenv from "dotenv";
dotenv.config();

interface CliOptions {
  count:    number;
  failures: number;
  network:  string;
}

function parseCliArgs(): CliOptions {
  const args    = process.argv.slice(2);
  let count     = parseInt(process.env.BUNDLE_COUNT ?? "10", 10);
  let failures  = 0;
  let network   = process.env.SOLANA_NETWORK ?? "devnet";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--count" && args[i + 1]) {
      count = parseInt(args[i + 1], 10);
      process.env.BUNDLE_COUNT = String(count);
      i++;
    } else if (arg === "--failures" && args[i + 1]) {
      failures = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--network" && args[i + 1]) {
      network = args[i + 1];
      process.env.SOLANA_NETWORK = network;
      i++;
    }
  }

  return { count, failures, network };
}

async function runFaultInjections(
  logger: { info: (m: string) => Promise<void>; warn: (m: string) => Promise<void> },
  failures: number
): Promise<void> {
  if (failures <= 0) return;

  await logger.info(`[main] Running fault injection (${failures} requested)`);

  const batches = Math.ceil(failures / 3);
  for (let b = 0; b < batches; b++) {
    const { execSync } = await import("child_process");
    try {
      execSync("npx ts-node src/scripts/fault-inject.ts", {
        stdio: "inherit",
        cwd:   process.cwd(),
      });
    } catch {
      await logger.warn("[main] Fault injection batch encountered errors (expected for demo faults)");
    }
  }
}

async function main(): Promise<void> {
  const cli = parseCliArgs();

  const { Stack }  = await import("./stack");
  const { Logger } = await import("./utils/logger");
  const { loadWalletFromEnv, requestAirdropIfNeeded } = await import("./utils/wallet");
  const { Connection } = await import("@solana/web3.js");
  const { config }     = await import("./config");

  const logger = new Logger(config.stack.logDir);

  await logger.divider("Solana Smart Transaction Stack");
  await logger.info("Loading wallet");
  await logger.info(
    `[main] CLI: count=${cli.count} failures=${cli.failures} network=${cli.network}`
  );

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

  if (config.solana.network === "devnet") {
    const connection = new Connection(config.solana.rpcUrl, "confirmed");
    try {
      await requestAirdropIfNeeded(connection, payer, 0.1);
    } catch (err) {
      await logger.warn("[main] Devnet airdrop failed; continuing with existing balance", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stack = new Stack(payer, logger);

  const shutdown = async () => {
    await logger.warn("\n[main] Shutting down");
    stack.stop();
    process.exit(0);
  };
  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await stack.start();

    const normalCount = Math.max(0, cli.count - cli.failures);
    if (normalCount > 0) {
      await stack.runBatch(normalCount);
    }

    await runFaultInjections(logger, cli.failures);
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
