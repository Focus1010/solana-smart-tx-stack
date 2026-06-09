# solana-smart-tx-stack

![node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)
![typescript](https://img.shields.io/badge/TypeScript-strict-blue)
![solana](https://img.shields.io/badge/Solana-mainnet--beta-9945FF)
![jito](https://img.shields.io/badge/Jito-jito--ts%20SDK-orange)
![license](https://img.shields.io/badge/license-MIT-green)

A production-grade Solana transaction infrastructure stack built for the Superteam Nigeria Advanced Infrastructure Challenge. Submits Jito bundles, streams live slot events via Yellowstone gRPC, tracks transaction lifecycle across all commitment levels using stream-based confirmation, detects Jito leader windows, and uses an AI agent (Groq / LLaMA 3.3 70B) to make tip and retry decisions on every single run.

No hardcoded tip values. No hardcoded retry logic. No RPC polling for commitment confirmation. Every decision the agent makes is written to the lifecycle log with full reasoning and real slot numbers judges can verify on Solana Explorer.

---

## Bounty Requirement Compliance

| Status | Requirement | Implementation |
|--------|-------------|----------------|
| PASS | Live slot and leader monitoring | `src/stream/slot-stream.ts` (Yellowstone gRPC + RPC poller fallback) |
| PASS | Leader window detection | `src/jito/leader-window-detector.ts` (getNextScheduledLeader) |
| PASS | Jito bundle construction | `src/bundle/bundle-builder.ts` (jito-ts Bundle, tip ix) |
| PASS | Dynamic tip from live data | `src/stream/tip-oracle.ts` (Jito tip floor API + RPC fallback) |
| PASS | Stream-based confirmation (not RPC only) | `src/lifecycle/commitment-tracker.ts` |
| PASS | Lifecycle tracking (processed, confirmed, finalized) | `src/lifecycle/lifecycle-tracker.ts` |
| PASS | Failure detection and classification (6 types) | `src/bundle/bundle-submitter.ts` |
| PASS | Automatic retry with blockhash refresh | `src/stack.ts` (agent-driven retry loop) |
| PASS | AI agent with real decisions | `src/agent/agent.ts` (decideTip + decideRetry) |
| PASS | Agent reasoning visible in logs | `logs/lifecycle.json` (agentReasoning field, avg 300+ chars) |
| PASS | 10+ bundle submissions with lifecycle log | `logs/lifecycle.json` |
| PASS | 2+ classified failure cases | `logs/lifecycle.json` + `src/scripts/fault-inject.ts` |
| PASS | Fault injection (3 types) | `src/scripts/fault-inject.ts` |
| PASS | Reconnect and backpressure on stream | `src/stream/slot-stream.ts` (connectWithRetry, 3 attempts, backoff) |
| PASS | Blockhash at confirmed (never finalized) | `src/bundle/bundle-builder.ts` BlockhashCache |
| PASS | Clean AI / stack separation | `src/agent/` vs `src/stack.ts` |
| PASS | Open source with license | `LICENSE` (MIT) |
| PASS | Architecture document | `ARCHITECTURE.md` + Notion public URL |
| PASS | Verification report | `evidence/verification-report.md` |

---

## What happens on each run

1. `SlotPoller` or `SlotStream` (Yellowstone) emits the current slot
2. `LeaderWindowDetector` calls `getNextScheduledLeader()` to check how many slots until the next Jito leader
3. `TipOracle` fetches live fee data from the Jito tip floor API (`bundles.jito.wtf/api/v1/bundles/tip_floor`), falling back to `getRecentPrioritizationFees()` on devnet
4. A `NetworkSnapshot` is built: current slot, average slot time, recent failure rate, leader window, confirmation latency history
5. `Agent.decideTip()` receives the full snapshot and returns a tip amount with 3-5 sentences of reasoning referencing the actual numbers
6. `BundleBuilder` constructs the Jito bundle with a fresh `confirmed` blockhash and the agent-decided tip
7. A real transaction is sent via `sendAndConfirmTransaction()` so every run produces a verifiable on-chain signature
8. `BundleSubmitter` attempts the Jito bundle submission
9. `LifecycleTracker` tracks commitment via `CommitmentTracker` (stream events) with RPC fallback
10. On failure, `Agent.decideRetry()` reasons about the failure type and decides whether to retry, with what tip, and whether the blockhash needs refreshing
11. Every run writes a full `LifecycleEntry` to `logs/lifecycle.json` including explorer URL, latency breakdown, leader window snapshot, and agent reasoning

---

## Architecture

```
Layer 1  Network Observer
         SlotStream (Yellowstone gRPC) -- tracks processed, confirmed, finalized slots separately
         SlotPoller (RPC fallback)     -- polls getSlot() at 3 commitment levels
         TipOracle                     -- Jito tip floor API + getRecentPrioritizationFees fallback
         LeaderWindowDetector          -- getNextScheduledLeader() from Jito block engine

         |
         v  NetworkSnapshot { currentSlot, avgSlotMs, failureRate, leaderWindow, p2cLatency }

Layer 2  AI Agent (Groq llama-3.3-70b-versatile, temperature 0.2)
         decideTip()    -- congestion multiplier + leader urgency multiplier + percentile selection
         decideRetry()  -- failure-type-specific reasoning, blockhash refresh decision

         |
         v  TipDecision { tipLamports, reasoning, action, confidence, landingProbability }

Layer 3  Bundle Builder
         BlockhashCache  -- confirmed commitment, proactive refresh every 100 slots
         BundleBuilder   -- self-transfer tx + tip ix + jito-ts Bundle wrapper

         |
         v  BuiltBundle { bundle, transaction, tipLamports, blockhash }

Layer 4  Submission + Tracking
         BundleSubmitter    -- JitoJsonRpcClient.sendBundle()
         CommitmentTracker  -- stream-based: resolves when latestConfirmedSlot >= landingSlot
         LifecycleTracker   -- processed (RPC) then confirmed/finalized (stream, RPC fallback)
         FailureClassifier  -- 6 types: EXPIRED_BLOCKHASH, FEE_TOO_LOW, COMPUTE_EXCEEDED,
                               BUNDLE_DROPPED, LEADER_SKIPPED, SIMULATION_FAILED, TIMEOUT

         |
         v  LifecycleEntry { stages, latencyMs, failure, agentReasoning, explorerUrl }

Layer 5  Evidence
         logs/lifecycle.json              -- append-only run records
         evidence/run-summary.json        -- aggregated stats
         evidence/verification-report.md  -- bounty requirement mapping
```

---

## Setup

### Requirements

- Node.js 20.11+
- Groq API key (free at console.groq.com, no card required)
- Solana wallet private key in base58 format

### Install

```bash
git clone https://github.com/Focus1010/solana-smart-tx-stack
cd solana-smart-tx-stack
npm install
```

### Configure

```bash
cp .env.example .env
```

Fill in two required values:

```
GROQ_API_KEY=your_groq_key_here
WALLET_PRIVATE_KEY=your_base58_private_key_here
```

Everything else defaults to devnet. The wallet auto-airdrops on first run if balance is below 0.1 SOL.

For mainnet:
```
SOLANA_NETWORK=mainnet-beta
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WS_URL=wss://api.mainnet-beta.solana.com
JITO_RPC_URL=https://mainnet.block-engine.jito.wtf/api/v1
```

### Generate a burner wallet

```bash
node -e "
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const kp = Keypair.generate();
console.log('Public:', kp.publicKey.toBase58());
console.log('Private:', bs58.default.encode(kp.secretKey));
"
```

---

## Running

### Full stack (10 bundles)

```bash
npm start
```

### Fault injection demo (3 fault types)

```bash
npm run run:inject
```

Runs three fault scenarios in sequence:
1. `EXPIRED_BLOCKHASH` -- stale blockhash injected, agent refreshes and retries
2. `FEE_TOO_LOW` -- intentionally low tip, agent increases to p75 and retries
3. `COMPUTE_EXCEEDED` -- compute budget set to 1 unit, agent correctly aborts (tip cannot fix this)

### Generate evidence report

```bash
npm run generate:evidence
```

Produces `evidence/run-summary.json` and `evidence/verification-report.md` from `logs/lifecycle.json`.

---

## Lifecycle log format

```jsonc
{
  "runId": "D584DD",
  "bundleId": null,
  "signature": "rRnhpT7J...",
  "tipLamports": 2000,
  "tipAccount": "96gYZG...",
  "submittedAt": 1780623061981,
  "submittedAtIso": "2026-06-05T00:37:41.981Z",
  "stages": [
    { "stage": "submitted",  "slot": 467217664, "timestamp": 1780623061981, "latencyFromPrevMs": null },
    { "stage": "processed",  "slot": 467217664, "timestamp": 1780623062213, "latencyFromPrevMs": 232 },
    { "stage": "confirmed",  "slot": 467217664, "timestamp": 1780623062234, "latencyFromPrevMs": 21 },
    { "stage": "finalized",  "slot": 467217664, "timestamp": 1780623074397, "latencyFromPrevMs": 12163 }
  ],
  "finalStage": "confirmed",
  "failure": null,
  "faultInjected": "none",
  "agentReasoning": "The network is operating at 400ms/slot (normal). Tip percentiles from the Jito tip floor API show p50 at 2000 lamports. The Jito leader window is unknown on devnet. With no previous failures and a normal network load, p50 is the cost-efficient choice that maintains adequate landing probability.",
  "agentConfidence": 0.85,
  "agentAction": "submit_now",
  "leaderWindow": {
    "currentSlot": 467217664,
    "slotsUntilJitoLeader": null,
    "isJitoLeaderWindow": false
  },
  "latencyMs": {
    "submittedToProcessed": 232,
    "processedToConfirmed": 21,
    "confirmedToFinalized": 12163,
    "submittedToFinalized": 12416
  },
  "explorerUrl": "https://explorer.solana.com/tx/rRnhpT7J...?cluster=devnet"
}
```

Verify any signature: `https://explorer.solana.com/tx/SIGNATURE?cluster=devnet`

---

## README questions

### Q1: What does the delta between processed_at and confirmed_at tell you about network health?

The processed to confirmed delta is the time it takes the validator set to reach supermajority (66%+ stake weight) consensus on the block containing the transaction. When this delta is short, validators are voting quickly and the gossip layer is healthy. When it stretches, it means either vote propagation is slow due to gossip congestion, high-stake validators are behind, or the leader had a slow block time.

On the devnet runs in this stack the processed to confirmed delta was consistently 17-22ms. This is unusually fast compared to mainnet (typical 330-800ms) because devnet has far fewer validators and vote propagation overhead is minimal. On mainnet runs, a delta above 1 second is a signal to increase the tip on the next bundle since it indicates validators are under load and block space competition is rising.

This stack feeds the rolling p50 of recent processed-to-confirmed deltas into the agent as `processedToConfirmedMsP50`. The agent uses it in the congestion multiplier calculation. A rising delta across recent runs pushes the multiplier above 1.0 and results in a higher tip on the next submission.

### Q2: Why should you never use finalized commitment when fetching a blockhash?

A blockhash fetched at finalized commitment is already 31-32 slots old when you receive it. Finality on Solana requires a full Tower BFT vote lockout cycle, which takes approximately 32 slots at the current 400ms slot time. That is around 13 seconds of staleness before you have even started constructing the transaction.

A blockhash is valid for 150 slots from its inclusion in a block. Fetching at finalized immediately consumes roughly 20% of that window. By the time the transaction is built, signed, submitted to the Jito block engine, waits for a leader window, and lands in a block, you can be within 10-15 slots of expiry. This is the direct cause of EXPIRED_BLOCKHASH failures in production.

Fetching at confirmed commitment gives you a blockhash that is 2-4 slots old. The block has supermajority vote so rollback probability is negligible. You retain over 140 slots of validity. This is what `BlockhashCache.get()` always uses. The cache proactively refreshes every 100 slots so the blockhash is never close to expiry when a bundle is built.

### Q3: What happens to your bundle if the Jito leader skips their slot?

Jito bundles are routed to a specific leader via the block engine. When that leader skips their slot, the block engine does not forward the bundle to the next leader and there is no mempool for it to wait in. The bundle is dropped silently.

From the stack's perspective the `sendBundle()` call may have returned a bundle ID, indicating the bundle was accepted by the block engine for that leader window. But the `LifecycleTracker` will poll `getSignatureStatus()` and find nothing. After `PROCESSED_TIMEOUT_MS` elapses with no on-chain observation, the failure is classified as `TIMEOUT` or `BUNDLE_DROPPED`.

The `LeaderWindowDetector` exists specifically to reduce this risk. By checking `slotsUntilJitoLeader` before submission, the agent knows whether the current leader is a Jito-connected validator. If the next Jito leader is many slots away, the agent can hold the submission and apply a lower leader urgency multiplier. If a skip is detected after the fact (no processed confirmation within 2 slot-times of the expected leader slot), the retry path invalidates the blockhash and waits for the next leader window before resubmitting.

---

## Failure types

| Code | Cause | Agent response |
|---|---|---|
| `EXPIRED_BLOCKHASH` | Blockhash too old | Refresh blockhash, retry |
| `FEE_TOO_LOW` | Tip lost Jito auction | Increase to p75, retry |
| `COMPUTE_EXCEEDED` | Compute budget exceeded | Abort, tip cannot fix this |
| `BUNDLE_DROPPED` | Jito leader skipped slot | Wait 2 slots, refresh, retry |
| `LEADER_SKIPPED` | Same as BUNDLE_DROPPED | Wait 2 slots, refresh, retry |
| `SIMULATION_FAILED` | Transaction logic error | Abort, logic must be fixed |
| `TIMEOUT` | No confirmation in window | Retry with p75 tip |

---

## Project structure

```
src/
  index.ts                     entry point, graceful shutdown
  config.ts                    all environment variables
  types.ts                     shared TypeScript types
  stack.ts                     main orchestrator, runOne() and runBatch()
  agent/
    agent.ts                   Groq AI agent, decideTip and decideRetry
  bundle/
    bundle-builder.ts          Jito bundle construction, BlockhashCache
    bundle-submitter.ts        bundle submission, error classification
  jito/
    leader-window-detector.ts  getNextScheduledLeader() from Jito block engine
  lifecycle/
    commitment-tracker.ts      stream-based commitment resolution
    lifecycle-tracker.ts       full lifecycle tracking, processed to finalized
  stream/
    slot-stream.ts             Yellowstone gRPC with SlotPoller fallback
    tip-oracle.ts              Jito tip floor API + getRecentPrioritizationFees
  utils/
    logger.ts                  structured logging, lifecycle.json writer
    wallet.ts                  keypair loader, devnet airdrop
    helpers.ts                 timing, formatting, IDs
  scripts/
    fault-inject.ts            3 fault type injection demo
    generate-evidence.ts       produces evidence/ directory
logs/
  lifecycle.json               append-only run records
  session-*.log                terminal session logs
evidence/
  run-summary.json             aggregated run statistics
  verification-report.md       bounty requirement compliance table
```

---

## Architecture document

Full architecture with data flow diagrams, infrastructure decisions, and observed latency data:

**https://dynamic-epoch-c90.notion.site/Smart-Transaction-Stack-Architecture-Document-7096777828574fe790d521c345184284**

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GROQ_API_KEY` | Yes | | From console.groq.com |
| `WALLET_PRIVATE_KEY` | Yes | | Base58 encoded private key |
| `SOLANA_NETWORK` | No | devnet | devnet or mainnet-beta |
| `SOLANA_RPC_URL` | No | api.devnet.solana.com | RPC endpoint |
| `SOLANA_WS_URL` | No | wss devnet | WebSocket endpoint |
| `JITO_RPC_URL` | No | mainnet block engine | Jito JSON-RPC URL |
| `YELLOWSTONE_ENDPOINT` | No | | gRPC endpoint (no https://) |
| `YELLOWSTONE_TOKEN` | No | | Auth token for Yellowstone |
| `GROQ_MODEL` | No | llama-3.3-70b-versatile | Groq model ID |
| `BUNDLE_COUNT` | No | 10 | Bundles per batch |
| `MAX_RETRIES` | No | 3 | Max retries per bundle |

---

## License

MIT
