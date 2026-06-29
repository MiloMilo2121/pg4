import { request } from 'undici';
import type { SerpProvider, SerpResult } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';
import { getEnv } from '../../config/env';

/**
 * Exa — paid neural SERP fallback for discovery. Tier 2 / paid, OFF by default.
 * Endpoint: POST https://api.exa.ai/search  header `x-api-key`.
 */
export class ExaProvider implements SerpProvider {
  readonly id = 'exa';
  readonly family = 'serp' as const;
  readonly tier = 2;
  readonly costPerCallEur = 0.005;

  available(): boolean {
    const e = getEnv();
    return e.EXA_ENABLED === true && typeof e.EXA_API_KEY === 'string' && e.EXA_API_KEY.length > 0;
  }

  async search(query: string, opts: { signal?: AbortSignal; limit?: number } = {}): Promise<SerpResult[]> {
    if (!query.trim()) return [];
    const e = getEnv();
    const apiKey = e.EXA_API_KEY;
    if (!apiKey) return [];
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 20);
    let res;
    try {
      res = await request('https://api.exa.ai/search', {
        method: 'POST',
        bodyTimeout: DEFAULTS.pipeline.requestTimeoutMs,
        headersTimeout: DEFAULTS.pipeline.requestTimeoutMs,
        signal: opts.signal,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json', 'user-agent': DEFAULTS.http.userAgent },
        body: JSON.stringify({ query, numResults: limit, type: 'auto' }),
      });
    } catch (err) {
      throw err;
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, `exa auth failure (${res.statusCode})`);
    }
    if (res.statusCode === 429) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, 'exa rate limit (429)');
    }
    if (res.statusCode < 200 || res.statusCode >= 400) {
      await res.body.dump();
      throw new Error(`exa http ${res.statusCode}`);
    }
    let json: unknown;
    try {
      json = await res.body.json();
    } catch (err) {
      throw new Error(`exa json parse: ${(err as Error).message}`);
    }
    return ExaProvider.parse(json, limit, this.id);
  }

  /** Pure parser, exposed for tests. */
  static parse(json: unknown, limit: number, sourceId: string): SerpResult[] {
    if (!json || typeof json !== 'object') return [];
    const results = (json as { results?: unknown }).results;
    if (!Array.isArray(results)) return [];
    const out: SerpResult[] = [];
    for (let i = 0; i < results.length && out.length < limit; i++) {
      const r = results[i] as Record<string, unknown>;
      const url = typeof r.url === 'string' ? r.url : '';
      const title = typeof r.title === 'string' ? r.title : '';
      const snippet = typeof r.text === 'string' ? r.text.slice(0, 300) : typeof r.snippet === 'string' ? r.snippet : '';
      if (!url || !title) continue;
      out.push({ title: title.trim(), url: url.trim(), snippet: snippet.trim(), rank: i + 1, source_provider: sourceId });
    }
    return out;
  }
}
