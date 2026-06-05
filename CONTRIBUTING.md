# Contributing to Solana Smart Transaction Stack

## Development Setup

### Prerequisites
- Node.js 18+ (LTS recommended)
- npm 9+
- git

### Quick Start
```bash
git clone https://github.com/Focus1010/solana-smart-tx-stack
cd solana-smart-tx-stack
npm install
cp .env.example .env
# Edit .env with your credentials
npm start
```

### Project Structure Philosophy

Layer-based architecture enables independent testing and deployment:

- **Layer 1**: Network Observer (slot stream + tip oracle)
- **Layer 2**: AI Agent (tip decisions + retry reasoning)
- **Layer 3**: Bundle Builder (transactions + blockhash management)
- **Layer 4**: Submitter + Tracker (lifecycle tracking + failure classification)
- **Layer 5**: Lifecycle Log (append-only event store)

Each layer is designed to be independent and testable.

### Running Tests

```bash
# Run main stack (10 bundles)
npm start

# Run fault injection demo (guaranteed failure + retry)
npm run run:inject

# Build TypeScript
npm run build
```

### Understanding the AI Agent

The agent makes two key operational decisions:

**1. Tip Intelligence (decideTip)**
- Input: live fee percentiles (p25/p50/p75/p95) + network conditions
- Output: optimal tip amount in lamports
- How it works: Groq analyzes current network state and selects appropriate percentile based on slot timing
- Why not hardcoded: Network conditions change every block; static values would fail under load

**2. Retry Reasoning (decideRetry)**
- Input: failure classification + network state + retry count
- Output: retry decision + new tip + wait time + blockhash refresh flag
- How it works: Different failure types require different strategies; agent learns from context
- Why not hardcoded: Failure causes vary; optimal retry strategy depends on current conditions

Temperature 0.2 ensures consistent, deterministic decisions across identical conditions.

### Extending the Stack

To add a new failure type:
1. Add to FailureReason type in src/types.ts
2. Add detection logic in LifecycleTracker.classifyTransactionError()
3. Add agent guidance in Agent.decideRetry() prompt
4. Add documentation to README failure types table

To add a new data source:
1. Create new provider class in src/stream/
2. Implement slot stream interface (getCurrentSlot, getRecentSlotTimes)
3. Update Stack constructor to conditionally use new provider
4. Document configuration in README

### Code Style

- TypeScript strict mode enabled across entire codebase
- No hardcoded values; all configuration via .env or config.ts
- All I/O operations are logged
- Error messages include context and remediation steps
- Comments explain operational decisions, not basic syntax

### Troubleshooting

**"NOTFOUND devnet.block-engine.jito.wtf"**
- This is expected on devnet. Jito does not operate block engines on devnet. Stack compensates by sending real devnet transactions for lifecycle tracking.

**"Missing GROQ_API_KEY"**
- Get free API key at console.groq.com (no card required, free tier sufficient)

**"Insufficient balance"**
- Stack automatically airdrops 0.5 SOL on devnet when balance drops below 0.1 SOL

**"RPC connection timeout"**
- Retry with different RPC endpoint; set SOLANA_RPC_URL in .env to an alternative provider

### Performance Tuning

- BUNDLE_COUNT: Increase for longer testing sessions; default 10
- MAX_RETRIES: Lower to fail faster, higher for persistence; default 3
- RETRY_DELAY_MS: Adjust backoff strategy per network conditions; default 2000
- YELLOWSTONE_ENDPOINT: Use gRPC for faster slot updates if SolInfra credits available

### Reporting Issues

When reporting bugs, include:
- Full stack traces from logs/session-*.log
- Relevant lifecycle.json entries
- Environment (devnet/mainnet)
- Groq model used
- Network conditions observed (slot timing, fee trends)
- Steps to reproduce

