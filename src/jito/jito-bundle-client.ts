import { VersionedTransaction } from "@solana/web3.js";

// JitoBundleClient
// Transport-agnostic interface over both Jito transports (gRPC and JSON-RPC).
// The orchestrator uses this interface exclusively so transports are
// interchangeable without changes to the calling code.

export interface LeaderInfo {
  currentSlot:        number;
  nextLeaderSlot:     number;
  nextLeaderIdentity: string | null;
}

export type BundleResultState =
  | "accepted"
  | "processed"
  | "finalized"
  | "rejected"
  | "dropped";

export interface BundleResultUpdate {
  bundleId: string;
  state:    BundleResultState;
  slot?:    number;
  raw?:     unknown;
}

export type BundleResultCallback = (update: BundleResultUpdate) => void;
export type BundleErrorCallback  = (err: Error) => void;

export interface JitoBundleClient {
  // Which transport is active; useful for diagnostics and lifecycle logging
  readonly transport: "grpc" | "jsonrpc";

  // Returns the set of valid Jito tip account addresses
  getTipAccounts(): Promise<string[]>;

  // Submits a bundle and returns the bundleId on acceptance.
  // Throws on rejection; the caller is responsible for classifying the error.
  sendBundle(transactions: VersionedTransaction[]): Promise<string>;

  // Returns the current slot and the next scheduled Jito leader slot.
  // Implementations should cache results for at least 2 seconds.
  getNextScheduledLeader(): Promise<LeaderInfo>;

  // Registers a callback that is called whenever a bundle-result event
  // arrives for any bundle submitted by this client. Not all transports
  // support this (JSON-RPC does not); implementations that cannot support
  // it must document the limitation and are allowed to return a no-op
  // unsubscribe function.
  subscribeBundleResults(
    onUpdate: BundleResultCallback,
    onError: BundleErrorCallback
  ): () => void;

  // Releases all resources held by this client
  close(): void;
}