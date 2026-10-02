import { DirectFetchProvider } from '../../providers/http/direct_fetch';
import { followRedirects } from '../../providers/http/follow_redirects';
import { assertPublicLiteralHost, publicInternetAgent } from '../../providers/http/ssrf_guard';
import type { PageFetcher } from './source_harvest';

const DIRECT = new DirectFetchProvider();

/** A JSON API answer larger than this is not one we asked for. */
const MAX_POST_BODY_BYTES = 5_000_000;

/**
 * The harvest PageFetcher used by both the CLI/eval context and the dev server.
 * GET → direct_fetch (tier 0, free). POST (with headers/body) is required by the
 * New Google Places API (POST places:searchText with X-Goog-FieldMask). Both go
 * through the SSRF guard: IP-literal hosts checked on every hop, resolved
 * addresses checked at connect time. Other methods are refused. Any failure →
 * undefined, which the harvest layer reads as `ok:false` → `unknown` (never
 * fabricated absence).
 */
export function buildPageFetcher(timeoutMs = 8000): PageFetcher {
  return async (url, init) => {
    try {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return (await DIRECT.fetch(url, { timeoutMs })).html;
      if (method !== 'POST') return undefined;
      const { response: res } = await followRedirects(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) },
        body: init?.body,
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        // Idle timeouts never fire on a server dripping bytes; bound the whole exchange.
        signal: AbortSignal.timeout(timeoutMs * 2),
        dispatcher: publicInternetAgent,
        assertHop: assertPublicLiteralHost,
      });
      const declared = Number(res.headers['content-length'] ?? 0);
      if (res.statusCode < 200 || res.statusCode >= 400 || declared > MAX_POST_BODY_BYTES) {
        await res.body.dump();
        return undefined;
      }
      return await res.body.text();
    } catch {
      return undefined;
    }
  };
}
