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
//
// 429 / backoff:
//   const result  = await limiter.runWithBackoff(() => someRpcCall());
//   runWithBackoff automatically retries on 429 HTTP errors with exponential
//   backoff + jitter (500ms * 2^n + jitter, max 10 000 ms, up to 4 retries).

const BACKOFF_BASE_MS   = 500;
const BACKOFF_MAX_MS    = 10_000;
const BACKOFF_MAX_RETRY = 4;

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

  // runWithBackoff wraps run() with exponential backoff + jitter on 429 errors.
  // Non-429 errors are re-thrown immediately after the first attempt.
  // On 429 the call is retried up to BACKOFF_MAX_RETRY times with:
  //   delay = min(BACKOFF_BASE_MS * 2^attempt + jitter, BACKOFF_MAX_MS)
  // where jitter = random value in [0, 500).
  async runWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await this.run(fn);
      } catch (err) {
        const is429 = this.is429Error(err);

        if (!is429 || attempt >= BACKOFF_MAX_RETRY) {
          throw err;
        }

        const jitter  = Math.floor(Math.random() * 500);
        const delay   = Math.min(
          BACKOFF_BASE_MS * Math.pow(2, attempt) + jitter,
          BACKOFF_MAX_MS
        );

        await sleep(delay);
        attempt++;
      }
    }
  }

  private is429Error(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("too many requests")
    );
  }

  private acquireLock(): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      // When the queued resolver is invoked, mark busy=true before resolving
      // so the caller proceeds with the lock held.
      this.queue.push(() => {
        this.busy = true;
        resolve();
      });
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