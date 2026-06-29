import { request } from 'undici';
import type { HttpFetchResult, HttpProvider, ProviderRole } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';
import { getEnv } from '../../config/env';

/**
 * Bright Data Web Unlocker — last-resort WEB_FETCH / WEB_UNBLOCK for hard targets
 * (residential IP + JS render + anti-bot bypass). Distinct id `brightdata_unlocker`
 * (addendum R2: NOT shared with the SERP zone, to keep breaker/rate keyspaces apart).
 * Tier 2 / paid ("pay only for success", ~$1.50/1k), OFF by default.
 *
 * Endpoint: POST https://api.brightdata.com/request  body { zone, url, format:'raw' }.
 * Auth: Bearer BRIGHTDATA_API_TOKEN. Zone in BODY (BRIGHTDATA_WEB_UNLOCKER_ZONE).
 * Spec: docs/provider_integration_specs.md#Bright Data.
 */
export class BrightDataUnlockerProvider implements HttpProvider {
  readonly id = 'brightdata_unlocker';
  readonly family = 'http' as const;
  readonly tier = 2;
  readonly costPerCallEur = 0.00138;
  readonly roles: ReadonlyArray<ProviderRole> = ['WEB_FETCH', 'WEB_UNBLOCK'];

  available(): boolean {
    const e = getEnv();
    const token = e.BRIGHTDATA_API_TOKEN ?? e.BRIGHTDATA_API_KEY;
    return (
      e.BRIGHTDATA_ENABLED === true &&
      typeof token === 'string' &&
      token.length > 0 &&
      typeof e.BRIGHTDATA_WEB_UNLOCKER_ZONE === 'string' &&
      e.BRIGHTDATA_WEB_UNLOCKER_ZONE.length > 0
    );
  }

  async fetch(url: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<HttpFetchResult> {
    const start = Date.now();
    const e = getEnv();
    const token = e.BRIGHTDATA_API_TOKEN ?? e.BRIGHTDATA_API_KEY;
    const zone = e.BRIGHTDATA_WEB_UNLOCKER_ZONE;
    if (!token || !zone) throw new ProviderBlockError(this.id, 'brightdata token/zone missing');
    const timeoutMs = (opts.timeoutMs ?? DEFAULTS.pipeline.requestTimeoutMs) * 3;

    const res = await request('https://api.brightdata.com/request', {
      method: 'POST',
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      signal: opts.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: '*/*',
        'user-agent': DEFAULTS.http.userAgent,
      },
      body: JSON.stringify({ zone, url, format: 'raw' }),
    });

    if (res.statusCode === 401 || res.statusCode === 403) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, `brightdata auth failure (${res.statusCode})`);
    }
    if (res.statusCode === 429) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, 'brightdata rate limit (429)');
    }
    if (res.statusCode < 200 || res.statusCode >= 400) {
      await res.body.dump();
      return { status: res.statusCode, html: undefined, finalUrl: url, duration_ms: Date.now() - start, cost_eur: 0, provider: this.id, error: `brightdata http ${res.statusCode}` };
    }

    // format:'raw' returns the target page body directly.
    const html = await res.body.text();
    const ok = typeof html === 'string' && html.length > 0;
    return {
      status: ok ? 200 : 204,
      html: ok ? html : undefined,
      finalUrl: url,
      duration_ms: Date.now() - start,
      cost_eur: this.costPerCallEur,
      provider: this.id,
      error: ok ? undefined : 'brightdata returned empty body',
    };
  }
}
