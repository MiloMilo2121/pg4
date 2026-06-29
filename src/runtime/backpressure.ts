/**
 * Concurrency limiter that throttles down when the recent error rate spikes.
 * Lifted in spirit from pg3's BackpressureValve, simplified and stateless
 * across runs.
 */

import { logger } from './logger';

export interface BackpressureOpts {
  initialConcurrency: number;
  maxConcurrency: number;
  minConcurrency?: number;
  errorRateWindow?: number;
  errorRateCeiling?: number;
}

interface OutcomeSample {
  ts: number;
  ok: boolean;
}

export class Backpressure {
  private current: number;
  private inFlight = 0;
  private queue: Array<() => void> = [];
  private samples: OutcomeSample[] = [];
  private readonly opts: Required<BackpressureOpts>;

  constructor(opts: BackpressureOpts) {
    this.opts = {
      minConcurrency: 1,
      errorRateWindow: 5 * 60 * 1000,
      errorRateCeiling: 0.4,
      ...opts,
    };
    this.current = opts.initialConcurrency;
  }

  async run<T>(fn: () => Promise<T>, priority = 1): Promise<T> {
    void priority; // priority is reserved for future scheduling
    await this.acquire();
    try {
      const out = await fn();
      this.recordOutcome(true);
      return out;
    } catch (e) {
      this.recordOutcome(false);
      throw e;
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.current) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inFlight += 1;
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  private recordOutcome(ok: boolean): void {
    const now = Date.now();
    this.samples.push({ ts: now, ok });
    const cutoff = now - this.opts.errorRateWindow;
    while (this.samples.length > 0 && this.samples[0].ts < cutoff) this.samples.shift();
    this.adjust();
  }

  private adjust(): void {
    if (this.samples.length < 10) return;
    const errors = this.samples.filter((s) => !s.ok).length;
    const rate = errors / this.samples.length;
    if (rate > this.opts.errorRateCeiling && this.current > this.opts.minConcurrency) {
      this.current = Math.max(this.opts.minConcurrency, Math.floor(this.current / 2));
      logger.warn({ rate, concurrency: this.current }, '[Backpressure] error rate high — throttling down');
    } else if (rate < this.opts.errorRateCeiling / 2 && this.current < this.opts.maxConcurrency) {
      this.current = Math.min(this.opts.maxConcurrency, this.current + 1);
    }
  }

  getMetrics() {
    return {
      current_concurrency: this.current,
      max_concurrency: this.opts.maxConcurrency,
      in_flight: this.inFlight,
      queue_depth: this.queue.length,
      sample_count: this.samples.length,
      error_rate_window:
        this.samples.length === 0 ? 0 : this.samples.filter((s) => !s.ok).length / this.samples.length,
    };
  }
}
