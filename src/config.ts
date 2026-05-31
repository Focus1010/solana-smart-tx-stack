import "dotenv/config";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  solana: {
    rpcUrl: optionalEnv(
      "SOLANA_RPC_URL",
      "https://api.devnet.solana.com"
    ),
    wsUrl: optionalEnv(
      "SOLANA_WS_URL",
      "wss://api.devnet.solana.com"
    ),
    network: optionalEnv("SOLANA_NETWORK", "devnet") as "devnet" | "mainnet-beta",
  },
  jito: {
    blockEngineUrl: optionalEnv(
      "JITO_BLOCK_ENGINE_URL",
      "https://mainnet.block-engine.jito.wtf"
    ),
    // For devnet simulation we use the JSON-RPC endpoint
    rpcUrl: optionalEnv(
      "JITO_RPC_URL",
      "https://mainnet.block-engine.jito.wtf/api/v1"
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
