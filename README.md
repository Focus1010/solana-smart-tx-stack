# solana-smart-tx-stack

![node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)
![typescript](https://img.shields.io/badge/TypeScript-strict-blue)
![solana](https://img.shields.io/badge/Solana-mainnet--beta-9945FF)
![jito](https://img.shields.io/badge/Jito-jito--ts%20SDK-orange)
![license](https://img.shields.io/badge/license-MIT-green)

A production-grade Solana transaction infrastructure stack built for the Superteam Nigeria Advanced Infrastructure Challenge. It submits Jito bundles, streams live slot data via Yellowstone gRPC, uses stream-first commitment tracking with RPC fallback when the stream times out, detects Jito leader windows, captures network conditions at the moment of every submission, classifies failures into 15 distinct types, and uses an AI agent (Groq / LLaMA 3.3 70B) to make tip and retry decisions with full reasoning written to the lifecycle log on every run.

No hardcoded submitted tip values. Retry decisions are made through the agent path with classifier-grounded guardrails. Commitment tracking is stream-first, with RPC fallback only when the stream cannot resolve a stage before timeout. Every agent decision is auditable in `logs/lifecycle.json`.

---

## Bounty Implementation Map

| Area | Requirement | Implementation |
|--------|-------------|----------------|
| Built | Live slot and leader monitoring via Yellowstone gRPC | `src/stream/slot-stream.ts` |
| Built | Correct slot streaming with reconnect and backpressure | `src/stream/slot-stream.ts` (ping keepalive, fromSlot replay, exponential backoff) |
| Built | RPC polling fallback when gRPC unavailable | `src/stream/slot-stream.ts` (SlotPoller class) |
| Built | Leader window detection | `src/jito/leader-window-detector.ts` (getNextScheduledLeader) |
| Built | Jito bundle construction with jito-ts SDK | `src/bundle/bundle-builder.ts` |
| Built | Dynamic tips from live data (not hardcoded) | `src/stream/tip-oracle.ts` (Jito tip floor API + RPC fallback) |
| Built | Stream-first commitment confirmation with fallback | `src/lifecycle/commitment-tracker.ts` |
| Built | Full lifecycle tracking: processed, confirmed, finalized | `src/lifecycle/lifecycle-tracker.ts` |
| Built | Failure detection and classification (15 types) | `src/bundle/failure-classifier.ts` |
| Built | Automatic retry with blockhash refresh | `src/stack.ts` (agent-driven loop) |
| Built | AI agent with real per-run decisions | `src/agent/agent.ts` (decideTip + decideRetry) |
| Built | Agent reasoning visible in logs | `logs/lifecycle.json` (agentReasoning field) |
| Built | Network conditions captured at submission | `src/stream/network-state-observer.ts` |
| Built | 10+ bundle submissions with lifecycle log | `logs/lifecycle.json` |
| Built | 3 classified failure cases (fault injection) | `src/scripts/fault-inject.ts` |
| Built | Blockhash at confirmed commitment (never finalized) | `src/bundle/bundle-builder.ts` (BlockhashCache) |
| Built | Clean AI / stack separation | `src/agent/` vs `src/stack.ts` |
| Built | Network conditions captured at submission AND confirmation (delta analysis) | `src/stream/network-state-observer.ts`, `LifecycleEntry.deltaFromSubmissionToConfirmation` |
| Built | Reactive event-triggered submissions (Marinade Finance) | `src/stream/marinade-event-stream.ts` + `Stack.runWithMarinadeTriggering()` |
| Built | 15 advanced failure types including ACCOUNT_NOT_FOUND, INSTRUCTION_ERROR, BLOCKHASH_NOT_FOUND | `src/bundle/failure-classifier.ts` |
| Built | Network load proxies derived from real observations (no estimated/public-metric placeholders) | `src/stream/network-state-observer.ts` (bundleLandingRate, feeDispersionRatio, validatorLoadProxy) |
| Built | Mainnet observation report generator | `src/scripts/generate-mainnet-report.ts` |
| Built | Architecture document | `ARCHITECTURE.md` + Notion public URL |
| Built | Verification report | `evidence/verification-report.md` |
| Built | MIT license | `LICENSE` |

This table maps implementation coverage. The current proof quality is generated separately by `npm run generate:evidence` and checked by `npm run evidence:audit`. If the audit reports missing explorer URLs, non-zero slots, dynamic tips, or fault metadata, rerun the stack and fault injection before final submission rather than editing logs by hand.

---

## What happens on each run

1. `SlotStream` (Yellowstone gRPC) or `SlotPoller` (RPC fallback) emits the current slot. The stream tracks `latestProcessedSlot`, `latestConfirmedSlot`, and `latestFinalizedSlot` as separate high-water marks so `CommitmentTracker` can resolve commitment from events, not polling.

2. `LeaderWindowDetector` calls `getNextScheduledLeader()` on the Jito block engine to find out how many slots remain until the next Jito-connected leader.

3. `TipOracle` fetches the Jito tip floor API (`bundles.jito.wtf/api/v1/bundles/tip_floor`) for live auction percentiles. Falls back to `getRecentPrioritizationFees()` on devnet.

4. `NetworkStateObserver` captures block production rate, slot skip rate, p50/p90 confirmation latency from rolling history, and current RPC fee percentiles.

5. A full `NetworkSnapshot` is assembled: slot, avg slot time, failure rate, leader window, confirmation latency, and raw network conditions.

6. `Agent.decideTip()` receives the complete snapshot and returns a tip with 3-5 sentences of reasoning that names the specific percentile chosen, the lamport value, the congestion multiplier, the leader urgency multiplier, and the estimated landing probability.

7. `BundleBuilder` constructs the bundle with a `confirmed` blockhash and the agent-decided tip.

8. A real transaction is submitted via `sendAndConfirmTransaction()` so every run has a verifiable on-chain signature.

9. `BundleSubmitter` attempts the Jito bundle. On devnet this is always rejected since Jito does not run a devnet block engine. The error is classified by `AdvancedFailureClassifier`.

10. `LifecycleTracker` tracks commitment via `CommitmentTracker` (stream events), falling back to RPC polling if the stream times out for a stage.

11. On any failure, `Agent.decideRetry()` receives the `FailureClassification` and decides whether to retry, with what tip, whether to refresh the blockhash, and how long to wait.

12. The complete `LifecycleEntry` is written to `logs/lifecycle.json` including explorer URL, latency breakdown per stage, leader window snapshot, network conditions, and agent reasoning.

---

## Architecture

```
+--------------------------------------------------------------+
|  LAYER 1  Network Observer                                   |
|                                                              |
|  SlotStream (Yellowstone gRPC)                               |
|    - https:// endpoint prefix                                |
|    - Ping keepalive every 30s (prevents cloud drop)          |
|    - fromSlot replay on reconnect                            |
|    - Separate HWM: latestProcessedSlot                       |
|                    latestConfirmedSlot                       |
|                    latestFinalizedSlot                       |
|    - Dead slot detection                                     |
|    - Exponential backoff, 3 attempts then fallback           |
|                                                              |
|  SlotPoller (RPC fallback)                                   |
|    - getSlot(processed) every 400ms                          |
|    - getSlot(confirmed+finalized) every 5 cycles             |
|                                                              |
|  TipOracle                                                   |
|    - Jito tip floor API (primary, mainnet)                   |
|    - getRecentPrioritizationFees (fallback, any network)     |
|    - p25/p50/p75/p95/p99 with 10s cache                     |
|                                                              |
|  NetworkStateObserver                                        |
|    - Block production rate (rolling 20-slot avg)             |
|    - Slot skip rate                                          |
|    - Confirmation latency p50/p90 from rolling history       |
|                                                              |
|  LeaderWindowDetector                                        |
|    - getNextScheduledLeader() via Jito block engine          |
|    - slotsUntilJitoLeader, isJitoLeaderWindow                |
|    - 2s cache to limit RPC load                              |
+--------------------------------------------------------------+
                              |
                              v   NetworkSnapshot
+--------------------------------------------------------------+
|  LAYER 2  AI Agent (Groq llama-3.3-70b-versatile, t=0.2)   |
|                                                              |
|  decideTip()                                                 |
|    Input: TipStats, NetworkSnapshot, retry context           |
|    Output: tipLamports, reasoning (3-5 sentences),           |
|            congestionMultiplier, leaderUrgencyMultiplier,    |
|            landingProbabilityEstimate, selectedPercentile    |
|                                                              |
|  decideRetry()                                               |
|    Input: FailureClassification, NetworkSnapshot, TipStats   |
|    Output: shouldRetry, action (RecoveryPath),               |
|            newTipLamports, refreshBlockhash, waitMs          |
|                                                              |
|  Safety bounds enforced after every model call               |
|  Hard rules override model (COMPUTE_EXCEEDED never retries)  |
+--------------------------------------------------------------+
                              |
                              v   TipDecision
+--------------------------------------------------------------+
|  LAYER 3  Bundle Builder                                     |
|                                                              |
|  BlockhashCache                                              |
|    - Always fetches at confirmed commitment                  |
|    - Proactive refresh every 100 slots                       |
|    - Force refresh on EXPIRED_BLOCKHASH                      |
|                                                              |
|  BundleBuilder                                               |
|    - Zero-lamport self-transfer (primary instruction)        |
|    - Tip instruction to random Jito tip account              |
|    - jito-ts Bundle wrapper (max 5 txs)                      |
+--------------------------------------------------------------+
                              |
                              v   BuiltBundle
+--------------------------------------------------------------+
|  LAYER 4  Submission + Tracking                              |
|                                                              |
|  DevnetTx: sendAndConfirmTransaction() -- real on-chain sig  |
|  BundleSubmitter: JitoJsonRpcClient.sendBundle()             |
|  AdvancedFailureClassifier: 15 failure types with confidence |
|  CommitmentTracker: stream-event-based confirmed/finalized   |
|  LifecycleTracker: RPC fallback if stream times out          |
+--------------------------------------------------------------+
                              |
                              v   LifecycleEntry
+--------------------------------------------------------------+
|  LAYER 5  Evidence                                           |
|                                                              |
|  logs/lifecycle.json              append-only run records    |
|  evidence/run-summary.json        aggregated statistics      |
|  evidence/verification-report.md  bounty compliance table   |
+--------------------------------------------------------------+
```

---

## Setup

### Requirements

- Node.js 20.11+
- A Groq API key (free at console.groq.com, no card required)
- A Solana wallet private key in base58 format

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

Required values:

```
GROQ_API_KEY=your_key_here
WALLET_PRIVATE_KEY=your_base58_key_here
```

Everything else defaults to devnet. On first run the wallet is auto-airdropped 0.5 devnet SOL if balance is below 0.1 SOL.

For mainnet (recommended for full evidence):

```
SOLANA_NETWORK=mainnet-beta
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WS_URL=wss://api.mainnet-beta.solana.com
JITO_RPC_URL=https://mainnet.block-engine.jito.wtf/api/v1
```

### Generate a fresh burner wallet

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

1. `EXPIRED_BLOCKHASH` -- stale blockhash injected, classifier detects it with 97% confidence, agent decides to refresh blockhash and retry
2. `FEE_TOO_LOW` -- intentionally underpriced tip, classifier detects with 91% confidence, agent increases to p75 and retries
3. `COMPUTE_EXCEEDED` -- compute budget set to 1 unit, classifier detects with 95% confidence, agent correctly aborts (tip cannot fix compute budget errors)

### Marinade-triggered submissions (mainnet only)

```bash
npm run run:marinade
```

Listens for real Marinade Finance staking events (Deposit/Unstake) on mainnet via `onLogs()`. When a staking event of 1 SOL or more is detected, the stack submits a bundle in response and tags the lifecycle entry with the triggering event's signature, amount, and slot. This demonstrates the stack operating as reactive infrastructure rather than a fixed-schedule runner.

Marinade Finance (`MarBmsSgKXdrQP1zU937A8bLnSZ3xq4b5VW6dcjpyQ`) is the largest liquid staking protocol on Solana. Staking and unstaking transactions above the 1 SOL trigger represent real user transaction flow and can correlate with short-term network load changes -- exactly the kind of condition the tip-intelligence agent is designed to react to.

This script requires `SOLANA_NETWORK=mainnet-beta`. Marinade does not operate on devnet, so this mode has no devnet equivalent.

### Generate evidence report

```bash
npm run generate:evidence
```

Produces `evidence/run-summary.json` and `evidence/verification-report.md` from `logs/lifecycle.json`. Includes network condition delta analysis (block production rate and fee percentile changes between submission and confirmation) and a breakdown of any Marinade-triggered runs.

### Generate mainnet observation report

```bash
npm run generate:mainnet-report
```

After running on mainnet (`SOLANA_NETWORK=mainnet-beta npm start`), this produces `evidence/mainnet-observations.md` containing real p50/p90/p99 processed-to-confirmed latencies, block production rate percentiles, a per-run table, and an updated README Q1 answer using only values this stack actually observed. If no mainnet entries exist yet, it writes an honest placeholder explaining how to generate the report rather than fabricating numbers.

---

## Data integrity policy

Every number in `logs/lifecycle.json`, `evidence/run-summary.json`, `evidence/verification-report.md`, and `evidence/mainnet-observations.md` is either:

1. Read directly from a Solana RPC or Jito API call made by this stack, or
2. Derived by simple arithmetic from values in category 1, with the derivation documented in code comments

Three fields in `NetworkConditions` (`bundleLandingRate`, `feeDispersionRatio`, `validatorLoadProxy`) are explicitly labeled as derived proxies rather than direct measurements. `bundleLandingRate` is this stack's own rolling success rate over its last 10 runs, not a network-wide statistic. `feeDispersionRatio` is the p95/p25 ratio of real prioritization fees observed via `getRecentPrioritizationFees()`. `validatorLoadProxy` is derived from observed slot timing versus the 400ms target. None of these are hardcoded estimates or figures sourced from third-party dashboards.

The mainnet observation report (`evidence/mainnet-observations.md`) is only populated after a real mainnet run. Before that, it contains an explanation of how to generate it rather than placeholder numbers.

---

## README questions

### Q1: What does the delta between processed_at and confirmed_at tell you about network health?

The processed to confirmed delta measures the time for the validator set to reach supermajority consensus (66%+ stake weight) on the block. When this is short, the gossip layer is healthy and vote propagation is fast. When it stretches, it signals one or more of: validators under load, gossip packet loss, or clock drift causing vote timing issues.

On devnet runs in this stack the delta was consistently 17-22ms because devnet has far fewer validators and near-zero propagation overhead. On mainnet the expected range is 250-400ms under normal load, rising to 500ms-1s during congestion periods.

This stack feeds a rolling p50 and p90 of recent processed-to-confirmed deltas into the agent via `NetworkSnapshot`. When the p90 rises significantly above the p50, it indicates the tail of the distribution is getting worse -- meaning some blocks are taking much longer to confirm than average. The agent uses this to increase its congestion multiplier and tip higher on the next bundle.

### Q2: Why should you never use finalized commitment when fetching a blockhash?

A blockhash at finalized commitment is already 31-32 slots old when you receive it. Finality requires a full Tower BFT vote lockout cycle, approximately 32 slots at 400ms per slot, which is 13 seconds of built-in staleness before you have even started constructing the transaction.

A blockhash is valid for 150 slots from its block. Fetching at finalized burns over 20% of that window before the transaction is built, signed, or submitted. On a busy network with retry loops this easily results in EXPIRED_BLOCKHASH failures.

`BlockhashCache` in this stack always calls `getLatestBlockhash("confirmed")`. The block has supermajority vote so rollback probability is negligible, and the blockhash is only 2-4 slots old when you receive it. The cache also refreshes proactively every 100 slots so the hash is never close to expiry at submission time.

### Q3: What happens to your bundle if the Jito leader skips their slot?

Bundles are routed to a specific leader via the Jito block engine. When that leader skips their slot the block engine does not forward the bundle to the next leader and there is no mempool for it to wait in. The bundle is dropped.

From the stack's perspective `sendBundle()` may return a bundle ID indicating acceptance, but `LifecycleTracker` will find no on-chain signature after polling through `PROCESSED_TIMEOUT_MS`. The failure is classified as `BUNDLE_DROPPED` with a recommended recovery path of `retry_refresh_blockhash` and a wait of 1600ms (approximately 4 slots at 400ms each, enough for the next leader to become active).

`LeaderWindowDetector` exists to reduce this risk. By checking `slotsUntilJitoLeader` before every submission, the agent knows if the current window is a Jito leader slot. If the next Jito leader is many slots away the agent applies a lower urgency multiplier and can signal `hold_for_leader` instead of `submit_now`. This is the direct reason why leader window data is part of the agent's tip prompt on every single run.

---

## Failure types

| Code | Cause | Agent recovery |
|---|---|---|
| `EXPIRED_BLOCKHASH` | Blockhash exceeded 150-slot window | Refresh blockhash, retry |
| `BLOCKHASH_NOT_FOUND` | Blockhash never existed in ledger | Refresh blockhash from primary RPC, retry |
| `FEE_TOO_LOW` | Tip lost Jito block auction | Increase to at least p75, retry |
| `COMPUTE_EXCEEDED` | Transaction hit compute budget limit | Abort -- tip cannot fix this |
| `BUNDLE_DROPPED` | Jito leader skipped their slot | Wait 4 slots, refresh, retry |
| `LEADER_SKIPPED` | Same root cause as BUNDLE_DROPPED | Wait 4 slots, refresh, retry |
| `SIMULATION_FAILED` | Transaction failed preflight simulation | Abort -- transaction logic is broken |
| `INSTRUCTION_ERROR` | On-chain instruction returned error code | Abort -- program logic issue |
| `ACCOUNT_IN_USE` | Concurrent transaction holds write lock | Wait 2s, retry same tip |
| `ACCOUNT_NOT_FOUND` | Required account does not exist on-chain | Abort -- requires investigation |
| `INSUFFICIENT_FUNDS` | Payer wallet underfunded | Abort -- requires manual SOL top-up |
| `RATE_LIMITED` | Hit Jito 429 rate limit | Wait 3-5s with jitter, retry |
| `STREAM_DIVERGENCE` | Stream says confirmed but RPC disagrees | Wait 5s for RPC to catch up |
| `TIMEOUT` | No confirmation within tracking window | Retry with p75 tip |
| `UNKNOWN` | Unclassified error | Hold 2s, retry once |

---

## Yellowstone gRPC configuration

The stack implements Yellowstone correctly per the Triton Dragon's Mouth specification:

- Endpoint must have `https://` prefix (auto-prepended if missing)
- Ping frame sent every 30 seconds to prevent cloud provider stream drops
- `fromSlot` set on reconnect to replay missed slots
- Slot status integers decoded correctly: 0=PROCESSED, 1=CONFIRMED, 2=FINALIZED
- Dead slots (status 6) detected and logged separately
- Three independent high-water marks maintained per commitment level
- Graceful fallback to `SlotPoller` after 3 consecutive failures

```
YELLOWSTONE_ENDPOINT=fra.grpc.solinfra.dev:443
YELLOWSTONE_TOKEN=your_token_here
```

---

## Project structure

```
src/
  index.ts                         entry point, graceful shutdown
  config.ts                        environment variables with defaults
  types.ts                         shared TypeScript types across all layers
  stack.ts                         main orchestrator
  agent/
    agent.ts                       Groq AI agent, decideTip and decideRetry
  bundle/
    bundle-builder.ts              Jito bundle construction, BlockhashCache
    bundle-submitter.ts            bundle submission, initial classification
    failure-classifier.ts          AdvancedFailureClassifier, 15 failure types
  jito/
    leader-window-detector.ts      getNextScheduledLeader() from Jito
  lifecycle/
    commitment-tracker.ts          stream-event-based commitment resolution
    lifecycle-tracker.ts           full lifecycle tracking with RPC fallback
  stream/
    slot-stream.ts                 SlotStream (Yellowstone) + SlotPoller (RPC)
    tip-oracle.ts                  Jito tip floor API + getRecentPrioritizationFees
    network-state-observer.ts      block rate, skip rate, confirmation latencies
    marinade-event-stream.ts       Marinade Finance staking event listener
  utils/
    logger.ts                      structured logging, lifecycle.json writer
    wallet.ts                      keypair loader, devnet airdrop
    helpers.ts                     timing, formatting, ID generation
  scripts/
    fault-inject.ts                3 fault type injection demo
    run-marinade.ts                Marinade-triggered submission runner
    generate-evidence.ts           produces evidence/run-summary.json + verification-report.md
    generate-mainnet-report.ts     produces evidence/mainnet-observations.md from mainnet runs
logs/
  lifecycle.json                   append-only run records
  session-*.log                    terminal session logs
evidence/
  run-summary.json                 aggregated run statistics
  verification-report.md           bounty requirement compliance table
  mainnet-observations.md          real mainnet percentile data (after mainnet run)
```

---

## Architecture document

Full architecture with data flow diagrams, infrastructure decisions, and observed latency numbers from the running system:

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
| `YELLOWSTONE_ENDPOINT` | No | | gRPC endpoint (https:// auto-added if missing) |
| `YELLOWSTONE_TOKEN` | No | | Auth token for Yellowstone |
| `GROQ_MODEL` | No | llama-3.3-70b-versatile | Groq model ID |
| `BUNDLE_COUNT` | No | 10 | Bundles per batch run |
| `MAX_RETRIES` | No | 3 | Max retries per bundle |
| `LOG_DIR` | No | ./logs | Directory for lifecycle logs |

---

## License

MIT
