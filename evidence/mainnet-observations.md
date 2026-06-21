# Mainnet Observations

Generated: 2026-06-21T07:29:07.554Z
Source: logs/lifecycle.json (23 mainnet-beta normal runs, fault injection entries excluded)

All values below are computed directly from this stack's own recorded runs.
No estimated, placeholder, or third-party "public metrics" values are used.

---

## Run Summary

- Total mainnet runs: 23
- Confirmed or finalized: 22
- Landing rate: 96%

## Processed to Confirmed Latency

| Metric | Value |
|---|---|
| Samples | 22 |
| Average | 98ms |
| p50 | 97ms |
| p90 | 101ms |
| p99 | 109ms |

## Block Production Rate (observed by SlotPoller / SlotStream)

| Metric | Value |
|---|---|
| Samples | 23 |
| Average | 451ms/slot |
| p50 | 436ms |
| p90 | 482ms |
| p99 | 484ms |

## Latency Trend Across the Run Sequence

processed-to-confirmed latency decreased by 0.2% from the first half of the run sequence (avg 99ms) to the second half (avg 98ms).

This trend is fed back into the agent via `processedToConfirmedMsP50` and
`processedToConfirmedMsP90` on subsequent runs within the same session,
influencing the congestion multiplier on later tip decisions.

## Per-Run Detail

| Run | Run ID | Tip (lamports) | Agent Action | Final Stage | Processed to Confirmed |
|---|---|---|---|---|---|
| 1 | EEDF73F23974 | 119750 | submit_now | finalized | 102ms |
| 2 | 02EFC16F282D | 6300 | submit_now | finalized | 100ms |
| 3 | 4A3AB1D96FE6 | 2953 | submit_now | finalized | 99ms |
| 4 | 13DBEE0F63F3 | 4604 | submit_now | finalized | 97ms |
| 5 | D43351D0A5C2 | 5886 | submit_now | finalized | 96ms |
| 6 | C51B7C6CBB7C | 2124 | submit_now | finalized | 97ms |
| 7 | 5CD16E93DFAB | 2200 | submit_now | finalized | 93ms |
| 8 | F84ACB142874 | 2062 | submit_now | finalized | 117ms |
| 9 | 215A910A39F7 | 2928 | submit_now | finalized | 89ms |
| 10 | 69654851F488 | 4587 | submit_now | finalized | 101ms |
| 11 | 4F1C7E714A8C | 9962 | submit_now | finalized | 93ms |
| 12 | A1EFAB5D3C9C | 9082 | submit_now | finalized | 99ms |
| 13 | 10721E1DEB3F | 1585 | submit_now | finalized | 109ms |
| 14 | 789DAF2B2CF0 | 3037 | submit_now | finalized | 97ms |
| 15 | D108AD7830ED | 3083 | submit_now | finalized | 97ms |
| 16 | 63EC3483114E | 1819 | submit_now | finalized | 94ms |
| 17 | A777D3695885 | 4276 | submit_now | failed | - |
| 18 | 3C9AA6899E7C | 3886 | submit_now | finalized | 95ms |
| 19 | 992A6F27E08F | 1541 | submit_now | finalized | 98ms |
| 20 | 3452C21CACF5 | 2154 | submit_now | finalized | 100ms |
| 21 | FC576ACB3449 | 2730 | submit_now | finalized | 100ms |
| 22 | DA58DCFE7DE7 | 2739 | submit_now | finalized | 94ms |
| 23 | F25110AE5B62 | 1852 | submit_now | finalized | 99ms |

---

## README Question 1 (Updated With Mainnet Data)

### What does the delta between processed_at and confirmed_at tell you about network health?

The processed to confirmed delta measures the time for the validator set to
reach supermajority consensus (66%+ stake weight) on the block containing
the transaction.

In this stack's 23 mainnet-beta runs, the observed
processed-to-confirmed delta averaged 98ms, with a p50 of
97ms and a p90 of 101ms.
The p90 was 4% higher than the p50, showing the tail of the distribution is meaningfully slower than the median.

processed-to-confirmed latency decreased by 0.2% from the first half of the run sequence (avg 99ms) to the second half (avg 98ms).

This stack feeds the rolling p50 and p90 into `NetworkSnapshot.processedToConfirmedMsP50`
and `processedToConfirmedMsP90`, which are used directly in the agent's
congestion multiplier calculation (`computeCongestionMultiplier` in
`src/agent/agent.ts`). A rising p90 relative to p50 increases the multiplier,
pushing the agent toward higher tip percentiles on the next submission.

---

All slot numbers and signatures referenced in `logs/lifecycle.json` for these
runs are verifiable at https://explorer.solana.com/?cluster=mainnet-beta
