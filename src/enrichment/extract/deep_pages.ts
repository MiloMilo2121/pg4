/**
 * Phase B.1 (free-gold, deepened) — extend the free extractor BEYOND the
 * homepage to the firm's own contact/about pages, at the cost of a few extra
 * same-site fetches (€0 marginal API cost; just HTTP).
 *
 * Rationale: ~half of Italian SMB sites print the business email only on
 * /contatti or /chi-siamo, not the homepage footer. The Phase-1 `extractFromBody`
 * is PURE (homepage HTML in → values out). This module adds the IMPURE layer:
 * discover the contact links ON the homepage, fetch a bounded set of them, run
 * the SAME pure extractor on each, and merge — so email/social/VAT all benefit
 * from one deepened pass.
 *
 * PRECISION INVARIANT: every merged value goes through `extractFromBody`, which
 * enforces same-registrable-domain emails and profile-shaped socials. Deepening
 * raises FILL-RATE without lowering PRECISION — the contact-page email is the
 * same high-confidence scraped mailto as a homepage one, just on another own page.
 * (A guessed `info@domain` is a DIFFERENT, lower-precision tier — see
 * field_registry `email.pattern_guess`, wired but disabled by default.)
 */
import * as cheerio from 'cheerio';
import { extractFromBody, registrableDomain } from './extract_from_body';
import type { BodyExtraction } from './extract_from_body';
import { RateLimiter } from '../../runtime/rate_limiter';

/** Link text / href fragments that mark a contact/about page on Italian sites. */
const CONTACT_LINK_RE = /contatt|chi[-\s]?siamo|chisiamo|azienda|dove[-\s]?siamo|contact|about|impressum|note[-\s]?legali/i;

/**
 * PER-DOMAIN courtesy rate-limit (generalizes the bug#4 lesson to the website path).
 * deepExtractFromSite fetches a site's homepage + up to 2 contact pages in quick
 * succession, and the dev-server pool runs 5 companies at once. Unthrottled that is a
 * burst against each SMB site (WAF/ban risk + the silent-fail class). A per-DOMAIN
 * bucket (≤2 req/s, no burst) spaces same-site fetches while letting DIFFERENT domains
 * (the pool) proceed in parallel. Bucket-per-domain is bounded per enrich run (≤ rows);
 * acceptable for the dev/bounded context (a production server would use an LRU).
 */
const domainLimiter = new RateLimiter();
const configuredDomains = new Set<string>();
async function spacedFetch(url: string, fetcher: PageFetcher): Promise<string | undefined> {
  const dom = registrableDomain(url) ?? url;
  if (!configuredDomains.has(dom)) {
    domainLimiter.configure(dom, 2, 1); // ≤2 req/s per domain, capacity 1 → no burst
    configuredDomains.add(dom);
  }
  await domainLimiter.acquire(dom);
  return fetcher(url);
}

export interface DeepExtractResult {
  extraction: BodyExtraction;
  /** Pages actually fetched (homepage first), for observability + cost honesty. */
  pagesFetched: string[];
  /** Which fields the contact pages ADDED that the homepage lacked (lift trace). */
  liftedFields: string[];
}

/** A minimal fetcher: URL → HTML (or undefined on any failure). Decoupled for tests. */
export type PageFetcher = (url: string) => Promise<string | undefined>;

/**
 * Find same-site contact/about links printed on a homepage. Returns absolute
 * URLs on the firm's own registrable domain, deduped, capped. Pure (HTML in).
 */
export function findContactLinks(homepageHtml: string | undefined, site: string | undefined, cap = 3): string[] {
  if (!homepageHtml || !site) return [];
  const own = registrableDomain(site);
  if (!own) return [];
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(homepageHtml);
  } catch {
    return [];
  }
  const base = site.startsWith('http') ? site : `https://${own}`;
  const found = new Map<string, true>(); // url → keep insertion order, dedup
  $('a[href]').each((_i, el) => {
    if (found.size >= cap) return;
    const href = ($(el).attr('href') ?? '').trim();
    const text = $(el).text().trim();
    if (!href || href.startsWith('#') || /^(?:mailto|tel):/i.test(href)) return;
    if (!CONTACT_LINK_RE.test(href) && !CONTACT_LINK_RE.test(text)) return;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      return;
    }
    if (abs.protocol !== 'https:' && abs.protocol !== 'http:') return;
    if (registrableDomain(abs.hostname) !== own) return; // same-site only
    const clean = `${abs.origin}${abs.pathname}`.replace(/\/$/, '');
    if (clean.replace(/\/$/, '') === base.replace(/\/$/, '')) return; // not the homepage itself
    if (!found.has(clean)) found.set(clean, true);
  });
  return [...found.keys()].slice(0, cap);
}

/**
 * Merge a secondary extraction into a base one: fill-first for scalar fields
 * (the homepage wins ties — it's the canonical page), union for arrays. Pure.
 * Returns the list of scalar fields that `extra` newly contributed.
 */
export function mergeExtractions(base: BodyExtraction, extra: BodyExtraction): string[] {
  const added: string[] = [];
  for (const k of ['email', 'pec', 'instagram', 'facebook', 'linkedin'] as const) {
    if (!base[k] && extra[k]) {
      base[k] = extra[k];
      added.push(k);
    }
  }
  const vatBefore = base.vat_candidates.length;
  for (const v of extra.vat_candidates) if (!base.vat_candidates.includes(v)) base.vat_candidates.push(v);
  if (base.vat_candidates.length > vatBefore) added.push('vat');
  for (const p of extra.phones) if (!base.phones.includes(p)) base.phones.push(p);
  return added;
}

/**
 * Deepened free extraction: homepage + a bounded set of its own contact/about
 * pages, merged. One HTTP fetch per page, no paid API. `maxContactPages` caps
 * the extra fetches (default 2) so the cost stays small and bounded.
 */
export async function deepExtractFromSite(
  site: string | undefined,
  fetcher: PageFetcher,
  opts: { maxContactPages?: number } = {},
): Promise<DeepExtractResult> {
  const lead = { official_website: site };
  const homepage = site ? await spacedFetch(site, fetcher) : undefined;
  const extraction = extractFromBody(homepage, lead);
  const pagesFetched: string[] = [];
  const liftedFields: string[] = [];
  if (site && homepage) pagesFetched.push(site);
  if (!homepage) return { extraction, pagesFetched, liftedFields };

  const max = opts.maxContactPages ?? 2;
  const links = findContactLinks(homepage, site, max);
  for (const url of links) {
    const html = await spacedFetch(url, fetcher); // per-domain spacing — no burst to the site
    if (!html) continue;
    pagesFetched.push(url);
    const sub = extractFromBody(html, lead);
    for (const f of mergeExtractions(extraction, sub)) if (!liftedFields.includes(f)) liftedFields.push(f);
  }
  return { extraction, pagesFetched, liftedFields };
}
