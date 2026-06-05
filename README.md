# solana-smart-tx-stack

A Solana transaction infrastructure stack built for the Superteam Nigeria Advanced Infrastructure Challenge. It submits Jito bundles, tracks transaction lifecycle across all commitment levels, classifies failures by type, and uses an AI agent to make real tip and retry decisions on every run.

Everything the agent decides gets written to the lifecycle log with full reasoning.

---

## What it actually does

When you run `npm start`, the stack does this for each of the 10 bundle submissions:

1. Calls `getRecentPrioritizationFees()` on devnet to get real fee data from recent blocks
2. Sends that data to a Groq/LLaMA 3.3 agent which decides the exact tip in lamports and writes its reasoning
3. Fetches a fresh blockhash at `confirmed` commitment (never `finalized`)
4. Builds a Jito bundle with a self-transfer transaction and tip instruction
5. Sends a real devnet transaction via `sendAndConfirmTransaction()` so there is always a verifiable on-chain signature regardless of whether the Jito bundle lands
6. Attempts bundle submission to the Jito block engine
7. Polls `getSignatureStatus()` across `processed`, `confirmed`, and `finalized` stages, recording the slot number and timestamp at each stage
8. If something fails, the failure type gets classified and routed back to the agent which decides whether to retry, with what tip, and whether the blockhash needs refreshing

All of this gets written to `logs/lifecycle.json`. Every signature and slot number in that file is verifiable on Solana Explorer (devnet).

---

## Architecture

```
Layer 1  Network Observer
         Yellowstone gRPC stream (or RPC polling fallback)
         Captures live slot events, slot timing history, tip fee data

         |
         v

Layer 2  AI Agent  (Groq llama-3.3-70b-versatile)
         decideTip()   -- receives tip percentiles + slot conditions
                       -- returns tipLamports + reasoning + confidence
         decideRetry() -- receives failure type + network state
                       -- returns shouldRetry + newTip + waitMs

         |
         v

Layer 3  Bundle Builder
         BlockhashCache  -- fetches at confirmed, refreshes every 100 slots
         BundleBuilder   -- self-transfer tx + tip ix + Bundle wrapper

         |
         v

Layer 4  Submitter + Lifecycle Tracker
         BundleSubmitter    -- sendBundle() via JitoJsonRpcClient
         LifecycleTracker   -- polls processed -> confirmed -> finalized
         FailureClassifier  -- 6 failure types, feeds back to agent

         |
         v

Layer 5  Lifecycle Log
         logs/lifecycle.json   append-only, one entry per run
         logs/session-*.log    human-readable terminal output
```

### AI agent design

The agent is not a wrapper around hardcoded logic. Each method builds a structured prompt from real runtime data, calls the model at `temperature: 0.2` for consistent output, and parses the JSON response back into typed decisions.

`decideTip()` looks at the p25/p50/p75/p95 of recent prioritization fees, the average slot time from the last 20 slots, and the outcome of the previous attempt. It returns a specific lamport amount with a one-sentence justification. Safety bounds are applied after the model responds so the output can never go below 1000 lamports or above 500000 lamports regardless of what the model returns.

`decideRetry()` receives the failure type, retry count, and current tip stats. It tells the stack whether to retry at all, what tip to use, whether the blockhash needs refreshing, and how long to wait. `SIMULATION_FAILED` and `COMPUTE_EXCEEDED` always return `shouldRetry: false` because a higher tip will not fix those. Everything else gets reasoned through per run.

---

## Jito on devnet

Jito does not operate a block engine on devnet. Every bundle submission will be rejected with `NOTFOUND devnet.block-engine.jito.wtf`. This is expected and documented. The bundle attempt is still made and logged honestly on every run.

To compensate, the stack sends a real devnet transaction alongside every bundle attempt using `sendAndConfirmTransaction()`. This means every lifecycle log entry has a real confirmed signature with real slot numbers that judges can verify on explorer. The Jito submission is separate and its outcome is recorded accurately.

If you have mainnet SOL and want to test real bundle landing, update `SOLANA_NETWORK`, `SOLANA_RPC_URL`, and `JITO_RPC_URL` in `.env` and the bundles will attempt to land on mainnet.

---

## Yellowstone gRPC

Yellowstone is supported but optional. If `YELLOWSTONE_ENDPOINT` is set, the stack will attempt to connect using `@triton-one/yellowstone-grpc`. If the connection fails after 3 attempts it logs a warning and continues with RPC polling. The slot poller hits `getSlot()` every 400ms and produces identical lifecycle logs.

To use Yellowstone, set these in `.env`:

```
YELLOWSTONE_ENDPOINT=your-endpoint.example.com:443
YELLOWSTONE_TOKEN=your-token
```

---

## Setup

### Requirements

- Node.js 18+
- A Groq API key (free at console.groq.com, no card needed)
- A Solana devnet wallet private key in base58 format

### Install

```bash
git clone https://github.com/YOUR_USERNAME/solana-smart-tx-stack
cd solana-smart-tx-stack
npm install
```

### Configure

```bash
cp .env.example .env
```

Open `.env` and fill in two values:

```
GROQ_API_KEY=your_groq_key_here
WALLET_PRIVATE_KEY=your_base58_private_key_here
```

Everything else is pre-configured for devnet. The wallet will be airdropped 0.5 devnet SOL automatically on first run if the balance is below 0.1 SOL.

To generate a fresh burner wallet:

```bash
node -e "
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const kp = Keypair.generate();
console.log('Public:', kp.publicKey.toBase58());
console.log('Private:', bs58.default.encode(kp.secretKey));
"
```

### Run the stack

```bash
npm start
```

Runs 10 bundle submissions. Output goes to terminal and `logs/lifecycle.json`.

### Run the fault injection demo

```bash
npm run run:inject
```

Submits a bundle with a deliberately stale blockhash to force an `EXPIRED_BLOCKHASH` failure. The agent observes the failure, decides to refresh the blockhash and retry with an updated tip, and the full reasoning chain is written to the lifecycle log. This is the required failure case demonstration.

---

## Lifecycle log

Every run appends one entry to `logs/lifecycle.json`. The format:

```json
{
  "runId": "D584DD",
  "bundleId": null,
  "signature": "rRnhpT7J...",
  "tipLamports": 2000,
  "tipAccount": "96gYZG...",
  "submittedAt": 1780623061981,
  "stages": [
    { "stage": "submitted",  "slot": 467217664, "timestamp": 1780623061981, "latencyFromPrevMs": null },
    { "stage": "processed",  "slot": 467217664, "timestamp": 1780623062213, "latencyFromPrevMs": 232 },
    { "stage": "confirmed",  "slot": 467217664, "timestamp": 1780623062234, "latencyFromPrevMs": 21 },
    { "stage": "finalized",  "slot": 467217664, "timestamp": 1780623074397, "latencyFromPrevMs": 12163 }
  ],
  "finalStage": "confirmed",
  "failure": "UNKNOWN",
  "agentReasoning": "Using p50 as baseline due to normal network conditions and no previous outcome.",
  "retryCount": 0,
  "blockhashUsed": "Fo5nJctS...",
  "slotAtSubmission": 467217664
}
```

To verify any entry on-chain, take the `signature` value and go to:

```
https://explorer.solana.com/tx/SIGNATURE?cluster=devnet
```

Slot numbers can also be verified directly on explorer. The slot at `processed` stage and the slot at `finalized` stage should be consistent with the ~32 slot gap that Solana's Tower BFT requires for finality.

---

## README questions

### Q1: What does the delta between processed_at and confirmed_at tell you about network health at the time of submission?

The processed to confirmed delta measures how long it took the validator set to reach supermajority vote on the block. Supermajority means 66%+ of stake weight has voted, which is what Tower BFT requires before a block moves from processed to confirmed.

On a healthy devnet this delta is usually 15 to 25ms because devnet has low validator count and minimal vote propagation overhead. On mainnet a healthy delta is 400 to 800ms, roughly one to two slot times. When the delta stretches past 1.5 seconds on mainnet it means either vote propagation is slow due to gossip layer congestion, some high-stake validators are lagging, or the leader had a slow block production time.

From the actual runs in this stack: the processed to confirmed delta across 10 devnet submissions was consistently 17 to 22ms, and confirmed to finalized was consistently around 12 seconds, which lines up with the expected 32-slot finality window at roughly 400ms per slot.

The stack feeds this delta into the agent as part of the slot timing history. A rising delta on successive runs is a signal to increase the tip because it suggests growing competition for block space.

### Q2: Why should you never use finalized commitment when fetching a blockhash for a time-sensitive transaction?

A blockhash at finalized commitment is already 31 to 32 slots behind the current tip of the chain when you receive it. That is because finality on Solana requires a full Tower BFT vote lockout cycle, which takes approximately 32 slots at the current slot timing. At 400ms per slot that is around 13 seconds of staleness baked in before you have even started building your transaction.

A blockhash is valid for 150 slots from when it was included in a block. Fetching at finalized immediately burns roughly 20% of that window. By the time you construct the transaction, sign it, serialize it, submit it to the Jito block engine, wait for the leader window, and have the bundle land and confirm, you might have 10 to 15 slots of validity remaining.

This is how EXPIRED_BLOCKHASH failures happen in production. The blockhash was valid when you fetched it but expired before the transaction landed.

Fetching at confirmed is the correct choice. The block has received supermajority vote so it is extremely unlikely to be rolled back, and the blockhash is only 2 to 4 slots old. This is what the BlockhashCache in this stack does. The cache fetches at confirmed and proactively refreshes every 100 slots so you are never submitting with a blockhash that is close to expiry.

### Q3: What happens to your bundle if the Jito leader skips their slot?

Jito bundles are routed to a specific leader via the block engine. When that leader skips their slot, the block engine does not forward the bundle to the next leader and there is no mempool for it to sit in. The bundle is dropped.

From the stack's perspective the submission may have returned a bundle ID from the block engine, indicating the bundle was accepted for that leader window. But the lifecycle tracker will poll getSignatureStatus() and find nothing. After the PROCESSED_TIMEOUT_MS window elapses with no confirmation, the failure gets classified as TIMEOUT, which maps to BUNDLE_DROPPED in the context of a known leader skip.

The recovery path is to detect the absence of a processed confirmation within two slot-times of the expected leader slot, invalidate the cached blockhash since the slot has advanced, and resubmit targeting the next available leader window. The agent handles this via decideRetry() with refreshBlockhash: true and a waitMs value that gives the new leader time to become active. This is also why the stack maintains a slot event stream rather than just polling on demand. Knowing the current slot in real time is what makes the timing of the retry decision accurate.

---

## Failure types

| Code | What happened | What the agent does |
|---|---|---|
| EXPIRED_BLOCKHASH | Blockhash too old at submission time | Refresh blockhash, retry |
| FEE_TOO_LOW | Tip was not competitive enough | Increase to p75, retry |
| COMPUTE_EXCEEDED | Transaction hit compute budget limit | Do not retry, tip cannot fix this |
| BUNDLE_DROPPED | Jito leader skipped their slot | Refresh blockhash, wait 2 slot-times, retry |
| SIMULATION_FAILED | Transaction logic error | Do not retry, logic must be fixed first |
| TIMEOUT | No confirmation within tracking window | Retry with p75 tip |

---

## Project structure

```
src/
  index.ts                 entry point
  config.ts                all environment variables
  types.ts                 shared TypeScript types
  stack.ts                 main orchestrator
  agent/
    agent.ts               Groq AI agent, tip and retry decisions
  bundle/
    bundle-builder.ts      Jito bundle construction, blockhash cache
    bundle-submitter.ts    bundle submission, error classification
  lifecycle/
    lifecycle-tracker.ts   commitment polling, processed to finalized
  stream/
    slot-stream.ts         Yellowstone gRPC with RPC polling fallback
    tip-oracle.ts          live prioritization fee data from devnet RPC
  utils/
    logger.ts              structured terminal output and file logging
    wallet.ts              keypair loader, devnet airdrop
    helpers.ts             timing, formatting, ID generation
  scripts/
    fault-inject.ts        blockhash expiry fault injection demo
logs/
  lifecycle.json           append-only bundle run records
  session-*.log            terminal session logs
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | Yes | From console.groq.com |
| `WALLET_PRIVATE_KEY` | Yes | Base58 encoded private key |
| `SOLANA_NETWORK` | No | devnet (default) or mainnet-beta |
| `SOLANA_RPC_URL` | No | Defaults to api.devnet.solana.com |
| `JITO_RPC_URL` | No | Defaults to mainnet block engine |
| `YELLOWSTONE_ENDPOINT` | No | Leave blank to use RPC polling |
| `YELLOWSTONE_TOKEN` | No | Required only if endpoint is set |
| `GROQ_MODEL` | No | Defaults to llama-3.3-70b-versatile |
| `BUNDLE_COUNT` | No | Number of submissions, default 10 |
| `MAX_RETRIES` | No | Max retries per bundle, default 3 |

---

## License

MIT
