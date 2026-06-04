import {
  Keypair,
  PublicKey,
  Connection,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config";

// Load wallet from environment
export function loadWalletFromEnv(): Keypair {
  const raw = config.wallet.privateKey;

  // Support both base58-encoded secret keys and comma-separated byte arrays
  if (raw.includes(",")) {
    const bytes = Uint8Array.from(raw.split(",").map(Number));
    return Keypair.fromSecretKey(bytes);
  }

  // bs58 decode - standard Phantom / Solana CLI export format
  const decoded = bs58.decode(raw);
  return Keypair.fromSecretKey(decoded);
}

// Get wallet balance in SOL
export async function getBalanceSol(
  connection: Connection,
  pubkey: PublicKey
): Promise<number> {
  const lamports = await connection.getBalance(pubkey, "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

// Build a minimal self-transfer transaction for testing
// Sends 0 lamports back to self - cheap, verifiable, produces a real signature
export function buildSelfTransferTx(payer: Keypair): Transaction {
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 0,
    })
  );
  return tx;
}

// Request airdrop on devnet if balance is low
export async function requestAirdropIfNeeded(
  connection: Connection,
  keypair: Keypair,
  minSol: number = 0.1
): Promise<void> {
  const balance = await getBalanceSol(connection, keypair.publicKey);
  if (balance >= minSol) return;

  console.log(`[wallet] Balance low (${balance.toFixed(4)} SOL) - requesting airdrop...`);
  const sig = await connection.requestAirdrop(
    keypair.publicKey,
    LAMPORTS_PER_SOL * 0.5
  );
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`[wallet] Airdrop confirmed. New balance: ${(await getBalanceSol(connection, keypair.publicKey)).toFixed(4)} SOL`);
}
