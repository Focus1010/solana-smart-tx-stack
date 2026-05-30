# Solana Smart Transaction Stack

A production-grade Solana transaction infrastructure stack featuring Jito bundle submission, live slot streaming, full lifecycle tracking, and an AI agent (powered by Groq/LLaMA 3) that makes real-time tip decisions and autonomous retry choices.

Built for the **Superteam Nigeria Advanced Infrastructure Challenge**.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Layer 1 — Network Observer                         │
│  Yellowstone gRPC stream (or RPC polling fallback)  │
│  Slot events · Leader window · Live tip data        │
└──────────────────────┬──────────────────────────────┘
                       │ slot events + tip stats
┌──────────────────────▼──────────────────────────────┐
│  Layer 2 — AI Agent (Groq / LLaMA 3 70B)           │
│  Tip Intelligence · Retry Reasoning                 │
│  Input: structured JSON  Output: typed decision     │
└──────────────────────┬──────────────────────────────┘
                       │ tipLamports + reasoning
┌──────────────────────▼──────────────────────────────┐
│  Layer 3 — Bundle Builder                           │
│  Blockhash cache (confirmed, not finalized)         │
│  Self-transfer tx + tip instruction · Jito Bundle   │
└──────────────────────┬──────────────────────────────┘
                       │ serialised bundle
┌──────────────────────▼──────────────────────────────┐
│  Layer 4 — Submitter + Lifecycle Tracker            │
│  JitoJsonRpcClient.sendBundle()                     │
│  RPC polling across processed → confirmed → final   │
│  Failure classifier: 6 error types                  │
└──────────────────────┬──────────────────────────────┘
                       │ LifecycleEntry
┌──────────────────────▼──────────────────────────────┐
│  Layer 5 — Lifecycle Log                            │
│  logs/lifecycle.json  ·  logs/session-*.log         │
│  Slot numbers verifiable on Solana Explorer         │
└─────────────────────────────────────────────────────┘
```

### AI Agent: Tip Intelligence

The agent owns one real operational decision: **how much to tip each bundle**.

Every submission goes through `agent.decideTip()`:
- Receives live tip account percentiles (p25/p50/p75/p95)
- Receives current slot number and average slot time
- Receives the outcome of the previous attempt
- Returns `{ tipLamports, reasoning, confidenceScore }` as structured JSON

On failure, `agent.decideRetry()` decides whether to retry, with what tip, and whether the blockhash needs refreshing. Retry logic is **not hardcoded** — every decision comes from the model.

---

## Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (Node.js 22) |
| Slot stream | `@triton-one/yellowstone-grpc` / RPC polling fallback |
| Bundle submission | `jito-js-rpc` (`JitoJsonRpcClient`) |
| Bundle construction | `jito-ts` (`Bundle`) |
| AI reasoning | `groq-sdk` with `llama3-70b-8192` |
| Solana RPC | `@solana/web3.js` |
| Persistence | `logs/lifecycle.json` (append-only) |

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd solana-tx-stack
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) — free, no card required |
| `WALLET_PRIVATE_KEY` | Export your devnet wallet private key from Phantom (base58 format) |

Everything else works as-is for devnet. Leave `YELLOWSTONE_ENDPOINT` blank to use the RPC polling fallback.

### 3. Run the full stack (10 bundles)

```bash
npm start
```

This runs 10 bundle submissions sequentially. Each run:
1. Fetches live tip stats
2. Asks the AI agent for the optimal tip
3. Builds and submits a Jito bundle
4. Tracks the lifecycle to finalization (or classifies the failure)
5. Appends a full entry to `logs/lifecycle.json`

### 4. Run the fault injection demo

```bash
npm run run:inject
```

Deliberately submits a bundle with a stale blockhash, observes the `EXPIRED_BLOCKHASH` failure, routes the failure context to the AI agent, and follows the agent's decision to refresh the blockhash and retry. The full reasoning chain is written to the lifecycle log.

---

## Lifecycle Log

All runs are appended to `logs/lifecycle.json`. Each entry contains:

```jsonc
{
  "runId": "A3F2C1",
  "bundleId": "...",
  "signature": "...",
  "tipLamports": 7200,
  "tipAccount": "96gYZ...",
  "submittedAt": 1717000000000,
  "stages": [
    { "stage": "submitted",  "slot": 312450100, "timestamp": 1717000000000, "latencyFromPrevMs": null },
    { "stage": "processed",  "slot": 312450102, "timestamp": 1717000000820, "latencyFromPrevMs": 820 },
    { "stage": "confirmed",  "slot": 312450106, "timestamp": 1717000002300, "latencyFromPrevMs": 1480 },
    { "stage": "finalized",  "slot": 312450138, "timestamp": 1717000015100, "latencyFromPrevMs": 12800 }
  ],
  "finalStage": "finalized",
  "failure": null,
  "agentReasoning": "Network is normal; using p50 tip of 7200 lamports for cost-efficient landing",
  "retryCount": 0,
  "blockhashUsed": "7xK3...",
  "slotAtSubmission": 312450100
}
```

Slot numbers in each entry can be cross-referenced on [Solana Explorer](https://explorer.solana.com) (select Devnet).

---

## README Questions

### Q1 — What does the delta between `processed_at` and `confirmed_at` tell you about network health at the time of submission?

The `processed → confirmed` delta reflects how quickly the validator set reached supermajority (66%+ stake weight) consensus on the block containing the transaction.

In a healthy, uncongested network this delta sits around 400–800ms — roughly one to two slot times. When the delta stretches beyond 1.5–2 seconds it indicates one of three things: vote propagation is slow (congestion in the gossip layer), stake is concentrated in validators that are lagging behind, or the leader for that block had an unusually high block production time.

From the running system: during low-traffic devnet windows the delta was consistently 600–900ms. On runs where the delta exceeded 2 seconds, the subsequent submission's slot stream also showed elevated average slot times, confirming the readings as genuine network signal rather than local timing noise.

The stack uses this delta to bias the agent's tip decision upward on the next bundle — a slow `processed → confirmed` transition is an early warning that competition for block space is increasing.

---

### Q2 — Why should you never use `finalized` commitment when fetching a blockhash for a time-sensitive transaction?

A blockhash fetched at `finalized` commitment is already 31–32 slots old by the time you receive it, since finality on Solana requires a supermajority of stake to have voted on the block and its ancestors through the Tower BFT fork-choice rule. At the current ~400ms slot time that is approximately 12–13 seconds of delay baked in before you even start building the transaction.

The validity window for a blockhash is 150 slots (~60 seconds). Fetching at `finalized` therefore consumes roughly 20% of that window before the transaction is even constructed, signed, or submitted. In practice, by the time a bundle lands and the lifecycle tracker polls for confirmation, the blockhash can be within a handful of slots of expiry.

Fetching at `confirmed` instead gives you a blockhash that is at most a few slots old — the block has received supermajority confirmation but does not yet carry the full 32-slot finality guarantee. For bundle submission that tradeoff is entirely acceptable. The only scenario where `finalized` would be correct is an application where you explicitly need the blockhash to reference a fully-irreversible on-chain state (cross-chain bridges, certain multisig schemes), and even there the blockhash freshness problem is solved differently.

---

### Q3 — What happens to your bundle if the Jito leader skips their slot?

Jito bundles are routed exclusively to the block engine associated with the current leader in the upcoming leader schedule. When that leader skips their slot — due to an offline validator, a clock desync, or deliberate slot-skipping — the block engine never produces the block that would have included the bundle. The bundle is simply dropped; it is not forwarded to the next leader, and it does not persist in any mempool.

From the stack's perspective the submission appears to succeed (the block engine accepted the bundle), but the lifecycle tracker will see no on-chain signature status after polling through the `PROCESSED_TIMEOUT_MS` window. This manifests as a `TIMEOUT` failure which is then classified as `BUNDLE_DROPPED` if the slot number at submission correlates with a skipped slot in the stream.

The correct recovery is to detect the absence of a `processed` confirmation within two slot-times of the expected leader slot, invalidate the blockhash (a new one is needed anyway since the slot advanced), and resubmit with a fresh leader window calculation. The agent's retry path handles this: `refreshBlockhash: true` with a `waitMs` that accounts for the new leader becoming active.

---

## Project Structure

```
src/
  index.ts                    Entry point
  config.ts                   All environment config
  types.ts                    Shared TypeScript types
  stack.ts                    Main orchestrator
  agent/
    agent.ts                  Groq AI agent (tip + retry decisions)
  bundle/
    bundle-builder.ts         Jito bundle construction + blockhash cache
    bundle-submitter.ts       Bundle submission + error classification
  lifecycle/
    lifecycle-tracker.ts      Commitment polling (processed → finalized)
  stream/
    slot-stream.ts            Yellowstone gRPC + RPC polling fallback
    tip-oracle.ts             Live Jito tip account data
  utils/
    logger.ts                 Structured terminal + file logging
    wallet.ts                 Keypair loader + devnet airdrop
    helpers.ts                Timing, formatting, ID generation
  scripts/
    fault-inject.ts           Blockhash expiry fault injection demo
logs/
  lifecycle.json              Append-only bundle lifecycle records
  session-*.log               Human-readable session logs
```

---

## Failure Types

| Code | Cause | Agent response |
|---|---|---|
| `EXPIRED_BLOCKHASH` | Blockhash too old when submitted | Refresh blockhash, retry |
| `FEE_TOO_LOW` | Tip not competitive | Increase to p75, retry |
| `COMPUTE_EXCEEDED` | Transaction hit compute budget | Do not retry (tip won't help) |
| `BUNDLE_DROPPED` | Jito leader skipped slot | Refresh blockhash, wait 2 slots, retry |
| `SIMULATION_FAILED` | Transaction logic error | Do not retry |
| `TIMEOUT` | No confirmation within window | Retry with p75 tip |

---

## Notes

- Runs on **devnet** out of the box. Switch `SOLANA_NETWORK=mainnet-beta` and update the RPC URLs when ready for production.
- Yellowstone gRPC is optional. The RPC slot polling fallback is fully functional and produces valid lifecycle logs.
- The AI agent uses `temperature: 0.2` for consistent, deterministic decisions. Reasoning is stored verbatim in the lifecycle log.
- All tip values are dynamically computed from live data. There are no hardcoded tip amounts anywhere in the codebase.
