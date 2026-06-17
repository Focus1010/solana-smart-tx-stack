import crypto from "crypto";

//  Unique run ID per bundle submission 

export function newRunId(): string {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

//  Sleep helper 

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

//  Moving average over a window of numbers 

export function movingAverage(values: number[], windowSize: number): number {
  if (values.length === 0) return 0;
  const window = values.slice(-windowSize);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

//  Slot time estimator 
// Returns estimated ms per slot from a series of slot timestamps.

export function estimateSlotTimeMs(slotTimestamps: number[]): number {
  if (slotTimestamps.length < 2) return 400; // Solana target ~400ms
  const deltas: number[] = [];
  for (let i = 1; i < slotTimestamps.length; i++) {
    deltas.push(slotTimestamps[i] - slotTimestamps[i - 1]);
  }
  return movingAverage(deltas, deltas.length);
}

//  Format lamports for display 

export function formatLamports(lamports: number): string {
  if (lamports >= 1_000_000) return `${(lamports / 1_000_000).toFixed(3)}M`;
  if (lamports >= 1_000)     return `${(lamports / 1_000).toFixed(1)}K`;
  return `${lamports}`;
}

//  Truncate a base58 string for display 

export function shortKey(key: string, chars = 8): string {
  return `${key.slice(0, chars)}${key.slice(-4)}`;
}