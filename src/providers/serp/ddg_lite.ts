import { request } from 'undici';
import * as cheerio from 'cheerio';
import type { SerpProvider, SerpResult } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';

/**
 * Tier 1 SERP via DuckDuckGo Lite HTML. No JS, fast, no API key, but
 * lightly rate-limited and occasionally serves a captcha block page.
 *
 * Returns up to 25 results. Block detection: title contains common DDG
 * blocking phrases.
 */
export class DdgLiteProvider implements SerpProvider {
  readonly id = 'ddg_lite';
  readonly family = 'serp' as const;
  readonly tier = 1;
  readonly costPerCallEur = 0;

  available(): boolean {
    // Always registered. Per-category routing (R14) decides whether this
    // low-yield provider is used — see src/providers/provider_policy.ts.
    return true;
  }

  async search(query: string, opts: { signal?: AbortSignal; limit?: number } = {}): Promise<SerpResult[]> {
    if (!query.trim()) return [];
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=it-it`;
    let html: string;
    try {
      const res = await request(url, {
        method: 'GET',
        bodyTimeout: DEFAULTS.pipeline.requestTimeoutMs,
        headersTimeout: DEFAULTS.pipeline.requestTimeoutMs,
        signal: opts.signal,
        headers: {
          'user-agent': DEFAULTS.http.userAgent,
          'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
          accept: 'text/html',
        },
      });
      if (res.statusCode !== 200) {
        await res.body.dump();
        return [];
      }
      html = await res.body.text();
    } catch {
      return [];
    }
    if (DdgLiteProvider.looksBlocked(html)) {
      throw new ProviderBlockError(this.id, 'DDG-lite served a block page');
    }
    return this.parse(html, opts.limit ?? 25);
  }

  /** Pure parser, exposed for unit tests. */
  parse(html: string, limit: number): SerpResult[] {
    if (!html || DdgLiteProvider.looksBlocked(html)) return [];
    const $ = cheerio.load(html);
    const out: SerpResult[] = [];
    // DDG-lite renders results as a sequence of <a class="result-link"> + sibling snippet.
    $('a.result-link').each((idx, el) => {
      if (out.length >= limit) return false;
      const href = $(el).attr('href');
      const title = $(el).text().trim();
      if (!href || !title) return undefined;
      const cleanedUrl = this.unwrapDdgRedirect(href);
      const snippet = $(el).closest('tr').next('tr').find('.result-snippet').text().trim();
      out.push({
        title,
        url: cleanedUrl,
        snippet,
        rank: idx + 1,
        source_provider: this.id,
      });
      return undefined;
    });
    // Fallback: some lite layouts use plain anchors inside <td class="result-link">
    if (out.length === 0) {
      $('a').each((idx, el) => {
        if (out.length >= limit) return false;
        const href = $(el).attr('href') ?? '';
        const txt = $(el).text().trim();
        if (!href || !txt) return undefined;
        if (!/^https?:\/\//i.test(href) && !href.startsWith('//duckduckgo.com/l/')) return undefined;
        const cleanedUrl = this.unwrapDdgRedirect(href);
        if (!/^https?:\/\//i.test(cleanedUrl)) return undefined;
        out.push({ title: txt, url: cleanedUrl, snippet: '', rank: idx + 1, source_provider: this.id });
        return undefined;
      });
    }
    return out;
  }

  /** Public so the live `search()` can decide whether to throw a block error. */
  static looksBlocked(html: string): boolean {
    const lower = html.toLowerCase();
    return (
      lower.includes('bots use duckduckgo too') ||
      lower.includes('anomaly') ||
      lower.includes('unusual traffic') ||
      lower.includes('verify you are not a robot')
    );
  }

  /** DDG wraps real URLs in /l/?uddg=ENCODED — unwrap them. */
  private unwrapDdgRedirect(href: string): string {
    if (!href) return href;
    let url = href;
    if (url.startsWith('//')) url = 'https:' + url;
    try {
      const u = new URL(url, 'https://duckduckgo.com');
      if (u.pathname === '/l/' && u.searchParams.has('uddg')) {
        const target = u.searchParams.get('uddg');
        if (target) return decodeURIComponent(target);
      }
      return u.toString();
    } catch {
      return href;
    }
  }
}
