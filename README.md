#                                         solana-smart-tx-stack

![node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)
![typescript](https://img.shields.io/badge/TypeScript-strict-blue)
![solana](https://img.shields.io/badge/Solana-mainnet--beta-9945FF)
![jito](https://img.shields.io/badge/Jito-jito--ts%20SDK-orange)
![license](https://img.shields.io/badge/license-MIT-green)

A production-grade Solana transaction infrastructure stack built for the Superteam Nigeria Advanced Infrastructure Challenge. It submits Jito bundles, streams live slot data via Yellowstone gRPC, uses stream-first commitment tracking with RPC fallback when the stream times out, detects Jito leader windows, captures network conditions at the moment of every submission, classifies failures into 15 distinct types, and uses an AI agent (Groq / LLaMA 3.3 70B, with optional Anthropic fallback) to make tip and retry decisions with full reasoning written to the lifecycle log on every run.

No hardcoded submitted tip values. Retry decisions are made through the agent path with classifier-grounded guardrails. Commitment tracking is stream-first, with RPC fallback only when the stream cannot resolve a stage before timeout. Every agent decision is auditable in `logs/lifecycle.json`.

This README is built to answer every requirement in the bounty listing directly, with real numbers pulled from this stack's own runs on both devnet and mainnet-beta. Nothing below is estimated or copied from documentation defaults unless explicitly marked as such.

---

## Architecture document

Full architecture with data flow diagrams, infrastructure decisions, and observed latency numbers from the running system:

https://web3focus.notion.site/Smart-Transaction-Stack-Architecture-Document-7096777828574fe790d521c345184284

---

## Table of contents

- [Bounty implementation map](#bounty-implementation-map)
- [Hardening pass (v2.1)](#hardening-pass-v21)
- [What happens on each run](#what-happens-on-each-run)
- [Architecture](#architecture)
- [Setup](#setup)
- [Running](#running)
- [Command reference](#command-reference)
- [Data integrity policy](#data-integrity-policy)
- [README questions](#readme-questions)
- [Failure types](#failure-types)
- [Yellowstone gRPC configuration](#yellowstone-grpc-configuration)
- [Project structure](#project-structure)
- [Architecture document](#architecture-document)
- [Environment variables](#environment-variables)
- [License](#license)

---

## Bounty implementation map

| Area | Requirement | Implementation |
|--------|-------------|----------------|
| Built | Live slot and leader monitoring via Yellowstone gRPC | `src/stream/slot-stream.ts`, `src/geyser/yellowstone-client.ts` |
| Built | Correct slot streaming with reconnect and backpressure | `src/stream/slot-stream.ts` (ping keepalive, fromSlot replay, exponential backoff), `src/geyser/reconnecting-stream.ts` |
| Built | RPC polling fallback when gRPC unavailable | `src/stream/slot-stream.ts` (SlotPoller class) |
| Built | Leader window detection | `src/jito/leader-window-detector.ts` (getNextScheduledLeader), `src/scripts/check-leader.ts` for standalone validation |
| Built | Jito bundle construction with jito-ts SDK | `src/bundle/bundle-builder.ts`, `src/jito/jito-bundle-client.ts` |
| Built | Dynamic tips from live data (not hardcoded) | `src/stream/tip-oracle.ts` (Jito tip floor API + RPC fallback) |
| Built | Stream-first commitment confirmation with fallback | `src/lifecycle/commitment-tracker.ts` |
| Built | Full lifecycle tracking: processed, confirmed, finalized | `src/lifecycle/lifecycle-tracker.ts` |
| Built | Failure detection and classification (15 types) | `src/bundle/failure-classifier.ts` |
| Built | Automatic retry with blockhash refresh | `src/stack.ts` (agent-driven loop) |
| Built | AI agent with real per-run decisions | `src/agent/agent.ts` (decideTip + decideRetry), provider-agnostic via `src/agent/provider-factory.ts` |
| Built | Agent reasoning visible in logs | `logs/lifecycle.json` (agentReasoning + agentDecision fields) |
| Built | Network conditions captured at submission | `src/stream/network-state-observer.ts` |
| Built | 10+ bundle submissions with lifecycle log | `logs/lifecycle.json` (53 real runs at time of writing) |
| Built | 2+ classified failure cases | `src/scripts/fault-inject.ts` (3 fault types demonstrated) |
| Built | Blockhash at confirmed commitment (never finalized) | `src/bundle/bundle-builder.ts` (BlockhashCache) |
| Built | Clean AI / stack separation | `src/agent/` vs `src/stack.ts` |
| Built | Network conditions at submission AND confirmation (delta analysis) | `src/stream/network-state-observer.ts`, `LifecycleEntry.deltaFromSubmissionToConfirmation` |
| Built | Reactive event-triggered submissions (Marinade Finance) | `src/stream/marinade-event-stream.ts` + `Stack.runWithMarinadeTriggering()` |
| Built | Protocol-triggered submissions (USDC / Raydium) | `src/stream/protocol-trigger.ts` |
| Built | Advanced failure classification, 15 types | `src/bundle/failure-classifier.ts` |
| Built | Network load proxies derived from real observations (no placeholder metrics) | `src/stream/network-state-observer.ts` (bundleLandingRate, feeDispersionRatio, validatorLoadProxy) |
| Built | Mainnet observation report generator | `src/scripts/generate-mainnet-report.ts` |
| Built | Self-verification against bounty checklist | `src/scripts/verify-evidence.ts` (`npm run evidence:audit`, 24/24 checks passing) |
| Built | Preflight / environment doctor | `src/scripts/doctor.ts` |
| Built | Visual dashboard over lifecycle data | `src/dashboard/server.ts`, `web/dashboard/index.html` |
| Built | Architecture document | `ARCHITECTURE.md` + Notion public URL |
| Built | Verification report | `evidence/verification-report.md` |
| Built | MIT license | `LICENSE` |

This table maps implementation coverage. The current proof quality is generated separately by `npm run generate:evidence` and checked by `npm run evidence:audit`. At the time of writing, the audit reports **24/24 checks passing** against 53 real lifecycle entries across devnet and mainnet-beta. If the audit reports missing explorer URLs, non-zero slots, dynamic tips, or fault metadata, rerun the stack and fault injection before final submission rather than editing logs by hand.

---

## Hardening pass (v2.1)

The following production hardening changes were applied after the initial build pass. See [`Hardening-changelog.md`](./Hardening-changelog.md) for full details.

### What changed

| Area | Change |
|---|---|
| `RateLimiter` | Added `runWithBackoff()`: exponential backoff (500ms x 2^n + jitter, max 10s) for 429 responses |
| `BlockhashCache` | `isExpiredNow()` now uses real `getBlockHeight()` vs `lastValidBlockHeight`; pre-build expiry check added |
| `BundleBuilder` | Tip guardrail clamping applied before every build; `bundleTxSignature` logged for uniqueness audit |
| `BundleSubmitter` | Leader-window gating: bundles blocked on mainnet unless inside a Jito window or emergency override is set; raw bundle-result events persisted |
| `Config` | Six new env vars: `MIN_TIP_LAMPORTS`, `MAX_TIP_LAMPORTS`, `JITO_LEADER_WINDOW_SLOTS`, `JITO_EMERGENCY_OVERRIDE`, `JITO_EMERGENCY_MIN_TIP_LAMPORTS`, `JITO_RATE_LIMIT_MS` |
| `Stack` | Wired `setLeaderDetector()` so the submitter can gate on leader windows; `rawBundleResults` and `bundleTxSignature` persisted to lifecycle |
| `LifecycleEntry` | Added `rawBundleResults` field for an audit trail of bundle outcomes |
| `AI layer` | Provider-agnostic agent (`src/agent/llm-provider.ts`) supporting Groq as primary and Anthropic as an optional fallback provider |
| Tests | Five test files covering rate limiting, blockhash expiry, protocol triggers, and dashboard summary building |

### New config defaults

```
MIN_TIP_LAMPORTS=1000                   hard floor, no tip below this
MAX_TIP_LAMPORTS=1000000                hard ceiling, no tip above this
JITO_LEADER_WINDOW_SLOTS=4              gate window in slots
JITO_EMERGENCY_OVERRIDE=false           bypass gate only in emergencies
JITO_EMERGENCY_MIN_TIP_LAMPORTS=10000   auto-raised tip when override active
JITO_RATE_LIMIT_MS=1100                 min ms between Jito API calls
STREAM_HIGH_WATERMARK=5000              backpressure threshold
STREAM_RESUME_WATERMARK=2500            resume level after backpressure
```

---

## What happens on each run

1. `SlotStream` (Yellowstone gRPC) or `SlotPoller` (RPC fallback) emits the current slot. The stream tracks `latestProcessedSlot`, `latestConfirmedSlot`, and `latestFinalizedSlot` as separate high-water marks so `CommitmentTracker` can resolve commitment from events, not polling.

2. `LeaderWindowDetector` calls `getNextScheduledLeader()` on the Jito block engine to find out how many slots remain until the next Jito-connected leader. `check-leader.ts` exists as a standalone script to validate this independently of a full run.

3. `TipOracle` fetches the Jito tip floor API (`bundles.jito.wtf/api/v1/bundles/tip_floor`) for live auction percentiles. Falls back to `getRecentPrioritizationFees()` on devnet or when the tip floor API is unreachable.

4. `NetworkStateObserver` captures block production rate, slot skip rate, p50/p90 confirmation latency from rolling history, and current RPC fee percentiles.

5. A full `NetworkSnapshot` is assembled: slot, average slot time, failure rate, leader window, confirmation latency, and raw network conditions.

6. `Agent.decideTip()` receives the complete snapshot and returns a tip with multiple sentences of reasoning that names the specific percentile chosen, the lamport value, the congestion multiplier, the leader urgency multiplier, and the estimated landing probability. The agent runs through `provider-factory.ts`, defaulting to Groq with Anthropic available as a fallback provider.

7. `BundleBuilder` constructs the bundle with a `confirmed` blockhash and the agent-decided tip, after clamping through `MIN_TIP_LAMPORTS` / `MAX_TIP_LAMPORTS` guardrails.

8. A real transaction is submitted via `sendAndConfirmTransaction()` so every run has a verifiable on-chain signature, independent of whether the Jito bundle itself lands.

9. `BundleSubmitter` submits the bundle to the Jito block engine. On mainnet, submission is gated on an active Jito leader window unless `JITO_EMERGENCY_OVERRIDE` is set, in which case the tip is automatically raised to `JITO_EMERGENCY_MIN_TIP_LAMPORTS`.

10. `LifecycleTracker` advances the entry through processed, confirmed, and finalized stages, using `commitmentSource` to record whether each stage was resolved from the Yellowstone stream or RPC fallback.

11. If a failure occurs, `FailureClassifier` assigns one of 15 typed failure reasons. `Agent.decideRetry()` reasons about the specific failure and decides whether to retry, with what tip, and whether to refresh the blockhash. No retry path is hardcoded; it is always agent-decided.

12. Every entry, successful or not, is appended to `logs/lifecycle.json` with the full agent reasoning, network snapshot, stage timestamps, and (when applicable) an explorer URL.

### Mainnet vs devnet Jito behavior

Jito does not run a block engine on Solana devnet. Devnet runs in this stack still produce real, confirmed, verifiable transactions through `sendAndConfirmTransaction()`, and the lifecycle log still records full commitment progression through Yellowstone or RPC polling. What devnet runs cannot demonstrate is actual bundle landing through the Jito auction, since there is no devnet auction to land in. Mainnet runs are required to demonstrate real Jito bundle acceptance and tip competition.

---

## Architecture

```
+----------------------------------------------------------------+
|  LAYER 1  Network Observer                                     |
|                                                                |
|  SlotStream (Yellowstone gRPC)         SlotPoller (RPC)        |
|    https:// endpoint, ping keepalive     getSlot polling       |
|    fromSlot replay on reconnect          fallback when stream  |
|    dead slot detection                   is unavailable        |
|                                                                |
|  TipOracle                             NetworkStateObserver    |
|    Jito tip floor API (primary)          block production rate |
|    getRecentPrioritizationFees (fallback)slot skip rate        |
|    p25/p50/p75/p95/p99, 10s cache        p50/p90 confirm time  |
|                                                                |
|  LeaderWindowDetector                                          |
|    getNextScheduledLeader() via Jito block engine              |
|    slotsUntilJitoLeader, isJitoLeaderWindow                    |
+----------------------------------------------------------------+
                              |
                              v   NetworkSnapshot
+----------------------------------------------------------------+
|  LAYER 2  AI Agent (provider-agnostic, Groq primary)           |
|                                                                |
|  decideTip()      tipLamports, reasoning, congestion and       |
|                    leader urgency multipliers, landing prob    |
|  decideRetry()     shouldRetry, action, new tip,               |
|                    refreshBlockhash, wait time                 |
|                                                                |
|  Hard guardrails enforced after every model call:              |
|  MIN_TIP_LAMPORTS / MAX_TIP_LAMPORTS clamp, compute-exceeded   |
|  and simulation-failed never retry regardless of model output  |
+----------------------------------------------------------------+
                              |
                              v   TipDecision
+----------------------------------------------------------------+
|  LAYER 3  Bundle Builder                                       |
|                                                                |
|  BlockhashCache       always confirmed commitment,             |
|                       proactive refresh, real expiry check     |
|  BundleBuilder        jito-ts Bundle, tip instruction to a     |
|                       randomly selected official tip account   |
+----------------------------------------------------------------+
                              |
                              v   BuiltBundle
+----------------------------------------------------------------+
|  LAYER 4  Submission and Tracking                              |
|                                                                |
|  Real tx via sendAndConfirmTransaction()                       |
|  BundleSubmitter      leader-window gated on mainnet,          |
|                       raw bundle results persisted             |
|  FailureClassifier    15 typed failure reasons                 |
|  CommitmentTracker    stream-event resolution                  |
|  LifecycleTracker     RPC fallback per stage when stream times |
|                       out                                      |
+----------------------------------------------------------------+
                              |
                              v   LifecycleEntry
+----------------------------------------------------------------+
|  LAYER 5  Evidence and Visualization                           |
|                                                                |
|  logs/lifecycle.json              append-only run records      |
|  evidence/run-summary.json        aggregated statistics        |
|  evidence/verification-report.md  bounty compliance audit      |
|  evidence/mainnet-observations.md real mainnet percentile data |
|  web/dashboard/                   visual lifecycle dashboard   |
+----------------------------------------------------------------+
```

---

## Setup

### Requirements

- Node.js 20.11 or newer
- A Groq API key, free at console.groq.com, no card required
- A Solana wallet private key in base58 format
- A mainnet-capable RPC endpoint. This stack was run against a **Helius RPC endpoint** rather than the public Solana RPC, since the public endpoint rate-limits aggressively and produces frequent 429s during multi-bundle runs. A free Helius RPC URL works fine for evidence collection.

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

Everything else defaults to devnet. On first run the wallet is auto-airdropped on devnet if balance is below 0.1 SOL.

For mainnet, recommended for full evidence:

```
SOLANA_NETWORK=mainnet-beta
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_helius_key
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=your_helius_key
JITO_RPC_URL=https://mainnet.block-engine.jito.wtf/api/v1
```

The public `api.mainnet-beta.solana.com` endpoint works too, but expect more `429 Too Many Requests` responses under load. Helius (or any dedicated RPC provider) keeps multi-bundle runs clean.

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

### Preflight check

```bash
npm run challenge:doctor
```

Verifies env vars, RPC reachability, Yellowstone native binding availability, Jito block engine reachability, tip floor API reachability, AI provider configuration, and wallet balance before a real run.

### Full evidence collection

```bash
npm run build
npm run challenge:doctor
npm run challenge:reset-evidence
npm run challenge:run -- --count 10 --failures 3
npm run generate:evidence
npm run verify:evidence
```

This is the exact sequence used to produce the lifecycle log and verification report referenced throughout this README.

### Full stack, default count

```bash
npm start
```

### Fault injection demo, 3 fault types

```bash
npm run run:inject
```

Runs three fault scenarios in sequence:

1. `EXPIRED_BLOCKHASH`, a stale blockhash is injected, the classifier detects it, the agent refreshes the blockhash and retries
2. `FEE_TOO_LOW`, an intentionally underpriced tip is submitted, the classifier detects it, the agent increases to a competitive percentile and retries
3. `COMPUTE_EXCEEDED`, the compute budget is set too low, the classifier detects it, the agent correctly aborts since a higher tip cannot fix a compute limit

### Marinade-triggered submissions, mainnet only

```bash
npm run run:marinade
```

Listens for real Marinade Finance staking events (`MarBmsSgKXdrQP1zU937A8bLnSZ3xq4b5VW6dcjpyQ`) on mainnet. When a staking event of 1 SOL or more is detected, the stack submits a bundle in response and tags the lifecycle entry with the triggering event's signature, amount, and slot. The 1 SOL threshold is intentionally low to make reactive triggering observable during a normal testing window rather than waiting for institutional-sized deposits.

### Generate evidence report

```bash
npm run generate:evidence
```

Produces `evidence/run-summary.json` and `evidence/verification-report.md` from `logs/lifecycle.json`.

### Generate mainnet observation report

```bash
npm run generate:mainnet-report
```

Produces `evidence/mainnet-observations.md` containing real p50/p90/p99 processed-to-confirmed latencies, block production rate percentiles, a per-run table, and only values this stack actually observed on mainnet-beta.

---

## Command reference

### Setup

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm ci` | Clean install from lockfile, for CI or reproducible builds |
| `cp .env.example .env` | Copy the env template before filling in keys |

### Build

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |

### Run the stack

| Command | What it does |
|---|---|
| `npm start` | Run the full stack, default 10 bundle submissions |
| `npm run run:stack` | Same as `npm start` |
| `npm run challenge:run` | Same entry point, used for evidence and bounty runs, supports CLI flags |

CLI flags on `challenge:run`:

```bash
npm run challenge:run -- --count 10 --failures 3 --network mainnet-beta
```

| Flag | Effect |
|---|---|
| `--count N` | Number of bundle submissions, overrides `BUNDLE_COUNT` |
| `--failures N` | Runs fault-injection batches after the main run |
| `--network devnet\|mainnet-beta` | Sets `SOLANA_NETWORK` for that run only |

### Preflight and diagnostics

| Command | What it does |
|---|---|
| `npm run challenge:doctor` | Preflight check across env, RPC, wallet, Jito, tip floor API, and AI provider |
| `npm run check:leader` | Polls `getNextScheduledLeader()` 5 times, exits with a warning if leader info is consistently null |

### Fault injection and reactive modes

| Command | What it does |
|---|---|
| `npm run run:inject` | Runs all 3 fault demos in sequence |
| `npm run run:marinade` | Mainnet only, listens for Marinade staking events and submits reactively |

### Evidence pipeline

| Command | What it does |
|---|---|
| `npm run challenge:reset-evidence` | Clears `logs/lifecycle.json` to a fresh empty array |
| `npm run generate:evidence` | Builds `evidence/run-summary.json` and `evidence/verification-report.md` |
| `npm run verify:evidence` | Runs the strict compliance audit against the lifecycle log |
| `npm run evidence:audit` | Alias for `verify:evidence` |
| `npm run bounty:audit` | `generate:evidence` then `evidence:audit` in one shot |
| `npm run generate:mainnet-report` | Writes `evidence/mainnet-observations.md` from mainnet entries |

### Dashboard

| Command | What it does |
|---|---|
| `npm run dashboard:start` | Serves the lifecycle dashboard at `http://localhost:4317`, needs `npm run build` first |
| `npm run dashboard:screenshot` | Starts the dashboard if needed and captures PNGs into `docs/screenshots/` |

### Tests

| Command | What it does |
|---|---|
| `npm test` | Runs all 5 test files |
| `npm run test:unit` | RateLimiter, BlockhashCache, Yellowstone helper unit tests |
| `npm run test:rate-limiter` | RateLimiter serialization and 429 backoff behavior |
| `npm run test:blockhash-cache` | Blockhash expiry detection |
| `npm run test:protocol-trigger` | SPL and Raydium protocol trigger detection |
| `npm run test:dashboard` | Dashboard summary builder |

---

## Data integrity policy

Every number in `logs/lifecycle.json`, `evidence/run-summary.json`, `evidence/verification-report.md`, and `evidence/mainnet-observations.md` is either read directly from a Solana RPC or Jito API call made by this stack, or derived by simple arithmetic from values in that first category, with the derivation documented in code comments.

Three fields in `NetworkConditions` (`bundleLandingRate`, `feeDispersionRatio`, `validatorLoadProxy`) are explicitly labeled as derived proxies rather than direct measurements. `bundleLandingRate` is this stack's own rolling success rate over its last runs, not a network-wide statistic. `feeDispersionRatio` is the p95/p25 ratio of real prioritization fees observed via `getRecentPrioritizationFees()`. `validatorLoadProxy` is derived from observed slot timing versus the 400ms target. None of these are hardcoded estimates or figures sourced from third-party dashboards.

`evidence/mainnet-observations.md` is only populated after a real mainnet run. Before that it contains an explanation of how to generate it rather than placeholder numbers.

---

## README questions

### Q1: What does the delta between processed_at and confirmed_at tell you about network health?

The processed to confirmed delta measures how long it takes the validator set to reach supermajority consensus, 66 percent or more of stake weight, on the block containing the transaction. A short delta means the gossip layer is healthy and votes are propagating quickly. A delta that stretches out signals validators under load, gossip packet loss, or clock drift affecting vote timing.

This is exactly what showed up across this stack's own runs. Across 22 mainnet-beta samples, the processed to confirmed delta averaged 98ms, with a p50 of 98ms and a p90 of 102ms, a tight, healthy distribution with almost no tail. Across 25 devnet samples in the same session, the delta averaged 2,352ms, with a p50 of 1,500ms and a p90 of 7,518ms, a much wider and slower spread. That difference is not devnet being "worse" in absolute terms; it reflects devnet's smaller, less consistently available validator set and the RPC polling fallback that engaged when the Yellowstone stream dropped mid-run. The mainnet numbers came from a stream-resolved path with `commitmentSource: yellowstone_slot_stream`, while several devnet stages resolved through `commitmentSource: rpc_signature_status` instead, which is inherently coarser since it is bound to RPC poll intervals rather than push-based slot events.

This stack feeds a rolling p50 and p90 of recent processed-to-confirmed deltas into the agent through `NetworkSnapshot`. When the p90 rises well above the p50, it signals the tail of the distribution is getting worse, meaning some blocks are taking far longer to confirm than the median. The agent uses this directly in its congestion multiplier, and the lifecycle log shows it acting on this: tip selections moved from p50 baseline (2,708 lamports during a clean window) up to p95 (119,750 lamports) during a run logged with "highly congested network conditions" and a 100% recent failure rate in the agent's own reasoning text.

### Q2: Why should you never use finalized commitment when fetching a blockhash?

A blockhash fetched at finalized commitment is already roughly 31 to 32 slots old by the time you receive it, because finality requires a full Tower BFT vote lockout cycle. At 400ms per slot that is around 13 seconds of staleness before the transaction has even been built.

A blockhash is valid for 150 slots from the block it was produced in. Fetching at finalized burns over 20 percent of that window before signing or submission even starts. Add network latency, AI reasoning time, and Jito submission round trips on top, and a finalized-commitment blockhash can be within a handful of slots of expiry before it ever reaches the block engine. This is the direct mechanical cause of `EXPIRED_BLOCKHASH` failures, which this stack actually reproduced during fault injection: one logged entry shows the agent diagnosing it correctly, "The transaction failed due to an EXPIRED_BLOCKHASH, which occurs when the blockhash exceeds its 150-slot validity window. To fix this, we need to refresh the blockhash with a new one at confirmed commitment."

`BlockhashCache` in this stack always calls `getLatestBlockhash("confirmed")`. A confirmed block already carries supermajority vote, so rollback risk is negligible, and the blockhash is only 2 to 4 slots old when received, not 31 to 32. The cache also refreshes proactively on a slot-count interval and performs a real `isExpiredNow()` check against `getBlockHeight()` versus `lastValidBlockHeight` before every build, rather than trusting a cached value blindly.

### Q3: What happens to your bundle if the Jito leader skips their slot?

Jito bundles are routed to a specific leader through the block engine. If that leader skips their slot, the block engine does not forward the bundle to the next leader, and there is no mempool for it to sit in. The bundle is simply dropped.

This is directly visible in this stack's own mainnet logs. Two entries are recorded with `failure: BUNDLE_DROPPED` and the agent reasoning states plainly, "Submission skipped: Yellowstone stream unavailable and no Jito leader window confirmed." That is the leader-window gate working as designed: rather than blindly submitting into a window with no confirmed Jito leader and burning a tip for nothing, the stack held the submission and logged the reason. On a separate mainnet run, the same dropped-bundle pattern showed up after an accepted bundle came back with `status: Invalid` from `getInFlightBundleStatuses`, meaning the block engine accepted it into its queue but it never actually landed in a block, consistent with the assigned leader skipping their slot.

`LeaderWindowDetector` exists specifically to reduce this risk by calling `getNextScheduledLeader()` before every submission. When `slotsUntilJitoLeader` is unavailable (the JSON-RPC endpoint does not expose real leader data, only gRPC does), the stack logs "Leader schedule unavailable (endpoint does not support getNextScheduledLeader) -- allowing submission" rather than blocking indefinitely, while still gating hard on mainnet when `SUBMISSION_REQUIRE_LEADER_WHEN_STREAM_DOWN` is set and the stream itself is down. The `BUNDLE_DROPPED` classification carries a recommended recovery path of `retry_refresh_blockhash` with a wait of roughly 4 slot-times, enough for the next leader window to become active before resubmitting.

---

## Failure types

| Code | Cause | Agent recovery |
|---|---|---|
| `EXPIRED_BLOCKHASH` | Blockhash exceeded its 150-slot window | Refresh blockhash, retry |
| `BLOCKHASH_NOT_FOUND` | Blockhash never existed in the ledger | Refresh blockhash from primary RPC, retry |
| `FEE_TOO_LOW` | Tip lost the Jito block auction | Increase to a competitive percentile, retry |
| `COMPUTE_EXCEEDED` | Transaction hit its compute budget limit | Abort, a higher tip cannot fix this |
| `BUNDLE_DROPPED` | Jito leader skipped their slot, or no leader window was confirmed | Wait roughly 4 slots, refresh, retry |
| `LEADER_SKIPPED` | Same root cause as BUNDLE_DROPPED | Wait roughly 4 slots, refresh, retry |
| `SIMULATION_FAILED` | Transaction failed preflight simulation | Abort, transaction logic needs fixing |
| `INSTRUCTION_ERROR` | On-chain instruction returned an error code | Abort, program logic issue |
| `ACCOUNT_IN_USE` | A concurrent transaction holds a write lock | Wait briefly, retry with the same tip |
| `ACCOUNT_NOT_FOUND` | A required account does not exist on-chain | Abort, requires investigation |
| `INSUFFICIENT_FUNDS` | Payer wallet is underfunded | Abort, requires manual top-up |
| `RATE_LIMITED` | Hit Jito's rate limit | Wait with jitter, retry |
| `STREAM_DIVERGENCE` | Stream reports confirmed but RPC disagrees | Wait for RPC to catch up |
| `TIMEOUT` | No confirmation within the tracking window | Retry with a higher tip |
| `UNKNOWN` | Unclassified error | Hold briefly, retry once |

All 15 types are defined in `src/bundle/failure-classifier.ts`. The lifecycle log from this stack's own runs includes real, observed instances of `EXPIRED_BLOCKHASH`, `FEE_TOO_LOW`, `COMPUTE_EXCEEDED`, `BUNDLE_DROPPED`, and `TIMEOUT`.

---

## Yellowstone gRPC configuration

The stack implements Yellowstone per the Triton Dragon's Mouth specification:

- Endpoint must carry the `https://` prefix, auto-prepended if missing
- A ping frame is sent every 30 seconds to prevent cloud provider stream drops
- `fromSlot` is set on reconnect to replay missed slots
- Slot status integers are decoded correctly, 0 for processed, 1 for confirmed, 2 for finalized
- Dead slots are detected and logged separately
- Three independent high-water marks are maintained, one per commitment level
- The stack falls back to `SlotPoller` after 3 consecutive connection failures, and resumes normally from there

```
YELLOWSTONE_ENDPOINT=fra.grpc.solinfra.dev:443
YELLOWSTONE_TOKEN=your_token_here
```

If the native binding for `@triton-one/yellowstone-grpc` is unavailable on your platform (commonly an issue on Windows), `doctor` reports this clearly and the stack runs fine on `SlotPoller` instead. Linux and Codespaces environments work without issue.

---

## Project structure

```
src/
  index.ts                          entry point, graceful shutdown
  config.ts                         environment variables with defaults
  types.ts                          shared TypeScript types across all layers
  stack.ts                          main orchestrator

  agent/
    agent.ts                        decideTip and decideRetry
    llm-provider.ts                 provider-agnostic LLM interface
    provider-factory.ts             selects Groq or Anthropic at runtime
    providers/
      groq-provider.ts              Groq implementation
      anthropic-provider.ts         Anthropic implementation (optional fallback)

  bundle/
    bundle-builder.ts               Jito bundle construction, BlockhashCache
    bundle-submitter.ts             bundle submission, leader-window gating
    failure-classifier.ts           AdvancedFailureClassifier, 15 failure types

  jito/
    leader-window-detector.ts       getNextScheduledLeader() from Jito
    create-jito-client.ts           client construction and selection
    jito-bundle-client.ts           bundle submission client
    jito-grpc-client.ts             gRPC searcher transport (JITO_USE_GRPC)
    jito-jsonrpc-client.ts          JSON-RPC searcher transport

  geyser/
    yellowstone-client.ts           low-level Yellowstone client wrapper
    reconnecting-stream.ts          reconnect and backpressure handling

  lifecycle/
    commitment-tracker.ts           stream-event-based commitment resolution
    lifecycle-tracker.ts            full lifecycle tracking with RPC fallback

  stream/
    slot-stream.ts                  SlotStream (Yellowstone) + SlotPoller (RPC)
    tip-oracle.ts                   Jito tip floor API + getRecentPrioritizationFees
    network-state-observer.ts       block rate, skip rate, confirmation latencies
    marinade-event-stream.ts        Marinade Finance staking event listener
    protocol-trigger.ts             USDC / Raydium reactive trigger detection

  dashboard/
    server.ts                       dashboard HTTP server
    summary.ts                      lifecycle summary builder for the dashboard

  utils/
    logger.ts                       structured logging, lifecycle.json writer
    wallet.ts                       keypair loader, devnet airdrop
    helpers.ts                      timing, formatting, ID generation
    rate-limiter.ts                 exponential backoff for 429 responses

  scripts/
    fault-inject.ts                 3 fault type injection demo
    run-marinade.ts                 Marinade-triggered submission runner
    doctor.ts                       preflight environment checker
    check-leader.ts                 standalone leader-detection validator
    generate-evidence.ts            produces evidence/run-summary.json + verification-report.md
    verify-evidence.ts              strict compliance audit against the bounty checklist
    generate-mainnet-report.ts      produces evidence/mainnet-observations.md from mainnet runs

test/
  unit.test.ts                      core unit tests
  rate-limiter.test.ts              RateLimiter and 429 backoff
  blockhash-cache.test.ts           blockhash expiry detection
  protocol-trigger.test.ts          SPL / Raydium trigger detection
  dashboard.test.ts                 dashboard summary builder

web/
  dashboard/index.html              visual lifecycle dashboard frontend

docs/
  screenshots/                      dashboard screenshots for the submission packet

logs/
  lifecycle.json                    append-only run records
  session-*.log                     terminal session logs

evidence/
  run-summary.json                  aggregated run statistics
  verification-report.md            bounty requirement compliance audit (24/24 passing)
  mainnet-observations.md           real mainnet percentile data
  blockhash-recovery.md             fault-injection recovery evidence
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GROQ_API_KEY` | Yes | | From console.groq.com |
| `WALLET_PRIVATE_KEY` | Yes | | Base58 encoded private key |
| `AI_PROVIDER` | No | groq | `groq` or `anthropic` |
| `ANTHROPIC_API_KEY` | No | | Only needed if `AI_PROVIDER=anthropic` |
| `SOLANA_NETWORK` | No | devnet | devnet or mainnet-beta |
| `SOLANA_RPC_URL` | No | api.devnet.solana.com | RPC endpoint, Helius recommended for mainnet |
| `SOLANA_WS_URL` | No | wss devnet | WebSocket endpoint |
| `JITO_RPC_URL` | No | mainnet block engine | Jito JSON-RPC URL |
| `YELLOWSTONE_ENDPOINT` | No | | gRPC endpoint, `https://` auto-added if missing |
| `YELLOWSTONE_TOKEN` | No | | Auth token for Yellowstone |
| `GROQ_MODEL` | No | llama-3.3-70b-versatile | Groq model ID |
| `BUNDLE_COUNT` | No | 10 | Bundles per batch run |
| `MAX_RETRIES` | No | 3 | Max retries per bundle |
| `MIN_TIP_LAMPORTS` | No | 1000 | Hard floor on agent tip decisions |
| `MAX_TIP_LAMPORTS` | No | 1000000 | Hard ceiling on agent tip decisions |
| `JITO_LEADER_WINDOW_SLOTS` | No | 4 | Slots ahead of next Jito leader considered an active window |
| `JITO_EMERGENCY_OVERRIDE` | No | false | Bypass leader-window gating, auto-raises tip |
| `JITO_RATE_LIMIT_MS` | No | 1100 | Minimum ms between Jito API calls |
| `JITO_USE_GRPC` | No | false | Use gRPC searcher transport for real leader data |
| `TRIGGER_PROTOCOL` | No | usdc | Reactive trigger type: usdc, raydium, or none |
| `LOG_DIR` | No | ./logs | Directory for lifecycle logs |
| `DASHBOARD_PORT` | No | 4317 | Port for the lifecycle dashboard |

---

## License

MIT
