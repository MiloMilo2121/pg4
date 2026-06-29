import { request } from 'undici';
import type { HttpFetchResult, HttpProvider } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';

/**
 * Tier 0 HTTP fetcher. Uses undici directly. Returns 200..399 with html on
 * success; otherwise sets `error`. Always cost 0.
 */
export class DirectFetchProvider implements HttpProvider {
  readonly id = 'direct_fetch';
  readonly family = 'http' as const;
  readonly tier = 0;
  readonly costPerCallEur = 0;

  available(): boolean {
    return true;
  }

  async fetch(url: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HttpFetchResult> {
    const start = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULTS.pipeline.requestTimeoutMs;
    try {
      const res = await request(url, {
        method: 'GET',
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        maxRedirections: 5,
        signal: opts.signal,
        headers: {
          'user-agent': DEFAULTS.http.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
        },
      });

      const ct = `${res.headers['content-type'] ?? ''}`;
      let html: string | undefined;
      if (ct.includes('text/') || ct.includes('html') || ct.includes('xml') || ct === '') {
        html = await res.body.text();
      } else {
        await res.body.dump();
      }

      return {
        status: res.statusCode,
        html,
        finalUrl: url,
        duration_ms: Date.now() - start,
        cost_eur: 0,
        provider: this.id,
      };
    } catch (e) {
      return {
        status: 0,
        html: undefined,
        finalUrl: url,
        duration_ms: Date.now() - start,
        cost_eur: 0,
        provider: this.id,
        error: (e as Error).message,
      };
    }
  }
}
