/**
 * challenge:doctor
 *
 * Preflight checker that verifies the environment is configured correctly
 * before running a full evidence collection run.
 *
 * Run: npm run challenge:doctor
 *
 * Checks performed:
 *   - Required env vars present (WALLET_PRIVATE_KEY)
 *   - Optional env vars with their effective values
 *   - Yellowstone native binding availability
 *   - Jito block engine reachability
 *   - Tip floor endpoint reachability
 *   - AI provider configuration
 *   - Solana RPC responsiveness
 *   - Wallet balance (warn if below 0.05 SOL on devnet)
 */

import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { isYellowstoneAvailable } from "../src/geyser/yellowstone-client";
import { loadWalletFromEnv }       from "../src/utils/wallet";
import { config }                  from "../src/config";

const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";

function ok(msg: string):   void { console.log(`  ${GREEN}[PASS]${RESET} ${msg}`); }
function warn(msg: string): void { console.log(`  ${YELLOW}[WARN]${RESET} ${msg}`); }
function fail(msg: string): void { console.log(`  ${RED}[FAIL]${RESET} ${msg}`); }
function info(msg: string): void { console.log(`        ${msg}`); }

let overallOk = true;

function markFail(): void { overallOk = false; }

async function checkEnv(): Promise<void> {
  console.log(`\n${BOLD}Environment${RESET}`);

  // Required
  if (process.env.WALLET_PRIVATE_KEY) {
    ok("WALLET_PRIVATE_KEY is set");
  } else {
    fail("WALLET_PRIVATE_KEY is missing (required)");
    markFail();
  }

  // Network
  info(`Network:          ${config.solana.network}`);
  info(`RPC URL:          ${config.solana.rpcUrl}`);
  info(`Jito RPC URL:     ${config.jito.rpcUrl}`);

  // Yellowstone (optional)
  if (config.yellowstone.endpoint) {
    ok(`YELLOWSTONE_ENDPOINT is set: ${config.yellowstone.endpoint.slice(0, 40)}...`);
  } else {
    warn("YELLOWSTONE_ENDPOINT not set -- slot streaming will use RPC poller fallback");
  }
  if (config.yellowstone.token) {
    ok("YELLOWSTONE_TOKEN is set");
  } else {
    warn("YELLOWSTONE_TOKEN not set -- required for most Yellowstone providers");
  }

  // AI provider
  if (config.aiProvider === "groq") {
    if (config.groq.apiKey) {
      ok(`AI provider: groq (model: ${config.groq.model})`);
    } else {
      warn("GROQ_API_KEY not set -- agent will use heuristic fallback mode");
    }
  } else {
    if (config.anthropic.apiKey) {
      ok(`AI provider: anthropic (model: ${config.anthropic.model})`);
    } else {
      warn("ANTHROPIC_API_KEY not set -- agent will use heuristic fallback mode");
    }
  }
}

async function checkYellowstone(): Promise<void> {
  console.log(`\n${BOLD}Yellowstone gRPC binding${RESET}`);

  if (isYellowstoneAvailable()) {
    ok("@triton-one/yellowstone-grpc native binding loaded successfully");
  } else {
    warn(
      "@triton-one/yellowstone-grpc native binding unavailable on this platform. " +
      "The stack will use SlotPoller (RPC fallback). " +
      "To enable Yellowstone, run on a platform with native Node.js bindings (Linux x64/arm64)."
    );
  }
}

async function checkSolanaRpc(): Promise<void> {
  console.log(`\n${BOLD}Solana RPC${RESET}`);

  const connection = new Connection(config.solana.rpcUrl, "confirmed");

  try {
    const slot = await connection.getSlot("processed");
    ok(`RPC responsive -- current slot: ${slot}`);
  } catch (err) {
    fail(`RPC not responding: ${err instanceof Error ? err.message : String(err)}`);
    markFail();
    return;
  }

  // Wallet balance check
  try {
    const payer   = loadWalletFromEnv();
    const balance = await connection.getBalance(payer.publicKey);
    const sol     = balance / 1e9;
    const addr    = payer.publicKey.toBase58();

    info(`Wallet: ${addr.slice(0, 12)}...${addr.slice(-4)}`);

    if (config.solana.network === "devnet") {
      if (sol >= 0.05) {
        ok(`Wallet balance: ${sol.toFixed(4)} SOL (sufficient)`);
      } else {
        warn(`Wallet balance: ${sol.toFixed(4)} SOL (low -- airdrop will be requested automatically)`);
      }
    } else {
      if (sol >= 0.001) {
        ok(`Wallet balance: ${sol.toFixed(6)} SOL`);
      } else {
        fail(`Wallet balance too low for mainnet: ${sol.toFixed(6)} SOL`);
        markFail();
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("WALLET_PRIVATE_KEY")) {
      // Already reported above
    } else {
      fail(`Could not load wallet: ${err instanceof Error ? err.message : String(err)}`);
      markFail();
    }
  }
}

async function checkJito(): Promise<void> {
  console.log(`\n${BOLD}Jito block engine${RESET}`);

  const url = config.jito.rpcUrl.replace(/\/(bundles|transactions)\/?$/, "") + "/bundles";

  try {
    const body = {
      jsonrpc: "2.0",
      id:      1,
      method:  "getTipAccounts",
      params:  [],
    };

    const res = await Promise.race([
      fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 8_000)
      ),
    ]);

    if ((res as Response).ok) {
      const json = await (res as Response).json() as { result?: string[] };
      if (json.result && json.result.length > 0) {
        ok(`Jito block engine reachable -- ${json.result.length} tip accounts returned`);
        info(`Endpoint: ${url}`);
      } else {
        warn("Jito responded but returned no tip accounts");
      }
    } else {
      warn(`Jito responded with HTTP ${(res as Response).status} -- may be rate limited`);
    }
  } catch (err) {
    warn(
      `Jito block engine not reachable: ${err instanceof Error ? err.message : String(err)}. ` +
      "Bundle submission will fail but the rest of the stack continues."
    );
  }
}

async function checkTipOracle(): Promise<void> {
  console.log(`\n${BOLD}Tip floor endpoint${RESET}`);

  const TIP_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";

  try {
    const res = await Promise.race([
      fetch(TIP_URL),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 8_000)
      ),
    ]);

    if ((res as Response).ok) {
      const json = await (res as Response).json();
      if (Array.isArray(json) && json.length > 0) {
        const p50 = json[0]?.landed_tips_50th_percentile;
        ok(`Tip floor endpoint reachable -- p50: ${p50 ?? "unknown"} SOL`);
      } else {
        warn("Tip floor endpoint reachable but returned unexpected shape");
      }
    } else {
      warn(`Tip floor endpoint responded with HTTP ${(res as Response).status}`);
    }
  } catch (err) {
    warn(
      `Tip floor endpoint not reachable: ${err instanceof Error ? err.message : String(err)}. ` +
      "TipOracle will fall back to RPC prioritization fees."
    );
  }
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}challenge:doctor -- preflight check${RESET}`);
  console.log("=".repeat(50));

  await checkEnv();
  await checkYellowstone();
  await checkSolanaRpc();
  await checkJito();
  await checkTipOracle();

  console.log("\n" + "=".repeat(50));
  if (overallOk) {
    console.log(`${GREEN}${BOLD}All required checks passed. Ready to run.${RESET}`);
    console.log(`\nNext steps:`);
    console.log(`  npm run build`);
    console.log(`  npm run challenge:run -- --count 10 --failures 2`);
    console.log(`  npm run run:inject`);
    console.log(`  npm run generate:evidence`);
    console.log(`  npm run verify:evidence`);
  } else {
    console.log(`${RED}${BOLD}One or more required checks failed. Fix the issues above before running.${RESET}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Doctor crashed:", err);
  process.exit(1);
});