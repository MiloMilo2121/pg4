/**
 * R13 (Phase 3) — the live fatturatoitalia.it fetcher the parser was waiting
 * for. The parser (`fatturato_italia_parser.ts`) is PURE and deferred the
 * network; this is the small, rate-limited fetch that feeds it.
 *
 * URL pattern (probed 2026-06-12 on real P.IVA, see docs/measurement_evidence/):
 *   https://www.fatturatoitalia.it/<P.IVA>  → the company page with the
 *   embedded `datiChartFatturato` / `labelChart` JS vars the parser reads.
 *
 * fatturatoitalia.it is a public site → free (direct_fetch, tier 0). It is
 * correctly on the website-discovery denylist (an EXTRACTABLE_REGISTRY, never
 * accepted as a company's own `official_website`), so fetching it here for
 * firmographics does not pollute website discovery.
 *
 * Free, but be a good citizen: callers bound concurrency (the dev server caps
 * at 5) and a short timeout; do not hammer the site at volume.
 */
import { normalizeVatCode, validateItalianVatChecksum } from './vat';
import { parseFatturatoItaliaPage } from './fatturato_italia_parser';
import type { FatturatoItaliaParseResult } from './fatturato_italia_parser';
import { DirectFetchProvider } from '../../providers/http/direct_fetch';
import { RateLimiter } from '../../runtime/rate_limiter';

const fetcher = new DirectFetchProvider();

// MEASURED 2026-06-13: fatturatoitalia.it drops connections (status 0, empty
// body) under burst requests — a no-delay probe of 30 VATs returned 0% while the
// SAME VATs fetched 5/5 with ~4s spacing. So bulk free scraping is reliable ONLY
// when throttled. This module-level limiter self-throttles ALL callers (dev
// server pool + probes) to ~1 req / 2.5s, capacity 1 — good-citizen spacing that
// trades volume speed for not getting silently blocked. The trade-off: a large
// enrich selection is slow (bounded by the caller's job timeout, partial-but-true
// results), which is correct — a fast 0%-fill is worse than a slow real fill.
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

/**
 * Fetch + parse a company's fatturatoitalia.it page by P.IVA. Returns the
 * parsed firmographics (revenue/employees/history) or undefined when the VAT
 * is invalid, the fetch fails, or the page carries no usable financial data
 * (confidence < 0.5 — the page exists but has no chart/grid). Never throws.
 */
export async function fetchFatturatoItalia(
  rawVat: string | undefined | null,
  opts: { timeoutMs?: number } = {}
): Promise<FatturatoItaliaLookup | undefined> {
  const vat = normalizeVatCode(rawVat);
  if (!/^\d{11}$/.test(vat) || !validateItalianVatChecksum(vat)) return undefined;

  const cached = memo.get(vat);
  if (cached && Date.now() - cached.at < MEMO_TTL_MS) return cached.val;

  const url = `https://www.fatturatoitalia.it/${vat}`;
  let html: string | undefined;
  try {
    await limiter.acquire('fatturatoitalia'); // good-citizen spacing — see limiter note
    const res = await fetcher.fetch(url, { timeoutMs: opts.timeoutMs ?? 12_000 });
    html = res.html;
  } catch {
    return undefined; // transient — do not memoise a failure
  }
  if (!html) return undefined; // includes status-0 block (empty body) — not memoised, retryable

  const parsed = parseFatturatoItaliaPage(html);
  // confidence 0.4 = the generic site shell (no company resolved); require a
  // real parse (chart → 0.9, grid → 0.75).
  const val = parsed.confidence < 0.5 ? undefined : { ...parsed, vat_queried: vat, source_url: url };
  memo.set(vat, { at: Date.now(), val });
  return val;
}
