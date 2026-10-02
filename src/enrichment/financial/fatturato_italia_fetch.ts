/**
 * The live fatturatoitalia.it fetcher the parser was waiting
 * for. The parser (`fatturato_italia_parser.ts`) is PURE and deferred the
 * network; this is the small, rate-limited fetch that feeds it.
 *
 * URL scheme (re-probed 2026-07-18 — the site changed; measurements below
 * were taken on that probe):
 *   - The old direct `https://www.fatturatoitalia.it/<P.IVA>` now 404s for
 *     every VAT (it parsed the 404 shell → silent garbage).
 *   - The company page lives at a slug URL `/<slug>-<P.IVA>`, reachable only
 *     via the site's own XHR search: POST `/risultato-di-ricerca` with
 *     `search_action=run&search_type=piva&search_query=<P.IVA>` and
 *     `X-Requested-With: XMLHttpRequest` → JSON `{results:[{tax_code,url}]}`.
 *   We resolve the slug from that JSON, then GET the page (a 301 folds the long
 *   slug to a canonical short one) and hand the HTML to the parser.
 *
 * fatturatoitalia.it is a public site → free (direct_fetch, tier 0). It is
 * correctly on the website-discovery denylist (an EXTRACTABLE_REGISTRY, never
 * accepted as a company's own `official_website`), so fetching it here for
 * firmographics does not pollute website discovery.
 *
 * Free, but be a good citizen: callers bound concurrency (the dev server caps
 * at 5) and a short timeout; do not hammer the site at volume.
 */
import { followRedirects } from '../../providers/http/follow_redirects';
import { normalizeVatCode, validateItalianVatChecksum } from './vat';
import { parseFatturatoItaliaPage } from './fatturato_italia_parser';
import type { FatturatoItaliaParseResult } from './fatturato_italia_parser';
import { DirectFetchProvider } from '../../providers/http/direct_fetch';
import { RateLimiter } from '../../runtime/rate_limiter';
import { DEFAULTS } from '../../config/defaults';
import { CircuitBreaker } from '../../runtime/circuit_breaker';
import { classifyHttpFailure, type FailureKind } from '../../types/providers';

const fetcher = new DirectFetchProvider();

const hostOf = (url: string): string => new URL(url).host;

const ORIGIN = 'https://www.fatturatoitalia.it';
const SEARCH_URL = `${ORIGIN}/risultato-di-ricerca`;
const SEARCH_HOST = hostOf(SEARCH_URL);

// MEASURED 2026-06-13: fatturatoitalia.it drops connections (status 0, empty
// body) under burst requests — a no-delay probe of 30 VATs returned 0% while the
// SAME VATs fetched 5/5 with ~4s spacing. So bulk free scraping is reliable ONLY
// when throttled. This module-level limiter self-throttles ALL callers (dev
// server pool + probes) to ~1 req / 4s, capacity 1 — good-citizen spacing that
// trades volume speed for not getting silently blocked. Each lookup now costs
// TWO spaced requests (search + page); a large enrich selection is slow (bounded
// by the caller's job timeout, partial-but-true results), which is correct — a
// fast 0%-fill is worse than a slow real fill.
const limiter = new RateLimiter();
limiter.configure('fatturatoitalia', 0.25, 1); // ~1 req / 4s — MEASURED reliable (2.5s still got blocked, 4s = 5/5)

export interface FatturatoItaliaLookup extends FatturatoItaliaParseResult {
  vat_queried: string;
  source_url: string;
}

// Short-lived memo so enriching `revenue` then `employees` for the same P.IVA
// costs ONE fetch, and a row re-enriched in the same session isn't re-fetched.
// (A durable cross-run cache is the Supabase enrichment_cache; this is the
// in-process floor + good-citizen rate relief on the public site.)
const memo = new Map<string, { at: number; val: FatturatoItaliaLookup | undefined }>();
const MEMO_TTL_MS = 300_000;

/** Bounded memo write: sweep expired entries before growing past the cap, so a
 * national-scale run (50k+ distinct VATs) cannot grow the Map for the process
 * lifetime. At the ~4s/req pace the cap is never near in practice. */
function memoSet(vat: string, val: FatturatoItaliaLookup | undefined): void {
  if (memo.size >= 5_000) {
    const cutoff = Date.now() - MEMO_TTL_MS;
    for (const [k, v] of memo) if (v.at < cutoff) memo.delete(k);
  }
  memo.set(vat, { at: Date.now(), val });
}

// Circuit breaker for the MEASURED site-wide block mode (status 0 / error shell
// under load): once the host is down for us, answer undefined fast (never
// memoised) instead of crawling the run at ~8-16s/lead for a guaranteed 0% fill.
// Keyed by host and bounded by a window, so it trips on a real outage, not on
// five unrelated transients scattered across a long run. At the limiter's pace a
// lookup takes ~8 s, so 120 s holds ~15 lookups: 5 host failures among them is
// a block. After the cool-down the breaker half-opens and the next failure
// re-opens it at once, so 5 minutes (not a flat 10) is enough.
// Lead-specific answers (VAT not indexed, page 404/410) are not host failures.
const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 120_000, cooldownMs: 300_000 });

/** A failure of the host itself, as opposed to one lead's missing page. */
class HostFailure extends Error {
  constructor(
    readonly host: string,
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
  }
}

function noteHostFailure(err: unknown): undefined {
  if (err instanceof HostFailure) breaker.recordFailure(err.host, err.kind);
  else breaker.recordFailure(SEARCH_HOST, classifyHttpFailure({ error: (err as Error)?.message }));
  return undefined;
}

/**
 * Resolve a company's slug page URL from its P.IVA via the site's XHR search.
 * Returns the absolute page URL, or undefined when the VAT is not in the index
 * (a definitive miss) or the search fails/blocks (transient — thrown, so the
 * caller does not memoise it). Never returns a non-matching company: for a P.IVA
 * query we require an exact `tax_code` match, accepting a lone result as that
 * match (the API searched by our VAT).
 */
async function resolveCompanyUrl(vat: string, timeoutMs: number): Promise<string | undefined> {
  const body = new URLSearchParams({
    search_action: 'run',
    search_type: 'piva',
    search_query: vat,
  }).toString();

  const { response: res } = await followRedirects(SEARCH_URL, {
    method: 'POST',
    body,
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'user-agent': DEFAULTS.http.userAgent,
      'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
    },
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    await res.body.dump();
    // One search endpoint serves every VAT, so an error status is the host's.
    throw new HostFailure(SEARCH_HOST, classifyHttpFailure({ status: res.statusCode }), `search http ${res.statusCode}`);
  }

  let json: unknown;
  try {
    json = await res.body.json();
  } catch {
    throw new HostFailure(SEARCH_HOST, 'blocked', 'search json parse'); // block/HTML shell — transient
  }

  const results = (json as { results?: Array<{ tax_code?: string; url?: string }> })?.results;
  if (!Array.isArray(results) || results.length === 0) return undefined; // definitive miss

  const exact = results.find((r) => (r.tax_code ?? '').replace(/\D/g, '') === vat);
  const hit = exact ?? (results.length === 1 ? results[0] : undefined);
  const path = hit?.url;
  if (!path) return undefined;
  return path.startsWith('http') ? path : `${ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Fetch + parse a company's fatturatoitalia.it page by P.IVA. Returns the
 * parsed firmographics (revenue/employees/history) or undefined when the VAT
 * is invalid, not in the index, the fetch fails, or the page carries no usable
 * financial data (confidence < 0.5 — the page exists but has no chart/grid).
 * Never throws.
 */
export async function fetchFatturatoItalia(
  rawVat: string | undefined | null,
  opts: { timeoutMs?: number } = {}
): Promise<FatturatoItaliaLookup | undefined> {
  const vat = normalizeVatCode(rawVat);
  if (!/^\d{11}$/.test(vat) || !validateItalianVatChecksum(vat)) return undefined;

  const cached = memo.get(vat);
  if (cached && Date.now() - cached.at < MEMO_TTL_MS) return cached.val;

  if (!breaker.allow(SEARCH_HOST)) return undefined; // circuit open — cooling down, not memoised

  const timeoutMs = opts.timeoutMs ?? 12_000;
  let pageUrl: string | undefined;
  let html: string | undefined;
  try {
    await limiter.acquire('fatturatoitalia'); // good-citizen spacing — see limiter note
    pageUrl = await resolveCompanyUrl(vat, timeoutMs);
    if (!pageUrl) {
      breaker.recordSuccess(SEARCH_HOST); // the search itself worked
      memoSet(vat, undefined); // definitive: VAT not indexed
      return undefined;
    }
    const pageHost = hostOf(pageUrl);
    if (!breaker.allow(pageHost)) return undefined;
    await limiter.acquire('fatturatoitalia');
    const res = await fetcher.fetch(pageUrl, { timeoutMs }); // follows the slug 301
    // DirectFetchProvider returns the body for ANY text/html status (it only
    // errors on network failure), so an error shell (403 WAF / 404 / 5xx) would
    // otherwise reach the parser at confidence <0.5 and be memoised 5 min as a
    // definitive miss — poisoning the employees step that shares this memo.
    // An error status is never memoised and stays retryable. A 404/410 is this
    // lead's page missing; anything else (403 WAF, 429, 5xx, status 0) is the
    // host refusing everyone.
    if (res.status === 404 || res.status === 410) return undefined;
    if (res.status < 200 || res.status >= 400) {
      throw new HostFailure(pageHost, classifyHttpFailure({ status: res.status, error: res.error }), `page http ${res.status}`);
    }
    if (!res.html) throw new HostFailure(pageHost, 'blocked', 'page empty body'); // status-0 style block
    html = res.html;
    breaker.recordSuccess(pageHost);
  } catch (err) {
    return noteHostFailure(err); // transient — do not memoise a failure
  }

  const parsed = parseFatturatoItaliaPage(html, pageUrl);
  // confidence 0.4 = the generic site shell (no company resolved); require a
  // real parse (chart → 0.9, table/grid → 0.75).
  const val = parsed.confidence < 0.5 ? undefined : { ...parsed, vat_queried: vat, source_url: pageUrl };
  memoSet(vat, val);
  return val;
}
