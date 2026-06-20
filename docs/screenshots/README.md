# Submission Screenshots

Dashboard visualizations from the mainnet evidence run.

## Overview
- Total records: 40+
- Confirmed: 30+
- Failed: 5+
- p50 / p90 latencies and unique tip distribution

## AI Reasoning
- Expanded view of agentDecision trace (promptHash, model, reasoning)
- Example of a failed bundle with agent retry decision

## Finalized Table
- Records table showing all finalized lifecycle entries
- Each row includes explorer link, tip, and outcome

## How to generate screenshots

1. Run the evidence batch:
   ```bash
   npm run build
   npm run challenge:reset-evidence
   npm run challenge:run -- --count 40 --failures 5 --network mainnet-beta
   npm run challenge:export-evidence
   ```

2. Open the lifecycle dashboard (if `challenge:dashboard` is available) or inspect `evidence/run-summary.json`.

3. Save PNG files:
   - `docs/screenshots/01-overview.png`
   - `docs/screenshots/02-ai-reasoning.png`
   - `docs/screenshots/03-finalized-table.png`

Evidence artifacts are generated automatically:
- `evidence/run-summary.json`
- `evidence/verification-report.md`
