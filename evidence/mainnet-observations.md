# Mainnet Observations

Generated: 2026-06-20T11:41:31.807Z
Source: logs/lifecycle.json (33 mainnet-beta normal runs, fault injection entries excluded)

All values below are computed directly from this stack's own recorded runs.
No estimated, placeholder, or third-party "public metrics" values are used.

---

## Run Summary

- Total mainnet runs: 33
- Confirmed or finalized: 23
- Landing rate: 70%

## Processed to Confirmed Latency

| Metric | Value |
|---|---|
| Samples | 23 |
| Average | 2700ms |
| p50 | 11ms |
| p90 | 2451ms |
| p99 | 4735ms |

## Block Production Rate (observed by SlotPoller / SlotStream)

| Metric | Value |
|---|---|
| Samples | 33 |
| Average | 419ms/slot |
| p50 | 408ms |
| p90 | 452ms |
| p99 | 499ms |

## Latency Trend Across the Run Sequence

processed-to-confirmed latency decreased by 84.8% from the first half of the run sequence (avg 4844ms) to the second half (avg 734ms).

This trend is fed back into the agent via `processedToConfirmedMsP50` and
`processedToConfirmedMsP90` on subsequent runs within the same session,
influencing the congestion multiplier on later tip decisions.

## Per-Run Detail

| Run | Run ID | Tip (lamports) | Agent Action | Final Stage | Processed to Confirmed |
|---|---|---|---|---|---|
| 1 | B76D67493D79 | 2708 | submit_now | failed | - |
| 2 | 16F05CDCFC8D | 8352 | submit_now | failed | - |
| 3 | 4AB4C89140A8 | 17912 | submit_now | failed | - |
| 4 | F6FDDAB95ADA | 10000 | submit_now | failed | - |
| 5 | 6A9DE52039AC | 7916 | submit_now | failed | - |
| 6 | D9B845D12CCF | 6850 | submit_now | failed | - |
| 7 | 6743DD177C1D | 9948 | submit_now | failed | - |
| 8 | 42D9625BB91E | 3425 | submit_now | failed | - |
| 9 | C31CB3250BD2 | 13070 | submit_now | failed | - |
| 10 | D060AFB7EA9F | 3023 | submit_now | finalized | 5ms |
| 11 | 6C395360F992 | 2528 | submit_now | failed | - |
| 12 | 1D41EF5EAE3C | 4475 | submit_now | finalized | 6ms |
| 13 | 3A4A26C39D48 | 4992 | submit_now | finalized | 17ms |
| 14 | 8F0B00751112 | 1407 | submit_now | finalized | 5ms |
| 15 | D227283645C3 | 1319 | submit_now | finalized | 4ms |
| 16 | 2FA954AF989E | 2006 | submit_now | finalized | 5ms |
| 17 | 0009FE681200 | 1355 | submit_now | finalized | 1516ms |
| 18 | 10953EE73A43 | 1868 | submit_now | finalized | 45014ms |
| 19 | 503CCFB338EA | 1820 | submit_now | finalized | 2625ms |
| 20 | D4F5FC4882DA | 2263 | submit_now | finalized | 1637ms |
| 21 | 6990D1C61383 | 2283 | submit_now | finalized | 2451ms |
| 22 | D6C99C26C0A4 | 1885 | submit_now | finalized | 1476ms |
| 23 | 2E6D9D7AD114 | 2292 | submit_now | finalized | 5ms |
| 24 | 507D6719186F | 2554 | submit_now | finalized | 526ms |
| 25 | 8B9D0340E026 | 4164 | submit_now | finalized | 4735ms |
| 26 | D0745EFF4208 | 1719 | submit_now | finalized | 10ms |
| 27 | 2B3A40745C70 | 1719 | submit_now | finalized | 6ms |
| 28 | C4E5863B8627 | 1809 | submit_now | finalized | 11ms |
| 29 | F9969CF8E866 | 1850 | submit_now | finalized | 1539ms |
| 30 | 29C86548378B | 1862 | submit_now | finalized | 5ms |
| 31 | 92BC9517066D | 3764 | submit_now | finalized | 6ms |
| 32 | C4E2D7FFC21E | 1810 | submit_now | finalized | 7ms |
| 33 | 24B1775FB65B | 1821 | submit_now | finalized | 486ms |

---

## README Question 1 (Updated With Mainnet Data)

### What does the delta between processed_at and confirmed_at tell you about network health?

The processed to confirmed delta measures the time for the validator set to
reach supermajority consensus (66%+ stake weight) on the block containing
the transaction.

In this stack's 33 mainnet-beta runs, the observed
processed-to-confirmed delta averaged 2700ms, with a p50 of
11ms and a p90 of 2451ms.
The p90 was 22182% higher than the p50, showing the tail of the distribution is meaningfully slower than the median.

processed-to-confirmed latency decreased by 84.8% from the first half of the run sequence (avg 4844ms) to the second half (avg 734ms).

This stack feeds the rolling p50 and p90 into `NetworkSnapshot.processedToConfirmedMsP50`
and `processedToConfirmedMsP90`, which are used directly in the agent's
congestion multiplier calculation (`computeCongestionMultiplier` in
`src/agent/agent.ts`). A rising p90 relative to p50 increases the multiplier,
pushing the agent toward higher tip percentiles on the next submission.

---

All slot numbers and signatures referenced in `logs/lifecycle.json` for these
runs are verifiable at https://explorer.solana.com/?cluster=mainnet-beta
