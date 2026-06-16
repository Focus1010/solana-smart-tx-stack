# Blockhash Expiry Recovery Evidence

The bounty requires an autonomous retry path for blockhash expiry. This project demonstrates that path through `npm run run:inject`.

## Expected Sequence

1. The fault injector builds a transaction with a stale blockhash.
2. Jito/RPC rejects or fails the transaction path.
3. `AdvancedFailureClassifier` labels the failure as `EXPIRED_BLOCKHASH`.
4. The AI retry path receives:
   - failure type
   - classifier confidence and recovery path
   - retry count
   - previous tip
   - current tip percentiles
   - current slot and leader-window context
5. The agent chooses `retry_refresh_blockhash`.
6. The stack fetches a fresh blockhash at `confirmed` commitment.
7. The retry transaction is submitted and tracked.
8. The lifecycle log stores `agentDecisionTrace` with `refreshBlockhash: true`.

## What Judges Should Check

In `logs/lifecycle.json`, look for records where:

```json
{
  "failure": "EXPIRED_BLOCKHASH",
  "faultInjected": "expired_blockhash",
  "agentAction": "retry_refresh_blockhash",
  "retryCount": 1,
  "agentDecisionTrace": [
    {
      "decisionType": "autonomous_retry",
      "refreshBlockhash": true
    }
  ]
}
```

Then cross-check any `explorerUrl` on the recovered record when a signature is present.

## Why This Matters

Fetching a blockhash at `finalized` starts with a stale hash and burns part of Solana's blockhash validity window before the transaction is even signed. This stack fetches fresh blockhashes at `confirmed` commitment and refreshes them when the classifier/agent path sees expiry.
