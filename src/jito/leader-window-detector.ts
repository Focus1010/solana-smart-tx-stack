import { JitoJsonRpcClient } from "jito-js-rpc";
import { LeaderWindow }      from "../types";
import { Logger }            from "../utils/logger";
import { config }            from "../config";

// ─── LeaderWindowDetector ─────────────────────────────────────────────────────
// Calls getNextScheduledLeader() on the Jito block engine to find out how many
// slots remain until the next Jito-connected leader. This feeds the agent's
// timing decision: inside a window means submit now, far away means hold or
// adjust tip to account for leader urgency multiplier.

export class LeaderWindowDetector {
  private jitoClient:  JitoJsonRpcClient;
  private logger:      Logger;
  private lastWindow:  LeaderWindow | null = null;
  private lastFetchAt  = 0;
  private readonly CACHE_TTL_MS = 2_000;

  constructor(logger: Logger) {
    this.logger     = logger;
    this.jitoClient = new JitoJsonRpcClient(config.jito.rpcUrl, "");
  }

  async detect(currentSlot: number): Promise<LeaderWindow> {
    if (this.lastWindow && Date.now() - this.lastFetchAt < this.CACHE_TTL_MS) {
      return this.lastWindow;
    }

    try {
      const resp = await (this.jitoClient as any)["sendRequest"]("getNextScheduledLeader", []);

      if (resp?.result) {
        const r               = resp.result as any;
        const currentFromResp = Number(r.currentSlot  ?? currentSlot);
        const nextLeaderSlot  = Number(r.nextLeaderSlot ?? 0);
        const slotsUntil      = nextLeaderSlot > 0
          ? Math.max(0, nextLeaderSlot - currentFromResp)
          : null;

        this.lastWindow = {
          observedAt:           new Date().toISOString(),
          currentSlot:          currentFromResp,
          slotsUntilJitoLeader: slotsUntil,
          nextLeaderIdentity:   r.nextLeaderIdentity ?? null,
          isJitoLeaderWindow:   slotsUntil !== null && slotsUntil <= 4,
        };
        this.lastFetchAt = Date.now();

        await this.logger.debug("[leader] Window detected", {
          slotsUntil,
          isWindow:  this.lastWindow.isJitoLeaderWindow,
          identity:  (r.nextLeaderIdentity as string | undefined)?.slice(0, 8) ?? "unknown",
        });

        return this.lastWindow;
      }
    } catch {
      // getNextScheduledLeader is gRPC-only on Jito and unavailable on devnet.
      // Silently fall through to the neutral fallback so the stack keeps running.
    }

    this.lastWindow = {
      observedAt:           new Date().toISOString(),
      currentSlot,
      slotsUntilJitoLeader: null,
      nextLeaderIdentity:   null,
      isJitoLeaderWindow:   false,
    };
    this.lastFetchAt = Date.now();
    return this.lastWindow;
  }
}
