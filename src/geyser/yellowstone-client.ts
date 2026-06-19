// YellowstoneClientFactory
// Centralizes the safe import of @triton-one/yellowstone-grpc, which uses a
// native Rust binding that may be absent on some platforms. All Yellowstone
// client creation in this codebase goes through this factory so the rest of
// the stack never touches the raw package directly.
//
// Exports:
//   createYellowstoneClient(endpoint, token, opts?)
//     Returns a connected client instance. Throws if the native binding is
//     unavailable -- callers must handle that case with a fallback.
//
//   isYellowstoneAvailable()
//     Returns true when the native binding loaded successfully. Use this to
//     gate Yellowstone code paths without attempting a connection.
//
//   baseSubscribeRequest(commitment?)
//     Returns the canonical subscription request object that must be sent as
//     the first write on every new stream. All empty maps are included so the
//     server does not reject the request for missing fields.
//
//   commitmentToYellowstone(level)
//     Converts a string commitment level to the Yellowstone proto enum value.

// Yellowstone slot status integers (Dragon's Mouth proto)
export const YS_PROCESSED = 0;
export const YS_CONFIRMED = 1;
export const YS_FINALIZED = 2;
export const YS_DEAD      = 6;

let _Client: any     = null;
let _Commitment: any = null;
let _available       = false;

try {
  const mod    = require("@triton-one/yellowstone-grpc");
  _Client      = mod.default ?? mod;
  _Commitment  = mod.CommitmentLevel ?? null;
  _available   = typeof _Client === "function";
} catch {
  // Native binding unavailable on this platform.
  // isYellowstoneAvailable() will return false and callers use SlotPoller.
}

export function isYellowstoneAvailable(): boolean {
  return _available;
}

export interface YellowstoneClientOptions {
  maxReceiveMessageLength?: number;
}

export function createYellowstoneClient(
  endpoint: string,
  token: string,
  opts: YellowstoneClientOptions = {}
): any {
  if (!_available) {
    throw new Error(
      "@triton-one/yellowstone-grpc native binding is not available on this platform"
    );
  }

  // SDK v5 requires the https:// prefix on the endpoint
  const normalized = endpoint.startsWith("http")
    ? endpoint
    : `https://${endpoint}`;

  const grpcOpts: Record<string, unknown> = {
    "grpc.max_receive_message_length":
      opts.maxReceiveMessageLength ?? 64 * 1024 * 1024,
  };

  return new _Client(
    normalized,
    token || undefined,
    grpcOpts
  );
}

export function commitmentToYellowstone(level: "processed" | "confirmed" | "finalized"): number {
  if (!_Commitment) {
    // Fall back to integer values from the proto spec
    return level === "finalized" ? 2 : level === "confirmed" ? 1 : 0;
  }
  switch (level) {
    case "finalized": return _Commitment.FINALIZED ?? 2;
    case "confirmed": return _Commitment.CONFIRMED  ?? 1;
    default:          return _Commitment.PROCESSED  ?? 0;
  }
}

// baseSubscribeRequest returns the canonical first-write request object.
// All maps must be present (even empty ones) or the server may reject the
// subscription. The slot filter label ("solana") is an arbitrary string --
// only filterByCommitment matters.
export function baseSubscribeRequest(
  commitment: "processed" | "confirmed" | "finalized" = "processed",
  fromSlot?: bigint | string
): Record<string, unknown> {
  const req: Record<string, unknown> = {
    slots:              { solana: { filterByCommitment: false } },
    accounts:           {},
    transactions:       {},
    transactionsStatus: {},
    blocks:             {},
    blocksMeta:         {},
    entry:              {},
    commitment:         commitmentToYellowstone(commitment),
    accountsDataSlice:  [],
    ping:               undefined,
  };

  if (fromSlot !== undefined) {
    req.fromSlot = String(fromSlot);
  }

  return req;
}

// pingRequest returns the keepalive frame that must be sent every 30s.
// The frame must include all empty subscription maps alongside the ping field
// or some providers will treat it as a malformed subscription update.
export function pingRequest(id: number): Record<string, unknown> {
  return {
    ping:               { id },
    slots:              {},
    accounts:           {},
    transactions:       {},
    transactionsStatus: {},
    blocks:             {},
    blocksMeta:         {},
    entry:              {},
    accountsDataSlice:  [],
  };
}

export function numericToSlotStatus(n: number): "processed" | "confirmed" | "finalized" | "dead" {
  switch (n) {
    case YS_FINALIZED: return "finalized";
    case YS_CONFIRMED: return "confirmed";
    case YS_DEAD:      return "dead";
    default:           return "processed";
  }
}