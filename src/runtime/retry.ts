import { setTimeout as wait } from 'timers/promises';
import { DEFAULTS } from '../config/defaults';

/**
 * Retry-with-backoff for fragile navigation operations (Playwright).
 *
 * Rationale (Veneto campaigns post-mortem): 99% of failures were NOT
 * anti-bot blocks but client-side network drops — 3,626 `net::ERR_INTERNET_
 * DISCONNECTED` / `ERR_NETWORK_CHANGED` / `ERR_NAME_NOT_RESOLVED` (laptop on
 * the move: sleep + flaky wifi). A single failed `page.goto` would
 * lose the page/comune or kill the whole run. `withRetry` retries the
 * same operation with exponential backoff until the network comes back,
 * honoring cooperative abort.
 */

/** Transient network/navigation errors worth retrying. */
const RETRIABLE_RE =
  /net::ERR_|ERR_NETWORK|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|Timeout.*exceeded|Navigation timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|Target closed|frame was detached/i;

export function isRetriableNavError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRIABLE_RE.test(msg);
}

export interface RetryOptions {
  /** EXTRA attempts after the first (default 3 → up to 4 executions). */
  retries?: number;
  /** Base backoff in ms; doubles on every attempt. Default = interPageDelayMs. */
  baseBackoffMs?: number;
  /** Backoff cap. Default 30s. */
  maxBackoffMs?: number;
  /** Fractional ± jitter; applied only if baseBackoffMs > 0. Default 0.2. */
  jitter?: number;
  /** Cooperative abort: if aborted, does not retry and propagates. */
  abortSignal?: AbortSignal;
  /** Retriability predicate. Default: network/navigation errors. */
  isRetriable?: (err: unknown) => boolean;
  /** Notified on every retry (for logging/telemetry). */
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
}

class AbortedError extends Error {
  constructor() {
    super('withRetry: aborted');
    this.name = 'AbortedError';
  }
}

/**
 * Runs `fn` with retry+backoff. `fn` receives the attempt number (0-based).
 * Rethrows the last error when attempts are exhausted, the error is not
 * retriable, or the abortSignal fires.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseBackoffMs ?? DEFAULTS.scraper.interPageDelayMs;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  const jitter = opts.jitter ?? 0.2;
  const isRetriable = opts.isRetriable ?? isRetriableNavError;

  let attempt = 0;
  for (;;) {
    if (opts.abortSignal?.aborted) throw new AbortedError();
    try {
      return await fn(attempt);
    } catch (err) {
      attempt += 1;
      if (attempt > retries || opts.abortSignal?.aborted || !isRetriable(err)) throw err;
      let delay = Math.min(maxBackoff, base * 2 ** (attempt - 1));
      if (base > 0 && jitter > 0) {
        delay = Math.round(delay * (1 + (Math.random() * 2 - 1) * jitter));
      }
      opts.onRetry?.({ attempt, delayMs: delay, err });
      if (delay > 0) await wait(delay);
    }
  }
}
