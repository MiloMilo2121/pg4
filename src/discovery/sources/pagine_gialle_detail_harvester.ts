import * as cheerio from 'cheerio';
import { request } from 'undici';
import { isDirectoryOrSocial } from '../website/content_filter';
import { DEFAULTS } from '../../config/defaults';

/**
 * R1 — pg4 port of pg3's `PagineGialleHarvester`. HTTP-only, no
 * browser, run-scoped cache. Parses a PG company-detail page and
 * returns the deterministic evidence pg3 used to short-circuit the
 * SERP ladder:
 *
 *   - official_website  (only if it passes `isDirectoryOrSocial` filter)
 *   - vat_code (P.IVA)
 *   - phone, email
 *   - normalized name + address
 *
 * The harvester does NOT decide whether the website is the lead's
 * official site — that's `verifyCandidates` + `PreVerifyGate`. It only
 * extracts the candidate. Same separation pg4 uses elsewhere: the
 * harvester is a pure parser; the gate is the only authority on
 * acceptance.
 *
 * Adapted from `pg3/src/enricher/core/directories/paginegialle.ts`
 * but rewritten for pg4 conventions:
 *   - undici instead of fetch
 *   - exact `isDirectoryOrSocial` filter
 *   - explicit `HarvestResult` shape
 *   - the cache lives on the instance so each run has its own scope
 */

export interface PgDetailHarvest {
  source_url: string;
  official_website?: string;
  vat_code?: string;
  phone?: string;
  email?: string;
  name?: string;
  address?: string;
}

export interface PgDetailHarvestOptions {
  /** Per-call timeout in ms. Defaults to `DEFAULTS.pipeline.requestTimeoutMs`. */
  timeoutMs?: number;
  /** Pluggable fetcher for tests. Defaults to undici.request. */
  fetchHtml?: (url: string, opts: { timeoutMs?: number }) => Promise<{ status: number; html?: string }>;
}

const PG_DETAIL_HOST_RE = /^https?:\/\/(?:www\.)?paginegialle\.it\//i;
const PG_RICERCA_RE = /\/ricerca\//i;

/**
 * Run-scoped cache. One instance per run. The cache key is the PG
 * URL after normalization (strip trailing slash + lowercased).
 */
export class PgDetailHarvester {
  private cache = new Map<string, PgDetailHarvest | null>();

  constructor(private opts: PgDetailHarvestOptions = {}) {}

  /**
   * Harvest from an exact PG company URL. Returns `null` when:
   *   - URL is not a PG company page (e.g. ricerca/ search page)
   *   - HTTP fetch fails or returns non-2xx
   *   - HTML doesn't yield any extractable evidence
   *
   * Cached per URL within this harvester instance.
   */
  async harvest(pgUrl: string): Promise<PgDetailHarvest | null> {
    const key = this.normalizeUrl(pgUrl);
    if (!key) return null;
    if (!PG_DETAIL_HOST_RE.test(key) || PG_RICERCA_RE.test(key)) return null;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;

    const fetchHtml = this.opts.fetchHtml ?? this.defaultFetchHtml;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULTS.pipeline.requestTimeoutMs;
    let html: string | undefined;
    try {
      const res = await fetchHtml(key, { timeoutMs });
      if (res.status < 200 || res.status >= 400 || !res.html) {
        this.cache.set(key, null);
        return null;
      }
      html = res.html;
    } catch {
      this.cache.set(key, null);
      return null;
    }

    const harvest = PgDetailHarvester.extractCompanyDetails(html, key);
    this.cache.set(key, harvest);
    return harvest;
  }

  private normalizeUrl(raw: string): string {
    if (!raw) return '';
    try {
      const u = new URL(raw.trim());
      u.hash = '';
      // Trailing slash off; lowercase host.
      u.hostname = u.hostname.toLowerCase();
      const s = u.toString().replace(/\/$/, '');
      return s;
    } catch {
      return '';
    }
  }

  private defaultFetchHtml = async (url: string, opts: { timeoutMs?: number }) => {
    const res = await request(url, {
      method: 'GET',
      bodyTimeout: opts.timeoutMs,
      headersTimeout: opts.timeoutMs,
      maxRedirections: 5,
      headers: {
        'user-agent': DEFAULTS.http.userAgent,
        'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (res.statusCode < 200 || res.statusCode >= 400) {
      await res.body.dump();
      return { status: res.statusCode };
    }
    return { status: res.statusCode, html: await res.body.text() };
  };

  /**
   * Pure parser for a PG company-detail page. Extracts whatever
   * evidence the page surfaces (JSON-LD first, regex fallback,
   * visible-text last). Exposed static for unit tests.
   */
  static extractCompanyDetails(html: string, sourceUrl: string): PgDetailHarvest | null {
    if (!html || html.length < 200) return null;
    const $ = cheerio.load(html);

    // 1. Official website — the explicit "scheda_azienda__cta_sitoweb" anchor is the
    //    canonical signal. Any other "Sito web" link is a runner-up.
    const websiteCandidates: string[] = [];
    const cta = $('a[data-tr="scheda_azienda__cta_sitoweb"]').first().attr('href');
    if (cta) websiteCandidates.push(cta);
    $('a').each((_, el) => {
      const a = $(el);
      const href = a.attr('href') || '';
      if (!href) return;
      const dataTr = (a.attr('data-tr') || '').toLowerCase();
      const title = (a.attr('title') || '').toLowerCase();
      const text = a.text().toLowerCase();
      if (dataTr.includes('sitoweb') || title.includes('sito web') || text.includes('sito web')) {
        websiteCandidates.push(href);
      }
    });
    let officialWebsite: string | undefined;
    for (const raw of websiteCandidates) {
      const cleaned = raw.trim();
      if (PgDetailHarvester.isLikelyOfficialWebsiteUrl(cleaned)) {
        officialWebsite = cleaned;
        break;
      }
    }

    // 2. JSON-LD evidence.
    let vat: string | undefined;
    let phone: string | undefined;
    let email: string | undefined;
    let name: string | undefined;
    let address: string | undefined;

    $('script[type="application/ld+json"]').each((_, el) => {
      const jsonRaw = $(el).text().trim();
      if (!jsonRaw) return;
      try {
        const parsed = JSON.parse(jsonRaw);
        PgDetailHarvester.walkJson(parsed, (k, v) => {
          const key = k.toLowerCase();
          if (!vat && (key === 'vatid' || key === 'taxid')) {
            const maybeVat = PgDetailHarvester.extractFirstVat(v);
            if (maybeVat) vat = maybeVat;
          }
          if (!phone && key === 'telephone' && typeof v === 'string') {
            phone = v.trim();
          }
          if (!email && key === 'email' && typeof v === 'string') {
            email = v.trim().toLowerCase();
          }
          if (!name && key === 'name' && typeof v === 'string') {
            name = v.trim();
          }
        });
      } catch {
        /* json parse errors silently ignored */
      }
    });

    // 3. Regex fallback for VAT / email / phone.
    if (!vat) {
      const m = html.match(/"vatID"\s*:\s*"(?:IT)?(\d{11})"/i);
      if (m?.[1]) vat = m[1];
    }
    if (!email) {
      const m = html.match(/"email"\s*:\s*"([^"]+)"/i);
      if (m?.[1]) email = m[1].trim().toLowerCase();
    }
    if (!phone) {
      const m = html.match(/"telephone"\s*:\s*"([^"]+)"/i);
      if (m?.[1]) phone = m[1].trim();
    }

    // 4. Visible-text fallback for name / address.
    if (!name) {
      const h1 = $('h1').first().text().trim();
      if (h1) name = h1;
    }
    if (!address) {
      const adr = $('.sede__indirizzo, .scheda-azienda__addr, .contact__address, .search-itm__adr').first().text();
      const cleaned = (adr || '').replace(/\s+/g, ' ').trim();
      if (cleaned && cleaned.length >= 8) address = cleaned;
    }

    if (!officialWebsite && !vat && !email && !phone && !name && !address) return null;
    return { source_url: sourceUrl, official_website: officialWebsite, vat_code: vat, phone, email, name, address };
  }

  /**
   * The "official website" that PG advertises must NOT itself be a
   * directory / social / aggregator. We use pg4's existing
   * `isDirectoryOrSocial` (which already covers paginegialle.it,
   * facebook, linkedin, all the G.1 / G.2 round-2 hosts).
   */
  static isLikelyOfficialWebsiteUrl(href: string): boolean {
    const trimmed = (href || '').trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('mailto:') || trimmed.startsWith('tel:') || trimmed.startsWith('javascript:')) return false;
    if (!(trimmed.startsWith('http://') || trimmed.startsWith('https://'))) return false;
    try {
      new URL(trimmed);
    } catch {
      return false;
    }
    return !isDirectoryOrSocial(trimmed);
  }

  private static extractFirstVat(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    const m = v.replace(/^IT/i, '').replace(/\s+/g, '').match(/\b\d{11}\b/);
    return m?.[0];
  }

  private static walkJson(obj: unknown, visit: (key: string, value: unknown) => void): void {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const v of obj) PgDetailHarvester.walkJson(v, visit);
      return;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      visit(k, v);
      if (v && typeof v === 'object') PgDetailHarvester.walkJson(v, visit);
    }
  }
}
