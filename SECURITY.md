# Security Policy

This stack is designed to run against Solana devnet or mainnet-beta with private RPC, Yellowstone, Jito, wallet, and AI-provider credentials. Treat every value in `.env` as secret operational material.

## Secrets and key handling

- Never commit `.env`, private keys, generated keypairs, or provider tokens.
- `WALLET_PRIVATE_KEY` should be a low-balance operational wallet, not a treasury wallet.
- Use a dedicated bounty/demo wallet with only the SOL needed for fees and tips.
- Rotate `GROQ_API_KEY`, `YELLOWSTONE_TOKEN`, RPC credentials, and Jito credentials if logs or screenshots expose them.
- Keep `keys/` and local wallet exports out of Git. If a key is accidentally committed, assume it is compromised and replace it.

## Runtime safety

- Devnet is the default network for safe demos. Mainnet-beta should be enabled only by explicitly setting `SOLANA_NETWORK=mainnet-beta` and production RPC/Jito endpoints.
- Tip outputs are bounded in the agent layer so an LLM response cannot produce an unlimited tip.
- Blockhashes are fetched at `confirmed` commitment, never `finalized`, to avoid starting with stale hashes.
- Retries are capped by `MAX_RETRIES`; non-recoverable failures such as compute exhaustion, simulation failure, and insufficient funds abort instead of looping.

## Evidence and logs

- Lifecycle logs may include transaction signatures, slots, timing data, tip amounts, and high-level agent reasoning.
- Do not place raw private keys, API keys, endpoint tokens, or full provider credentials in lifecycle logs or public architecture documents.
- Before submission, review `logs/`, `evidence/`, README screenshots, and hosted documents for accidental secrets.

## Reporting issues

If you find a security issue in this demo stack, open a private issue or contact the maintainer directly before publishing details. Include the affected module, reproduction steps, and whether any credential material may have been exposed.