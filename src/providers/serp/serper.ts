import { request } from 'undici';
import type { SerpProvider, SerpResult } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';
import { getEnv } from '../../config/env';

/**
 * Phase G — paid SERP via Serper.dev (Google-backed).
 *
 * Tier 2 / paid. Default cost €0.001/call (Serper Starter plan).
 * Off by default. Available only when:
 *   - `SERPER_ENABLED=true` in env
 *   - `SERPER_API_KEY` is set
 *
 * Endpoint: POST https://google.serper.dev/search
 * Auth:     header `X-API-KEY: <key>`
 * Body:     { q, gl: "it", hl: "it", num: 10 }
 *
 * The router-level paid gate (`paidEnabled`) and per-lead budget
 * gate are the load-bearing safeguards. This provider's
 * `available()` only reports availability; budget enforcement
 * happens in the router filter.
 *
 * Adapted from `pg3/src/enricher/core/discovery/search_provider.ts`
 * but rewritten for pg4's `SerpProvider` interface — no shared code
 * with pg3 to keep the pg4 surface clean.
 */
export class SerperProvider implements SerpProvider {
  readonly id = 'serper';
  readonly family = 'serp' as const;
  readonly tier = 2;
  readonly costPerCallEur = 0.001;

  available(): boolean {
    const env = getEnv();
    return env.SERPER_ENABLED === true && typeof env.SERPER_API_KEY === 'string' && env.SERPER_API_KEY.length > 0;
  }

  async search(query: string, opts: { signal?: AbortSignal; limit?: number } = {}): Promise<SerpResult[]> {
    if (!query.trim()) return [];
    const env = getEnv();
    const apiKey = env.SERPER_API_KEY;
    if (!apiKey) return []; // paranoia — `available()` should have prevented this
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 20);

    let res;
    try {
      res = await request('https://google.serper.dev/search', {
        method: 'POST',
        bodyTimeout: DEFAULTS.pipeline.requestTimeoutMs,
        headersTimeout: DEFAULTS.pipeline.requestTimeoutMs,
        signal: opts.signal,
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': DEFAULTS.http.userAgent,
        },
        body: JSON.stringify({ q: query, gl: 'it', hl: 'it', num: limit }),
      });
    } catch (err) {
      // Phase G.1 — re-throw network errors so the router classifies
      // them as transport / timeout and the breaker sees them.
      // Returning [] would have been silently treated as `empty`.
      throw err;
    }

    // 401/403 are config errors — auth invalid. Don't loop. Throw a
    // ProviderBlockError so the breaker treats it as `blocked`, not
    // a transient transport failure.
    if (res.statusCode === 401 || res.statusCode === 403) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, `serper auth failure (${res.statusCode})`);
    }
    // 429 — rate limit. Surface as block; router will record as blocked.
    if (res.statusCode === 429) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, 'serper rate limit (429)');
    }
    // Phase G.1 — 5xx upstream is a real failure, NOT empty. Throw an
    // Error whose message starts with the status so `classifyThrown`
    // routes it to `transport`, the breaker sees it, and the ledger
    // does not silently mark it as `empty success`.
    if (res.statusCode >= 500) {
      await res.body.dump();
      throw new Error(`serper upstream ${res.statusCode}`);
    }
    // Other 4xx — caller-side issue (malformed query etc.). Surface
    // as `other` failure.
    if (res.statusCode < 200 || res.statusCode >= 400) {
      await res.body.dump();
      throw new Error(`serper http ${res.statusCode}`);
    }

    let json: unknown;
    try {
      json = await res.body.json();
    } catch (err) {
      // Body was 200 but unparseable — surface as transport.
      throw new Error(`serper json parse: ${(err as Error).message}`);
    }

    // Empty `organic` on a 200 IS a legitimate empty (zero matches),
    // not a failure. Router will record `kind: empty`, breaker
    // recordsSuccess.
    return SerperProvider.parseOrganic(json, limit, this.id);
  }

  /** Pure parser, exposed for unit tests. */
  static parseOrganic(json: unknown, limit: number, sourceId: string): SerpResult[] {
    if (!json || typeof json !== 'object') return [];
    const organic = (json as { organic?: unknown }).organic;
    if (!Array.isArray(organic)) return [];
    const out: SerpResult[] = [];
    for (let i = 0; i < organic.length && out.length < limit; i++) {
      const r = organic[i];
      if (!r || typeof r !== 'object') continue;
      const url = typeof (r as { link?: unknown }).link === 'string' ? (r as { link: string }).link : '';
      const title = typeof (r as { title?: unknown }).title === 'string' ? (r as { title: string }).title : '';
      const snippet = typeof (r as { snippet?: unknown }).snippet === 'string' ? (r as { snippet: string }).snippet : '';
      if (!url || !title) continue;
      out.push({
        title: title.trim(),
        url: url.trim(),
        snippet: snippet.trim(),
        rank: i + 1,
        source_provider: sourceId,
      });
    }
    return out;
  }
}
