import { LeaderWindow }       from "../types";
import { Logger }             from "../utils/logger";
import { JitoBundleClient }   from "./jito-bundle-client";
import { RateLimiter }        from "../utils/rate-limiter";

// LeaderWindowDetector
// Calls getNextScheduledLeader() through the JitoBundleClient interface to
// determine how many slots remain until the next Jito-connected leader.
//
// Results are cached for 2 seconds (the block engine itself updates leader
// schedules on that cadence). All calls go through a shared RateLimiter to
// avoid hammering the endpoint; the limiter is shared with the Jito client's
// own limiter by passing the same instance from the orchestrator.
//
// On failure (devnet, gRPC-only endpoints, network errors) the detector
// returns a neutral fallback window rather than throwing so the stack
// continues operating without leader data.

const CACHE_TTL_MS    = 2_000;
const FAIL_TTL_MS     = 500;

export class LeaderWindowDetector {
  private readonly jitoClient: JitoBundleClient;
  private readonly logger:     Logger;
  private readonly limiter:    RateLimiter;

  private lastWindow:  LeaderWindow | null = null;
  private lastFetchAt  = 0;
  private lastFailAt   = 0;

  constructor(jitoClient: JitoBundleClient, logger: Logger) {
    this.jitoClient = jitoClient;
    this.logger     = logger;
    this.limiter    = new RateLimiter(1_100);
  }

  async detect(currentSlot: number): Promise<LeaderWindow> {
    const now = Date.now();

    // Return cached success result within TTL
    if (this.lastWindow && now - this.lastFetchAt < CACHE_TTL_MS) {
      return this.lastWindow;
    }

    // Back off after a recent failure
    if (now - this.lastFailAt < FAIL_TTL_MS) {
      return this.neutralWindow(currentSlot);
    }

    return this.limiter.run(async () => {
      try {
        const info = await this.jitoClient.getNextScheduledLeader();

        const resolvedSlot = info.currentSlot > 0 ? info.currentSlot : currentSlot;
        const slotsUntil   = info.nextLeaderSlot > 0
          ? Math.max(0, info.nextLeaderSlot - resolvedSlot)
          : null;

        this.lastWindow = {
          observedAt:           new Date().toISOString(),
          currentSlot:          resolvedSlot,
          slotsUntilJitoLeader: slotsUntil,
          nextLeaderIdentity:   info.nextLeaderIdentity,
          isJitoLeaderWindow:   slotsUntil !== null && slotsUntil <= 4,
        };
        this.lastFetchAt = Date.now();

        await this.logger.debug("[leader] Window detected", {
          slotsUntil,
          isWindow:  this.lastWindow.isJitoLeaderWindow,
          identity:  info.nextLeaderIdentity?.slice(0, 8) ?? "unknown",
        });

        return this.lastWindow;
      } catch {
        this.lastFailAt = Date.now();
        return this.neutralWindow(currentSlot);
      }
    });
  }

  private neutralWindow(currentSlot: number): LeaderWindow {
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