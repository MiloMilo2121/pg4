import { request } from 'undici';
import * as cheerio from 'cheerio';
import type { SerpProvider, SerpResult } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';

/**
 * Tier 1 SERP via Bing HTML scrape. Stable selectors (`li.b_algo`), Italian
 * region preferred via cc=IT and setlang=it-IT.
 *
 * Block detection: page title contains "verify"/"unusual" or page renders a
 * captcha challenge — in either case we return [].
 */
export class BingHtmlProvider implements SerpProvider {
  readonly id = 'bing_html';
  readonly family = 'serp' as const;
  readonly tier = 1;
  readonly costPerCallEur = 0;

  available(): boolean {
    return true;
  }

  async search(query: string, opts: { signal?: AbortSignal; limit?: number } = {}): Promise<SerpResult[]> {
    if (!query.trim()) return [];
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&cc=IT&setlang=it-IT&first=1`;
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
        maxRedirections: 3,
      });
      if (res.statusCode !== 200) {
        await res.body.dump();
        return [];
      }
      html = await res.body.text();
    } catch {
      return [];
    }
    // Phase 4.2: a block page is NOT an empty result. The router needs
    // to know so it trips the circuit breaker aggressively (Bing
    // captcha loops were a top-3 noise source in pg3 logs).
    if (BingHtmlProvider.looksBlocked(html)) {
      throw new ProviderBlockError(this.id, 'Bing served a captcha / block page');
    }
    return this.parse(html, opts.limit ?? 25);
  }

  /** Pure parser, exposed for unit tests. */
  parse(html: string, limit: number): SerpResult[] {
    if (!html || BingHtmlProvider.looksBlocked(html)) return [];
    const $ = cheerio.load(html);
    const out: SerpResult[] = [];
    $('li.b_algo').each((idx, el) => {
      if (out.length >= limit) return false;
      const a = $(el).find('h2 a').first();
      const href = a.attr('href');
      const title = a.text().trim();
      if (!href || !title) return undefined;
      // Snippet: try several known wrappers
      const snippet =
        $(el).find('.b_caption p').first().text().trim() ||
        $(el).find('.b_snippet').first().text().trim() ||
        $(el).find('.b_lineclamp4').first().text().trim() ||
        '';
      out.push({
        title,
        url: href,
        snippet,
        rank: idx + 1,
        source_provider: this.id,
      });
      return undefined;
    });
    return out;
  }

  /** Public so the live `search()` can decide whether to throw a block error. */
  static looksBlocked(html: string): boolean {
    const lower = html.toLowerCase();
    return (
      lower.includes('verify you are a human') ||
      lower.includes('unusual traffic') ||
      lower.includes('captcha-container') ||
      lower.includes('please verify')
    );
  }
}
