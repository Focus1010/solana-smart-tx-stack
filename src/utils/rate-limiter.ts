// RateLimiter
// Serializes concurrent calls and enforces a minimum wall-clock interval
// between the start of consecutive invocations. Concurrent callers queue
// behind the active call; each waits for the previous to finish before it
// can start, and the minimum interval is measured from when the previous
// call *began*, not when it ended.
//
// Usage:
//   const limiter = new RateLimiter(1_100);
//   const result  = await limiter.run(() => someRpcCall());

export class RateLimiter {
  private readonly minIntervalMs: number;
  private lastStartMs = 0;
  private queue: Array<() => void> = [];
  private busy = false;

  constructor(minIntervalMs: number) {
    this.minIntervalMs = minIntervalMs;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Serialize: wait for any currently running call to release the lock
    await this.acquireLock();

    const now     = Date.now();
    const elapsed = now - this.lastStartMs;
    const wait    = Math.max(0, this.minIntervalMs - elapsed);

    if (wait > 0) {
      await sleep(wait);
    }

    this.lastStartMs = Date.now();

    try {
      return await fn();
    } finally {
      this.releaseLock();
    }
  }

  private acquireLock(): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private releaseLock(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.busy = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}