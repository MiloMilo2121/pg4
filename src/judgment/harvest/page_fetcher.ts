import { request } from 'undici';
import { DirectFetchProvider } from '../../providers/http/direct_fetch';
import type { PageFetcher } from './source_harvest';

const DIRECT = new DirectFetchProvider();

/**
 * The harvest PageFetcher used by both the CLI/eval context and the dev server.
 * GET → direct_fetch (tier 0, free). A non-GET `init` (POST + headers/body) goes
 * straight through undici — required by the New Google Places API
 * (POST places:searchText with X-Goog-FieldMask). Any failure → undefined, which
 * the harvest layer reads as `ok:false` → `unknown` (never fabricated absence).
 */
export function buildPageFetcher(timeoutMs = 8000): PageFetcher {
  return async (url, init) => {
    try {
      if (init?.method && init.method.toUpperCase() !== 'GET') {
        const res = await request(url, {
          method: init.method as 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
          body: init.body,
          bodyTimeout: timeoutMs,
          headersTimeout: timeoutMs,
        });
        if (res.statusCode < 200 || res.statusCode >= 400) {
          await res.body.dump();
          return undefined;
        }
        return await res.body.text();
      }
      return (await DIRECT.fetch(url, { timeoutMs })).html;
    } catch {
      return undefined;
    }
  };
}
