# Hardening Changelog

This document summarises every file added or modified during the
Yellowstone/Jito hardening pass and the reason each change was made.

---

## New files

### `src/jito/jito-grpc-client.ts`
Implements `JitoBundleClient` using the `jito-ts` `searcherClient` gRPC
transport. All calls (`getTipAccounts`, `sendBundle`, `getNextScheduledLeader`)
go through `RateLimiter.runWithBackoff()` with exponential back-off on 429
responses. `subscribeBundleResults` opens a real gRPC stream and forwards raw
result objects to callers so they can be persisted in lifecycle records.
The client degrades gracefully when the native binding or auth keypair is
absent: it falls through to static tip accounts and synthesised leader
fallbacks rather than crashing the stack.

### `src/core/failure-classifier.ts`
Canonical module path for `AdvancedFailureClassifier`. The implementation
lives in `src/bundle/failure-classifier.ts`; this file re-exports it so
any import from `src/core/failure-classifier` resolves without a duplicate
implementation. Also exports `FAILURE_CLASSES` — a const object mapping
each canonical failure type string to itself — for fast imports without
instantiating the classifier.

---

## Modified files

### `src/utils/rate-limiter.ts`
**Added `runWithBackoff<T>(fn)`.**
The original `RateLimiter` only had `run()`. All Jito transport code references
`runWithBackoff()` for automatic retry on HTTP 429 responses. Without this
method the gRPC client would throw `TypeError: this.limiter.runWithBackoff is
not a function` at runtime, breaking all bundle submissions.

Implementation:
- Wraps `run()` with a retry loop capped at `BACKOFF_MAX_RETRY = 4` retries.
- Detects 429 by inspecting `err.message` for "429", "rate limit", or
  "too many requests" (case-insensitive).
- Non-429 errors are re-thrown immediately (no retry).
- Backoff schedule: `min(500ms × 2^attempt + jitter[0,500), 10 000ms)`.
- `is429Error()` helper is private; only called inside `runWithBackoff`.

### `src/config.ts`
**Added six new runtime-configurable values** previously hard-coded or absent:

| Env var | Default | Purpose |
|---|---|---|
| `MIN_TIP_LAMPORTS` | 1 000 | Hard guardrail floor on all tips |
| `MAX_TIP_LAMPORTS` | 1 000 000 | Hard guardrail ceiling on all tips |
| `JITO_LEADER_WINDOW_SLOTS` | 4 | Gate window (slots ahead of Jito leader) |
| `JITO_EMERGENCY_OVERRIDE` | false | Bypass leader-window gating |
| `JITO_EMERGENCY_MIN_TIP_LAMPORTS` | 10 000 | Tip floor when override is active |
| `JITO_RATE_LIMIT_MS` | 1 100 | Min ms between Jito API calls |

All values have safe production defaults and are fully documented in
`.env.example`.

### `src/bundle/bundle-builder.ts`
**Four improvements:**

1. **Block-height-based blockhash expiry** (`isExpiredNow()`): replaces the
   slot-number heuristic with a real `getBlockHeight()` call compared against
   `lastValidBlockHeight` with a configurable `SAFETY_MARGIN_BLOCKS = 2`.
   This is the only reliable way to detect expiry because slots and block
   heights can diverge during skip events.

2. **Pre-build expiry check**: `build()` calls `isExpiredNow()` before using
   the cached blockhash and forces a refresh if the blockhash is near or past
   its validity window.

3. **Tip guardrail clamping**: `build()` clamps `tipLamports` to
   `[config.tip.minLamports, config.tip.maxLamports]` before building the
   transaction, and logs a warning when clamping occurs. This ensures no
   agent decision — however misconfigured — can produce a tip below 1 000 or
   above 1 000 000 lamports without explicit operator override.

4. **Signature uniqueness logging**: the bundle transaction signature
   (`bundleTxSignature`) is extracted and returned in `BuiltBundle` so the
   orchestrator can log it alongside the real-tx signature. Because the bundle
   tx uses a randomly chosen tip account and signs a different message from the
   real tx, the two signatures are always distinct. This is now auditable in
   `logs/lifecycle.json`.

### `src/bundle/bundle-submitter.ts`
**Four improvements:**

1. **Leader-window gating**: `submitMainnet()` now calls
   `this.leaderDetector.detect()` before submitting a bundle. Submission is
   blocked unless:
   - `isJitoLeaderWindow` is true, OR
   - `slotsUntilJitoLeader <= config.jito.leaderWindowSlots`, OR
   - `config.jito.emergencyOverride` is `true`.
   When the override is active the tip is bumped to
   `config.jito.emergencyMinTipLamports` if the current tip is lower.

2. **`setLeaderDetector()`**: new method allows the orchestrator (`Stack`) to
   inject the `LeaderWindowDetector` after construction, avoiding a circular
   dependency.

3. **Raw bundle-result persistence**: `subscribeBundleResults()` is called
   before every mainnet submission. All received `BundleResultUpdate.raw`
   payloads are collected into `rawBundleResults[]` and returned in
   `SubmitResult` so the orchestrator can persist them to `lifecycle.json`.

4. **429 back-off on send and poll**: `sendBundle` and
   `getInflightBundleStatus` calls are wrapped in
   `this.limiter.runWithBackoff()` for automatic exponential back-off on 429
   responses.

### `src/stack.ts`
**Two improvements:**

1. **`setLeaderDetector` wiring**: `this.submitter.setLeaderDetector(this.leaderDetector)`
   is now called in the `Stack` constructor after both objects are created,
   enabling leader-window gating in `BundleSubmitter`.

2. **`rawBundleResults` and `bundleTxSignature` in lifecycle entries**:
   `buildEntry()` now accepts and persists `rawBundleResults` and
   `bundleTxSignature` from `SubmitResult`, making raw bundle outcomes
   auditable in `logs/lifecycle.json`.

### `src/types.ts`
**Added `rawBundleResults?: unknown[]`** to `LifecycleEntry`. Stores the
raw bundle-result event payloads (accepted/rejected/dropped) collected during
the submission window so operators can diagnose why specific bundles were not
landed without needing access to the block engine's internal logs.

### `test/unit.test.ts`
**Added three `runWithBackoff` unit tests:**

- `retries on 429 and succeeds on second attempt` — verifies the happy-path
  retry succeeds.
- `propagates non-429 errors immediately` — verifies non-retryable errors
  are thrown without retrying.
- `exhausts retries on persistent 429` — verifies the retry cap is respected
  and the last error is re-thrown.

### `.env.example`
Added documentation for the six new env vars: `MIN_TIP_LAMPORTS`,
`MAX_TIP_LAMPORTS`, `JITO_LEADER_WINDOW_SLOTS`, `JITO_EMERGENCY_OVERRIDE`,
`JITO_EMERGENCY_MIN_TIP_LAMPORTS`, `JITO_RATE_LIMIT_MS`,
`STREAM_HIGH_WATERMARK`, `STREAM_RESUME_WATERMARK`.

---

## Files unchanged (already correct)

| File | Status |
|---|---|
| `src/geyser/yellowstone-client.ts` | ✅ Complete — safe import, `pingRequest`, `baseSubscribeRequest`, `numericToSlotStatus` all present |
| `src/geyser/reconnecting-stream.ts` | ✅ Complete — reconnect loop, ping keepalive every 30s, `fromSlot` replay, backpressure, all events |
| `src/stream/slot-stream.ts` | ✅ Complete — uses `ReconnectingYellowstoneStream`, normalises statuses, falls back to `SlotPoller` |
| `src/jito/jito-bundle-client.ts` | ✅ Complete — transport-agnostic interface with all required methods |
| `src/jito/jito-grpc-client.ts` | ✅ Complete — gRPC transport with rate limiting and 2s leader cache |
| `src/jito/jito-jsonrpc-client.ts` | ✅ Complete — JSON-RPC fallback with rate limiting and documented subscribe limitation |
| `src/jito/leader-window-detector.ts` | ✅ Complete — 2s cache, 500ms fail-cache, `RateLimiter` usage |
| `src/bundle/failure-classifier.ts` | ✅ Complete — all seven canonical failure classes mapped |
| `src/core/failure-classifier.ts` | ✅ Complete — re-exports `AdvancedFailureClassifier` at canonical path |
| `src/lifecycle/lifecycle-tracker.ts` | ✅ Complete — stream-first confirmation with RPC fallback |
| `src/scripts/fault-inject.ts` | ✅ Complete — three fault scenarios (expired-blockhash, low-tip, compute-exceeded) |
| `src/scripts/generate-evidence.ts` | ✅ Complete — produces `run-summary.json` and `verification-report.md` |
| `src/scripts/verify-evidence.ts` | ✅ Complete — checks explorer URLs via HTTP HEAD |

---

## Config defaults summary

| Setting | Default | Env var |
|---|---|---|
| Tip floor | 1 000 lamports | `MIN_TIP_LAMPORTS` |
| Tip ceiling | 1 000 000 lamports | `MAX_TIP_LAMPORTS` |
| Leader window | 4 slots | `JITO_LEADER_WINDOW_SLOTS` |
| Emergency override | off | `JITO_EMERGENCY_OVERRIDE` |
| Emergency tip floor | 10 000 lamports | `JITO_EMERGENCY_MIN_TIP_LAMPORTS` |
| Jito rate limit | 1 100 ms | `JITO_RATE_LIMIT_MS` |
| Stream high watermark | 5 000 events | `STREAM_HIGH_WATERMARK` |
| Stream resume watermark | 2 500 events | `STREAM_RESUME_WATERMARK` |
| Blockhash safety margin | 2 blocks | hard-coded in `bundle-builder.ts` |
| Blockhash refresh interval | 100 slots | hard-coded in `bundle-builder.ts` |
| Ping interval | 30 000 ms | hard-coded in `reconnecting-stream.ts` |
| Leader cache TTL | 2 000 ms | hard-coded in `leader-window-detector.ts` |
| Leader fail cache | 500 ms | hard-coded in `leader-window-detector.ts` |
| 429 backoff base | 500 ms | hard-coded in `rate-limiter.ts` |
| 429 backoff max | 10 000 ms | hard-coded in `rate-limiter.ts` |
| 429 max retries | 4 | hard-coded in `rate-limiter.ts` |