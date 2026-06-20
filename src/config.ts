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
      "https://frankfurt.mainnet.block-engine.jito.wtf"
    ),
    // Use a regional endpoint, NOT the global mainnet.block-engine.jito.wtf.
    // The global endpoint is load-balanced: sendBundle may hit server A while
    // getInflightBundleStatuses hits server B, which has no record of the bundle
    // and immediately returns Invalid. A regional endpoint is sticky.
    // Regions: frankfurt (EU/Africa), amsterdam, ny, tokyo, slc
    rpcUrl: optionalEnv(
      "JITO_RPC_URL",
      "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1"
    ),
    // Slots ahead of the next Jito leader to consider an active leader window.
    // If slotsUntil <= this value the submitter gates on leader-window.
    leaderWindowSlots: parseInt(optionalEnv("JITO_LEADER_WINDOW_SLOTS", "4"), 10),
    // When true the submitter bypasses leader-window gating (emergency use only).
    emergencyOverride: optionalEnv("JITO_EMERGENCY_OVERRIDE", "false") === "true",
    // Minimum tip in lamports for emergency (no-leader-window) submissions.
    emergencyMinTipLamports: parseInt(optionalEnv("JITO_EMERGENCY_MIN_TIP_LAMPORTS", "10000"), 10),
  },
  yellowstone: {
    endpoint: optionalEnv(
      "YELLOWSTONE_ENDPOINT",
      ""
    ),
    token: optionalEnv("YELLOWSTONE_TOKEN", ""),
  },
  groq: {
    apiKey: optionalEnv("GROQ_API_KEY", ""),
    model: optionalEnv("GROQ_MODEL", "llama-3.3-70b-versatile"),
  },
  anthropic: {
    apiKey: optionalEnv("ANTHROPIC_API_KEY", ""),
    model: optionalEnv("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  },
  aiProvider: optionalEnv("AI_PROVIDER", "groq") as "groq" | "anthropic",
  wallet: {
    privateKey: requireEnv("WALLET_PRIVATE_KEY"),
  },
  stack: {
    maxRetries: parseInt(optionalEnv("MAX_RETRIES", "3"), 10),
    retryDelayMs: parseInt(optionalEnv("RETRY_DELAY_MS", "2000"), 10),
    bundleCount: parseInt(optionalEnv("BUNDLE_COUNT", "10"), 10),
    logDir: optionalEnv("LOG_DIR", "./logs"),
  },
  tip: {
    // Hard guardrail floor — no tip below this, even after agent decision
    minLamports: parseInt(optionalEnv("MIN_TIP_LAMPORTS", "1000"), 10),
    // Hard guardrail ceiling — no tip above this, even after agent decision
    maxLamports: parseInt(optionalEnv("MAX_TIP_LAMPORTS", "1000000"), 10),
  },
} as const;

export type Network = typeof config.solana.network;