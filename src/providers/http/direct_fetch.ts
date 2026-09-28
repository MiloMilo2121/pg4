import { request, type Dispatcher } from 'undici';
import type { HttpFetchResult, HttpProvider } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';
import { fingerprintFor } from '../../runtime/fingerprint';
import { assertPublicLiteralHost, publicInternetAgent } from './ssrf_guard';

/** A page larger than this is never something we want in memory. */
const MAX_BODY_BYTES = 10_000_000;

/**
 * Tier 0 HTTP fetcher. Uses undici directly. Returns 200..399 with html on
 * success; otherwise sets `error`. Always cost 0.
 *
 * URLs come from scraped data, so by default every hop goes through the SSRF
 * guard (no loopback / private / link-local / metadata destinations) and the
 * body is capped at 10 MB even when the server sends no content-length.
 */
export class DirectFetchProvider implements HttpProvider {
  readonly id = 'direct_fetch';
  readonly family = 'http' as const;
  readonly tier = 0;
  readonly costPerCallEur = 0;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly allowPrivateNetwork: boolean;

  /** `allowPrivateNetwork` exists for tests against a local server only. */
  constructor(opts: { dispatcher?: Dispatcher; allowPrivateNetwork?: boolean } = {}) {
    this.allowPrivateNetwork = opts.allowPrivateNetwork === true;
    this.dispatcher = opts.dispatcher ?? (this.allowPrivateNetwork ? undefined : publicInternetAgent);
  }

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
      // Redirects are followed MANUALLY (≤5 hops): undici's `maxRedirections`
      // option throws "not supported, use the redirect interceptor" on the
      // redirect path under current undici/Node — which silently killed every
      // http→https 301 site (measured: an entire pass classified "dead").
      // Realistic per-host browser fingerprint (UA + coherent client hints):
      // the old declared-bot UA made some sites serve a stripped page. Seeded
      // by hostname → deterministic (fixture-safe), one identity per host —
      // recomputed per hop because a redirect can change host.
      let currentUrl = url;
      let res: Awaited<ReturnType<typeof request>>;
      let hops = 0;
      for (;;) {
        let host: string;
        try {
          host = new URL(currentUrl).hostname;
        } catch {
          host = currentUrl;
        }
        if (!this.allowPrivateNetwork) assertPublicLiteralHost(currentUrl);
        res = await request(currentUrl, {
          dispatcher: this.dispatcher,
          method: 'GET',
          bodyTimeout: timeoutMs,
          headersTimeout: timeoutMs,
          signal: opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline,
          headers: fingerprintFor(host).headers,
        });
        const loc = res.headers.location;
        const location = Array.isArray(loc) ? loc[0] : loc;
        if (res.statusCode >= 300 && res.statusCode < 400 && location && hops < 5) {
          await res.body.dump();
          try {
            currentUrl = new URL(location, currentUrl).toString();
          } catch {
            break; // unparseable Location — surface the 3xx as-is
          }
          hops += 1;
          continue;
        }
        break;
      }

      // A declared multi-hundred-MB "page" is never a page we want in memory.
      const contentLength = Number(res.headers['content-length'] ?? 0);
      if (contentLength > MAX_BODY_BYTES) {
        await res.body.dump();
        return {
          status: res.statusCode,
          html: undefined,
          finalUrl: currentUrl,
          duration_ms: Date.now() - start,
          cost_eur: 0,
          provider: this.id,
          error: `body too large (${contentLength} bytes)`,
        };
      }

      const ct = `${res.headers['content-type'] ?? ''}`;
      let html: string | undefined;
      if (ct.includes('text/') || ct.includes('html') || ct.includes('xml') || ct === '') {
        html = await readTextCapped(res.body, MAX_BODY_BYTES);
        if (html === undefined) {
          return {
            status: res.statusCode,
            html: undefined,
            finalUrl: currentUrl,
            duration_ms: Date.now() - start,
            cost_eur: 0,
            provider: this.id,
            error: `body too large (> ${MAX_BODY_BYTES} bytes, no content-length)`,
          };
        }
      } else {
        await res.body.dump();
      }

      return {
        status: res.statusCode,
        html,
        finalUrl: currentUrl,
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

/** Read a body as UTF-8 text, giving up (undefined) past `maxBytes` — undeclared sizes can be unbounded. */
async function readTextCapped(body: Dispatcher.ResponseData['body'], maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      body.destroy();
      return undefined;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
