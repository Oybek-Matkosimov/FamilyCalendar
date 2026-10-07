export interface Limiter {
  /** Returns true if the call is allowed (and consumes a token). */
  take(key: string): boolean;
  reset(): void;
}

/**
 * In-memory token bucket. Per-process: with several instances each enforces its own budget, which is fine as a
 * coarse abuse guard. Credential guessing is limited separately and durably by the auth_attempts table.
 */
export function createLimiter(opts: { capacity: number; refillPerSec: number; now?: () => number }): Limiter {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { tokens: number; updated: number }>();
  return {
    take(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size > 10000) {
          for (const [k, v] of buckets) if (t - v.updated > 120000) buckets.delete(k);
        }
        b = { tokens: opts.capacity, updated: t };
        buckets.set(key, b);
      }
      b.tokens = Math.min(opts.capacity, b.tokens + ((t - b.updated) / 1000) * opts.refillPerSec);
      b.updated = t;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
    reset() {
      buckets.clear();
    },
  };
}
