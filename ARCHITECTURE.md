# Smart Transaction Stack: Architecture Document

**Superteam Nigeria Advanced Infrastructure Challenge**
Built by: Focus
Network: Solana Devnet
Stack: TypeScript / Node.js 22

---

## Overview

This system is a smart Solana transaction stack that observes the network in real time, constructs Jito bundles with dynamically computed tips, tracks every transaction across all commitment levels, classifies failures by type, and uses an AI agent to make the tip and retry decisions on every single run.

The core design principle is that no operational decision is hardcoded. The agent reads live network data before each submission and decides the tip. When something fails, the agent reads the failure context and decides whether to retry, how much to tip on the retry, and whether the blockhash needs refreshing. That reasoning gets written to the lifecycle log alongside the slot numbers and timestamps so every decision is auditable.

The stack was run on Solana devnet and produced 10 confirmed transactions plus 2 fault injection failure cases. All signatures and slot numbers are verifiable on Solana Explorer (devnet).

---

## System Architecture

```
+--------------------------------------------------+
|  LAYER 1 -- NETWORK OBSERVER                     |
|                                                  |
|  SlotStream (Yellowstone gRPC)                   |
|  SlotPoller (RPC fallback, getSlot every 400ms)  |
|  TipOracle  (getRecentPrioritizationFees)        |
|                                                  |
|  Output: current slot, slot timing history,      |
|          fee percentiles (p25/p50/p75/p95)       |
+-------------------------+------------------------+
                          |
                          v
+--------------------------------------------------+
|  LAYER 2 -- AI AGENT                             |
|                                                  |
|  Model: Groq llama-3.3-70b-versatile             |
|  Temperature: 0.2                                |
|                                                  |
|  decideTip()   --> tipLamports + reasoning       |
|  decideRetry() --> shouldRetry + newTip + waitMs |
|                                                  |
|  Input: structured JSON context                  |
|  Output: typed decision with reasoning string    |
+-------------------------+------------------------+
                          |
                          v
+--------------------------------------------------+
|  LAYER 3 -- BUNDLE BUILDER                       |
|                                                  |
|  BlockhashCache  -- confirmed commitment only    |
|                     auto-refreshes every 100     |
|                     slots, force-refresh on      |
|                     EXPIRED_BLOCKHASH failure    |
|                                                  |
|  BundleBuilder   -- zero-lamport self-transfer   |
|                     + tip instruction            |
|                     + jito-ts Bundle wrapper     |
+-------------------------+------------------------+
                          |
                          v
+--------------------------------------------------+
|  LAYER 4 -- SUBMISSION + TRACKING               |
|                                                  |
|  BundleSubmitter    -- JitoJsonRpcClient         |
|                        .sendBundle()             |
|                                                  |
|  DevnetTx           -- sendAndConfirmTransaction |
|                        runs alongside every      |
|                        bundle attempt            |
|                                                  |
|  LifecycleTracker   -- getSignatureStatus()      |
|                        polls processed,          |
|                        confirmed, finalized      |
|                                                  |
|  FailureClassifier  -- 6 failure types           |
+-------------------------+------------------------+
                          |
                          v
+--------------------------------------------------+
|  LAYER 5 -- LIFECYCLE LOG                        |
|                                                  |
|  logs/lifecycle.json  -- one entry per run       |
|  logs/session-*.log   -- terminal session log    |
|                                                  |
|  Every entry: runId, signature, slot numbers,    |
|  commitment timestamps, tip paid, failure type,  |
|  agent reasoning, retry count, blockhash used    |
+--------------------------------------------------+
```

---

## Key Components

### SlotStream and SlotPoller

The stack needs a continuous view of the current slot to time submissions correctly and give the agent accurate network context.

SlotStream connects to a Yellowstone gRPC endpoint using `@triton-one/yellowstone-grpc`. It subscribes to slot events at `PROCESSED` commitment and maintains a rolling history of the last 20 slot timestamps. From this history the stack can compute average slot time, which tells the agent whether the network is running fast, slow, or normal.

When no Yellowstone endpoint is configured, SlotPoller takes over. It calls `getSlot("processed")` on a 400ms interval and emits the same slot events. The lifecycle logs produced are identical either way.

If Yellowstone connection fails, the stack logs a warning after 3 attempts and falls back to polling automatically. The process never crashes on a Yellowstone failure.

### TipOracle

Calls `getRecentPrioritizationFees()` on the configured RPC endpoint. This returns the prioritization fees paid in recent blocks as an array of `{ slot, prioritizationFee }` objects. The fee values are in micro-lamports per compute unit. TipOracle converts them to lamports, filters out zero-fee slots (which are common on quiet devnet periods and would skew percentiles), and computes p25/p50/p75/p95.

The result is cached for 12 seconds so the agent always has fresh data without hammering the RPC on every run.

If the network is quiet and all fees are zero, TipOracle falls back to a conservative floor (1000/2000/5000/20000 lamports for p25/p50/p75/p95) and logs a warning. This happened on most of the devnet runs in this submission because devnet has very low transaction volume compared to mainnet.

### BlockhashCache

Fetches blockhash at `confirmed` commitment using `getLatestBlockhash("confirmed")`. Never at `finalized`. The difference matters because a finalized blockhash is already 31-32 slots old when you receive it, consuming roughly 20% of the 150-slot validity window before the transaction is even built.

The cache proactively refreshes every 100 slots so you are never submitting close to expiry. On `EXPIRED_BLOCKHASH` failure the stack calls `invalidate()` which forces a fresh fetch on the next build, regardless of when the last fetch was.

### BundleBuilder

Builds each bundle as a zero-lamport self-transfer transaction (the primary instruction, which is cheap and verifiable) plus a tip instruction that sends the agent-decided lamport amount to a randomly selected Jito tip account. The transaction is signed with the payer keypair and wrapped in a `jito-ts` Bundle with a limit of 5 transactions.

### BundleSubmitter

Calls `JitoJsonRpcClient.sendBundle()` with the serialized transaction. On devnet this always fails because Jito does not run a block engine on devnet. The error is classified, logged, and returned to the stack so the agent can decide what to do next. On mainnet with the correct block engine URL, this is where the bundle actually lands.

### DevnetTx

Because Jito does not work on devnet, the stack sends a real `sendAndConfirmTransaction()` call alongside every bundle attempt. This produces a real confirmed signature with real slot numbers on devnet regardless of the Jito outcome. This is what generates the verifiable on-chain data in the lifecycle log.

### LifecycleTracker

Polls `getSignatureStatus()` with `searchTransactionHistory: true` across three commitment levels. At each stage it records the slot number, timestamp, and latency from the previous stage. The timeouts are 15 seconds for processed, 30 seconds for confirmed, and 60 seconds for finalized. If a stage times out, the tracker records a failed stage and returns the last successfully reached stage as the final outcome.

### FailureClassifier

Every error string from the RPC or Jito gets classified into one of six types:

```
EXPIRED_BLOCKHASH   blockhash too old at submission
FEE_TOO_LOW         tip not competitive
COMPUTE_EXCEEDED    transaction hit compute budget
BUNDLE_DROPPED      Jito leader skipped slot
SIMULATION_FAILED   transaction logic error
TIMEOUT             no confirmation within window
UNKNOWN             unrecognised error
```

The failure type is what gets sent to the agent's `decideRetry()` method. The agent has specific rules for each type, for example it never retries `SIMULATION_FAILED` or `COMPUTE_EXCEEDED` because a higher tip cannot fix a logic error or a compute budget issue.

---

## Data Flow Between Services

### Happy path (bundle lands)

```
SlotPoller emits slot 467217664
     |
     v
TipOracle returns { p50: 2000, p75: 5000, ... }
     |
     v
Agent.decideTip() returns { tipLamports: 2000, reasoning: "..." }
     |
     v
BlockhashCache.get() returns blockhash Fo5nJct...
     |
     v
BundleBuilder builds tx + tip ix, wraps in Bundle
     |
     v
DevnetTx sends real transaction, gets signature rRnhpT7J...
     |
     v
BundleSubmitter.submit() attempts Jito (fails on devnet, logged)
     |
     v
LifecycleTracker.track("rRnhpT7J...")
  processed  at slot 467217664, latency 232ms
  confirmed  at slot 467217664, latency 21ms
  finalized  at slot 467217664, latency 12163ms
     |
     v
lifecycle.json entry written with all stages
```

### Failure path (EXPIRED_BLOCKHASH with agent retry)

```
BundleSubmitter sends stale blockhash tx
     |
     v
Jito rejects with EXPIRED_BLOCKHASH (67ms after submission)
     |
     v
Agent.decideRetry() receives:
  { failure: "EXPIRED_BLOCKHASH", retryCount: 0, blockhashExpired: true }
     |
     v
Agent returns:
  { shouldRetry: true, refreshBlockhash: true, waitMs: 1507, reasoning: "..." }
     |
     v
BlockhashCache.invalidate() called
     |
     v
Stack waits 1507ms then re-enters the build loop
     |
     v
Fresh blockhash fetched at confirmed commitment
     |
     v
New bundle built and submitted
```

This is the exact flow captured in lifecycle entry `CDFDF49C871E` in `logs/lifecycle.json`.

---

## Infrastructure Decisions

### Why confirmed commitment for blockhash fetch

A blockhash is valid for 150 slots. Fetching at `finalized` burns 31-32 of those slots before you have even started building the transaction. At 400ms per slot that is 13 seconds of validity already consumed. In a busy network where leader windows are competitive and retry loops can add several seconds, starting with a 13 second deficit is how you get EXPIRED_BLOCKHASH failures.

Fetching at `confirmed` gives you a blockhash that is 2-4 slots old. The block has supermajority vote so it is not going to be rolled back. You have the full 146+ slots to work with.

### Why RPC polling as Yellowstone fallback

Yellowstone gRPC gives you slot events pushed from the server as they happen, which is faster and more efficient than polling. But it requires external credentials and a reachable endpoint. Rather than making Yellowstone a hard dependency, the stack falls back to `getSlot()` polling on a 400ms interval, which matches Solana's target slot time. The lifecycle logs produced are identical.

### Why send a real devnet tx alongside every bundle

Jito does not operate a block engine on devnet. Every bundle submission on devnet will be rejected. If the stack only submitted bundles, the lifecycle log would have no on-chain proof of any kind.

By sending a real `sendAndConfirmTransaction()` call on every run, the stack produces a real confirmed signature with real slot numbers that judges can verify on Solana Explorer. The bundle submission is still attempted and its outcome is logged honestly. These are two separate operations and the log records both.

### Why dynamic tips from getRecentPrioritizationFees

Hardcoded tip values are a common shortcut that the bounty specifically disqualifies. The correct approach is to read what other transactions have actually been paying in recent blocks and price relative to that. `getRecentPrioritizationFees()` is a standard RPC method available on both devnet and mainnet. It returns real fee data from the last 150 slots.

On quiet devnet the values are often zero, so the stack falls back to a conservative floor and logs clearly that it is doing so. On mainnet this method returns real competitive fee data.

### Why Groq at temperature 0.2

The agent is making operational decisions where consistency matters more than creativity. A tip decision that varies wildly between identical inputs would make the system unpredictable. Temperature 0.2 keeps the model focused on the structured decision task while still allowing it to reason about the specific context it receives.

### Why max retries is capped at 3

The agent can return `shouldRetry: true` but the stack enforces a hard cap of 3 retries per bundle regardless. This prevents a bad network condition from causing the stack to loop indefinitely. After 3 retries the failure is logged and the stack moves to the next run.

---

## Failure Handling Strategy

Every failure in the stack follows the same path:

1. The failure is caught at the submitter or tracker level
2. It is classified into one of the 6 failure types
3. The failure type, retry count, current slot, and tip stats are packaged into a `RetryDecisionInput` object
4. This is sent to `agent.decideRetry()`
5. The agent returns a typed decision
6. The stack either retries according to the agent's decision or logs the final failure and moves on

The agent has fixed rules for two failure types that should never retry:

`SIMULATION_FAILED` means the transaction failed pre-flight simulation. The logic is wrong. A higher tip does not fix a broken instruction. Retrying would just fail the same way.

`COMPUTE_EXCEEDED` means the transaction used more compute units than the budget allows. Again, the tip is irrelevant here. The transaction itself needs to be changed.

For everything else the agent reasons based on the current network state. `EXPIRED_BLOCKHASH` always gets `refreshBlockhash: true`. `FEE_TOO_LOW` gets the tip bumped to at least p75. `BUNDLE_DROPPED` (Jito leader skip) gets a wait time that accounts for the next leader becoming active.

Safety bounds are applied after the agent responds. The tip can never go below 1000 lamports or above 500000 lamports regardless of what the model returns. The wait time is capped between 800ms and 10 seconds. This means a model output error cannot send a zero-lamport tip or cause the stack to wait forever.

---

## AI Agent Responsibilities

The agent owns two decisions:

**Tip decision (before every submission)**

Input it receives:
- p25/p50/p75/p95 lamports from recent blocks
- Current slot number
- Average slot time from last 20 slots (network speed signal)
- Previous tip amount if this is a retry
- Previous submission outcome

What it decides:
- Exact tip amount in lamports
- One sentence of reasoning
- Confidence score between 0 and 1

The decision rules it follows: use p50 on a normal network, use p75 when slot times are elevated (congestion signal), use p25 when the network is fast and the previous submission confirmed cleanly. Never go below 1000 lamports.

**Retry decision (after every failure)**

Input it receives:
- Failure type
- How many retries have happened so far
- Whether the blockhash is expired
- Current tip percentiles
- Previous tip amount

What it decides:
- Whether to retry at all
- New tip amount if retrying
- Whether to refresh the blockhash
- How long to wait before retrying
- One sentence of reasoning

The reasoning string from both decisions is stored verbatim in the lifecycle log entry for that run. This is what makes the agent's decisions auditable.

---

## Observed Data From Running System

These numbers are from the actual `logs/lifecycle.json` produced by this stack on Solana devnet:

**Processed to confirmed delta across 10 runs:**
- Run D584DD: 21ms
- Run 6D49F3: 22ms
- Run 15F672: 17ms
- Run 90D8EA: 18ms
- Run 8D657C: 18ms
- Run EFB4BE: 17ms
- Run 594563: 18ms
- Run B7DB9F: 17ms
- Run 066838: 18ms
- Run C56664: 17ms

Average: 18.3ms. This is unusually fast compared to mainnet (400-800ms typical) because devnet has far fewer validators and vote propagation is nearly instant.

**Confirmed to finalized delta:**
All 10 runs landed between 12160ms and 12987ms. The expected range based on the 32-slot finality window at 400ms per slot is 12800ms. The observed numbers are consistent with this.

**Fault injection run CDFDF49C871E:**
- Stale blockhash submitted at timestamp 1780623959978
- Failure detected 67ms later
- Agent reasoning: "The blockhash has expired and needs to be refreshed before retrying with a competitive tip"
- Agent decided to retry with refreshed blockhash after 1507ms wait
- RetryCount: 1

---

## Verifying On-Chain Data

Every signature in `logs/lifecycle.json` can be verified at:

```
https://explorer.solana.com/tx/SIGNATURE?cluster=devnet
```

Example (run D584DD2E4290):
```
https://explorer.solana.com/tx/rRnhpT7Jv4hc1pgX2rDP91B23mH38nnrn2T7A2Dk4V2fEu4EZCtqi3YZNB8NAfQAUMND1TSqUZzVH8hCsY7zsV5?cluster=devnet
```

Slot numbers can be searched directly on explorer by switching to the block view. The slot numbers in the lifecycle log are consistent with the timestamps recorded, confirming the data was captured from a real running system and not fabricated.

---

## Repository Structure

```
src/
  index.ts                 entry point and graceful shutdown
  config.ts                all environment variables with defaults
  types.ts                 shared TypeScript types across all layers
  stack.ts                 main orchestrator, runOne() and runBatch()
  agent/
    agent.ts               Groq AI agent, decideTip and decideRetry
  bundle/
    bundle-builder.ts      Bundle construction and BlockhashCache
    bundle-submitter.ts    Jito submission and error classification
  lifecycle/
    lifecycle-tracker.ts   Commitment polling processed to finalized
  stream/
    slot-stream.ts         Yellowstone gRPC with SlotPoller fallback
    tip-oracle.ts          getRecentPrioritizationFees wrapper
  utils/
    logger.ts              Structured logging, lifecycle.json writer
    wallet.ts              Keypair loader, devnet airdrop helper
    helpers.ts             IDs, timing, formatting
  scripts/
    fault-inject.ts        Blockhash expiry fault injection demo
logs/
  lifecycle.json           Append-only bundle run records
  session-*.log            Human-readable terminal session logs
```

---

## Judge-Facing Operational Proof Model

The stack separates implementation coverage from evidence quality. Implementation coverage lives in the source modules; proof quality is produced by real runs and checked by `npm run evidence:audit`.

### AI Decision Boundary

The AI agent does not sign, submit, or mutate transactions directly. The core stack gives it structured context:

- live tip percentiles
- current slot and average slot time
- Jito leader-window context
- recent failure rate
- failure classification and confidence
- previous tip and retry count
- blockhash-expiry context

The agent returns the operational decision: submit/hold, tip amount, retry action, blockhash refresh, wait time, confidence, and reasoning. The stack applies safety guardrails and writes `agentDecisionTrace` into the lifecycle log so judges can inspect the exact decision that influenced the run.

### Mainnet vs Devnet Evidence

Every `npm start` run attempts the Jito bundle path. On mainnet-beta, a working Jito endpoint can return a real `bundleId`; that is the strongest bundle proof. On devnet, Jito block-engine acceptance is not available in the same way, so the stack also sends a real Solana transaction and tracks its lifecycle for explorer-verifiable commitment evidence.

Final evidence should include both mainnet records with accepted Jito bundle IDs and devnet/mainnet records with signatures, explorer URLs, slots, and commitment deltas.

### 10/10 Evidence Target

The strict audit targets 40+ lifecycle records, 10+ mainnet records, 10+ devnet records, 5+ classified failures, 3+ distinct failure classes, 5+ unique tip values, structured AI traces on 90%+ of records, explorer URLs, network snapshots, leader-window context, processed-to-confirmed latency deltas, 5+ accepted mainnet Jito bundle IDs, and at least 1 blockhash-expiry recovery trace.

The goal is not to inflate counts. The goal is to make every claim cross-checkable against lifecycle logs, Solana Explorer, and the generated evidence report.

---

*Built for the Superteam Nigeria Advanced Infrastructure Challenge*
*Network: Solana Devnet | Language: TypeScript | AI: Groq LLaMA 3.3 70B*

---

## Hardening Pass — June 2026

The following subsystems were hardened or added in the Yellowstone/Jito
hardening pass. See `HARDENING_CHANGELOG.md` for the full file-by-file
breakdown.

### New components

**`src/jito/jito-grpc-client.ts`** — `JitoGrpcClientImpl`
Implements `JitoBundleClient` using the `jito-ts` gRPC `searcherClient`.
Includes 2-second leader cache, 500ms failure cache, `RateLimiter.runWithBackoff()`
for all calls, and a `subscribeBundleResults` gRPC stream. Degrades gracefully
when the native binding or auth keypair is absent.

**`src/core/failure-classifier.ts`**
Canonical re-export path. The `AdvancedFailureClassifier` implementation
remains in `src/bundle/` but is now accessible from `src/core/` as required
by the hardening spec. Also exports `FAILURE_CLASSES` const for quick imports.

### Enhanced components

**`RateLimiter.runWithBackoff()`**
Added to `src/utils/rate-limiter.ts`. Wraps `run()` with exponential
backoff (500ms × 2^n + jitter, max 10s) on 429 responses. Used by all
Jito outbound calls.

**Config — new Jito keys**
`config.jito` now includes: `rateLimitMs`, `leaderWindowSlots`,
`emergencyOverride`, `emergencyTipFloorLamports`, `minTipLamports`,
`maxTipLamports`. All are configurable via environment variables.

**`BundleBuilder` — signature uniqueness**
Each `build()` produces two transactions: a real-tx (1-lamport self-transfer
payload) and a tip-tx (monotonic nonce + tip instruction). The nonce ensures
the tip-tx always has a different signature from the real-tx and from every
prior build. Both signatures are logged for audit.

**`BundleSubmitter` — leader window gate + 429 backoff + raw result persistence**
Submission is now gated on `isJitoLeaderWindow` or stream health. Override
via `JITO_EMERGENCY_OVERRIDE=true`. All Jito calls use `runWithBackoff()`.
Raw bundle-result events from `subscribeBundleResults` are stored per
`bundleId` and returned in `SubmitResult.rawBundleResult`.

### Updated repository structure

```
src/
  core/
    failure-classifier.ts    canonical re-export of AdvancedFailureClassifier
  jito/
    jito-bundle-client.ts    JitoBundleClient interface (unchanged)
    jito-grpc-client.ts      NEW: gRPC transport via jito-ts searcherClient
    jito-jsonrpc-client.ts   JSON-RPC fallback transport (unchanged)
    leader-window-detector.ts leader-window cache (unchanged)
  utils/
    rate-limiter.ts          +runWithBackoff() for 429 handling
  config.ts                  +jito tip guardrails and leader-window config
  bundle/
    bundle-builder.ts        +signature uniqueness, +lastValidBlockHeight log
    bundle-submitter.ts      +leader gate, +429 backoff, +raw result store
HARDENING_CHANGELOG.md       complete file-by-file changelog
```

---

## Hardening Pass v2.1 (additional fixes)

The following targeted fixes were applied on top of the initial hardening pass.

### `src/utils/rate-limiter.ts` — `runWithBackoff()` implemented

The initial pass documented `runWithBackoff()` but the method body was
missing — `jito-grpc-client.ts` called it and would throw
`TypeError: this.limiter.runWithBackoff is not a function` at runtime.

Fix: implemented as a retry loop over `run()`:
- Detects 429 by checking `err.message` for "429", "rate limit", "too many requests".
- Non-429 errors re-thrown immediately.
- Schedule: `min(500ms × 2^n + jitter[0,500), 10 000ms)`, max 4 retries.

### `src/config.ts` — tip guardrails and leader-window config

Added `config.tip.minLamports` / `config.tip.maxLamports` (env:
`MIN_TIP_LAMPORTS` / `MAX_TIP_LAMPORTS`) and `config.jito.leaderWindowSlots`,
`config.jito.emergencyOverride`, `config.jito.emergencyMinTipLamports`.

### `src/bundle/bundle-builder.ts` — block-height expiry fix

`isExpiredNow()` previously compared slot numbers against
`lastValidBlockHeight`, which can diverge from the true block height during
skip events. The fix calls `connection.getBlockHeight("confirmed")` and
compares against `lastValidBlockHeight - SAFETY_MARGIN_BLOCKS (2)`. The old
`isExpiredAt(slot)` method is kept for backward compatibility.

`build()` now also applies tip guardrail clamping (`config.tip.min/max`) and
logs `bundleTxSignature` for signature-uniqueness audit.

### `src/bundle/bundle-submitter.ts` — leader-window gate wired

`setLeaderDetector()` method added. The `Stack` constructor now calls
`this.submitter.setLeaderDetector(this.leaderDetector)` to inject the
`LeaderWindowDetector` so `submitMainnet()` can gate on leader-window status.
Without this call the gate was always in "no detector" mode (allow-all).

Also added: `rawBundleResults` collection via `subscribeBundleResults()` and
returned in `SubmitResult` for persistence to `lifecycle.json`.

### `src/stack.ts` — wiring and raw-result persistence

- Added `this.submitter.setLeaderDetector(this.leaderDetector)` in constructor.
- `buildEntry()` now accepts and returns `rawBundleResults` and
  `bundleTxSignature` fields.
- Successful tracking call passes `submitResult.rawBundleResults`.

### `src/types.ts` — `rawBundleResults` in `LifecycleEntry`

Added `rawBundleResults?: unknown[]` to `LifecycleEntry` so the persisted
lifecycle record carries the raw bundle-result event payloads from the
block engine's `subscribeBundleResults` stream.

### `test/unit.test.ts` — three new `runWithBackoff` tests

- `retries on 429 and succeeds on second attempt`
- `propagates non-429 errors immediately`
- `exhausts retries on persistent 429`