import { request } from 'undici';
import type { HttpFetchResult, HttpProvider } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';
import { fingerprintFor } from '../../runtime/fingerprint';

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
      // undici's body/headers timeouts are IDLE timeouts (time between chunks):
      // a tarpit dripping 1 byte/s never trips them and pins a pool slot for
      // hours on a national run. The wall-clock deadline (2× the idle timeout)
      // bounds the whole exchange.
      const deadline = AbortSignal.timeout(timeoutMs * 2);
      // Realistic per-host browser fingerprint (UA + coherent client hints):
      // the old declared-bot UA made some sites serve a stripped page. Seeded
      // by hostname → deterministic (fixture-safe), one identity per host.
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        host = url;
      }
      const res = await request(url, {
        method: 'GET',
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        maxRedirections: 5,
        signal: opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline,
        headers: fingerprintFor(host).headers,
      });

      // A declared multi-hundred-MB "page" is never a page we want in memory.
      const contentLength = Number(res.headers['content-length'] ?? 0);
      if (contentLength > 10_000_000) {
        await res.body.dump();
        return {
          status: res.statusCode,
          html: undefined,
          finalUrl: url,
          duration_ms: Date.now() - start,
          cost_eur: 0,
          provider: this.id,
          error: `body too large (${contentLength} bytes)`,
        };
      }

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
