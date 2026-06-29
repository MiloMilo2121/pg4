import { request } from 'undici';
import type { HttpFetchResult, HttpProvider, ProviderRole } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';
import { getEnv } from '../../config/env';

/**
 * Firecrawl — WEB_FETCH / WEB_UNBLOCK escalation. Renders JS-heavy / blocked pages
 * that `direct_fetch` (tier 0) cannot. Tier 2 / paid, OFF by default; only reached
 * AFTER direct_fetch returns a block/empty (the role cascade order enforces that).
 *
 * Endpoint: POST {FIRECRAWL_BASE_URL}/v2/scrape  body { url, formats:['html'] }.
 * Spec: docs/provider_integration_specs.md#Firecrawl (v2; do NOT use bare host / v1).
 */
export class FirecrawlProvider implements HttpProvider {
  readonly id = 'firecrawl';
  readonly family = 'http' as const;
  readonly tier = 2;
  readonly costPerCallEur = 0.0046;
  readonly roles: ReadonlyArray<ProviderRole> = ['WEB_FETCH', 'WEB_UNBLOCK'];

  available(): boolean {
    const e = getEnv();
    return e.FIRECRAWL_ENABLED === true && typeof e.FIRECRAWL_API_KEY === 'string' && e.FIRECRAWL_API_KEY.length > 0;
  }

  async fetch(url: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HttpFetchResult> {
    const start = Date.now();
    const e = getEnv();
    const apiKey = e.FIRECRAWL_API_KEY;
    if (!apiKey) throw new ProviderBlockError(this.id, 'firecrawl key missing');
    const timeoutMs = (opts.timeoutMs ?? DEFAULTS.pipeline.requestTimeoutMs) * 3; // render is slower
    const endpoint = `${e.FIRECRAWL_BASE_URL.replace(/\/$/, '')}/v2/scrape`;

    const res = await request(endpoint, {
      method: 'POST',
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      signal: opts.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': DEFAULTS.http.userAgent,
      },
      body: JSON.stringify({ url, formats: ['html'], onlyMainContent: false }),
    });

    if (res.statusCode === 401 || res.statusCode === 403) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, `firecrawl auth failure (${res.statusCode})`);
    }
    if (res.statusCode === 429) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, 'firecrawl rate limit (429)');
    }
    if (res.statusCode < 200 || res.statusCode >= 400) {
      await res.body.dump();
      return { status: res.statusCode, html: undefined, finalUrl: url, duration_ms: Date.now() - start, cost_eur: 0, provider: this.id, error: `firecrawl http ${res.statusCode}` };
    }

    let json: unknown;
    try {
      json = await res.body.json();
    } catch (err) {
      return { status: 0, html: undefined, finalUrl: url, duration_ms: Date.now() - start, cost_eur: this.costPerCallEur, provider: this.id, error: `firecrawl json parse: ${(err as Error).message}` };
    }
    const html = FirecrawlProvider.extractHtml(json);
    return {
      status: html ? 200 : 204,
      html,
      finalUrl: FirecrawlProvider.extractFinalUrl(json) ?? url,
      duration_ms: Date.now() - start,
      cost_eur: this.costPerCallEur,
      provider: this.id,
      error: html ? undefined : 'firecrawl returned no html',
    };
  }

  /** Pure parser: v2 returns { success, data: { html, metadata } }. Exposed for tests. */
  static extractHtml(json: unknown): string | undefined {
    if (!json || typeof json !== 'object') return undefined;
    const data = (json as { data?: { html?: unknown } }).data;
    const html = data?.html;
    return typeof html === 'string' && html.length > 0 ? html : undefined;
  }

  static extractFinalUrl(json: unknown): string | undefined {
    if (!json || typeof json !== 'object') return undefined;
    const md = (json as { data?: { metadata?: { sourceURL?: unknown; url?: unknown } } }).data?.metadata;
    const u = md?.sourceURL ?? md?.url;
    return typeof u === 'string' ? u : undefined;
  }
}
