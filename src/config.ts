import "dotenv/config";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

// Determine network - default to devnet
const network = optionalEnv("SOLANA_NETWORK", "devnet") as "devnet" | "mainnet-beta";

function getJitoDefaults(net: "devnet" | "mainnet-beta") {
  if (net === "devnet") {
    return {
      blockEngineUrl: "https://devnet.block-engine.jito.wtf",
      rpcUrl: "https://devnet.block-engine.jito.wtf/api/v1",
    };
  } else {
    return {
      blockEngineUrl: "https://mainnet.block-engine.jito.wtf",
      rpcUrl: "https://mainnet.block-engine.jito.wtf/api/v1",
    };
  }
}

const jitoDefaults = getJitoDefaults(network);

export const config = {
  solana: {
    rpcUrl: optionalEnv(
      "SOLANA_RPC_URL",
      network === "devnet"
        ? "https://api.devnet.solana.com"
        : "https://api.mainnet-beta.solana.com"
    ),
    wsUrl: optionalEnv(
      "SOLANA_WS_URL",
      network === "devnet"
        ? "wss://api.devnet.solana.com"
        : "wss://api.mainnet-beta.solana.com"
    ),
    network,
  },
  jito: {
    blockEngineUrl: optionalEnv(
      "JITO_BLOCK_ENGINE_URL",
      jitoDefaults.blockEngineUrl
    ),
    rpcUrl: optionalEnv(
      "JITO_RPC_URL",
      jitoDefaults.rpcUrl
    ),
  },
  yellowstone: {
    endpoint: optionalEnv(
      "YELLOWSTONE_ENDPOINT",
      ""
    ),
    token: optionalEnv("YELLOWSTONE_TOKEN", ""),
  },
  groq: {
    apiKey: requireEnv("GROQ_API_KEY"),
    model: optionalEnv("GROQ_MODEL", "llama3-70b-8192"),
  },
  wallet: {
    privateKey: requireEnv("WALLET_PRIVATE_KEY"),
  },
  stack: {
    maxRetries: parseInt(optionalEnv("MAX_RETRIES", "3"), 10),
    retryDelayMs: parseInt(optionalEnv("RETRY_DELAY_MS", "2000"), 10),
    bundleCount: parseInt(optionalEnv("BUNDLE_COUNT", "10"), 10),
    logDir: optionalEnv("LOG_DIR", "./logs"),
  },
} as const;

export type Network = typeof config.solana.network;
