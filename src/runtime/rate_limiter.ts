/**
 * Per-key token bucket. Used to space out calls to a single provider
 * (e.g. Serper free tier limits, PG anti-WAF spacing).
 */

interface Bucket {
  tokens: number;
  lastRefillTs: number;
  refillRatePerSec: number;
  capacity: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  configure(key: string, ratePerSec: number, capacity?: number): void {
    this.buckets.set(key, {
      tokens: capacity ?? ratePerSec,
      lastRefillTs: Date.now(),
      refillRatePerSec: ratePerSec,
      capacity: capacity ?? ratePerSec,
    });
  }

  async acquire(key: string): Promise<void> {
    const bucket = this.buckets.get(key);
    if (!bucket) return; // unconfigured = unlimited
    while (true) {
      this.refill(bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      const waitMs = Math.max(50, Math.ceil((1 - bucket.tokens) / bucket.refillRatePerSec * 1000));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  private refill(bucket: Bucket): void {
    const now = Date.now();
    const elapsedSec = (now - bucket.lastRefillTs) / 1000;
    if (elapsedSec <= 0) return;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSec * bucket.refillRatePerSec);
    bucket.lastRefillTs = now;
  }
}
