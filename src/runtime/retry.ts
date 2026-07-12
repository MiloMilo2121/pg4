import { setTimeout as wait } from 'timers/promises';
import { DEFAULTS } from '../config/defaults';

/**
 * Retry-with-backoff per operazioni di navigazione fragili (Playwright).
 *
 * Motivazione (post-mortem campagne Veneto): il 99% dei fallimenti NON erano
 * blocchi anti-bot ma cadute di rete del client — 3.626 `net::ERR_INTERNET_
 * DISCONNECTED` / `ERR_NETWORK_CHANGED` / `ERR_NAME_NOT_RESOLVED` (laptop in
 * movimento: sospensione + wifi che salta). Un singolo `page.goto` fallito
 * perdeva la pagina/comune o uccideva l'intero run. `withRetry` riprova la
 * stessa operazione con backoff esponenziale finché la rete non rientra,
 * rispettando l'abort cooperativo.
 */

/** Errori transitori di rete/navigazione che vale la pena ritentare. */
const RETRIABLE_RE =
  /net::ERR_|ERR_NETWORK|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|Timeout.*exceeded|Navigation timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|Target closed|frame was detached/i;

export function isRetriableNavError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRIABLE_RE.test(msg);
}

export interface RetryOptions {
  /** Tentativi EXTRA dopo il primo (default 3 → fino a 4 esecuzioni). */
  retries?: number;
  /** Backoff base ms; raddoppia a ogni tentativo. Default = interPageDelayMs. */
  baseBackoffMs?: number;
  /** Cap del backoff. Default 30s. */
  maxBackoffMs?: number;
  /** Jitter frazionario ±; applicato solo se baseBackoffMs > 0. Default 0.2. */
  jitter?: number;
  /** Abort cooperativo: se abortito, non ritenta e propaga. */
  abortSignal?: AbortSignal;
  /** Predicato di ritentabilità. Default: errori di rete/navigazione. */
  isRetriable?: (err: unknown) => boolean;
  /** Notifica ogni retry (per logging/telemetria). */
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
}

class AbortedError extends Error {
  constructor() {
    super('withRetry: aborted');
    this.name = 'AbortedError';
  }
}

/**
 * Esegue `fn` con retry+backoff. `fn` riceve il numero di tentativo (0-based).
 * Rilancia l'ultimo errore quando i tentativi si esauriscono o l'errore non è
 * ritentabile o l'abortSignal scatta.
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
