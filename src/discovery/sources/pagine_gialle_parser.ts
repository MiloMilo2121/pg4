import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Lead } from '../../types/lead';
import { cleanMojibakeFields } from '../text_cleanup';

type CheerioCard = cheerio.Cheerio<AnyNode>;

/**
 * Pure parser for PagineGialle search-result HTML pages.
 *
 * Selectors are derived from the canonical pg3 implementation
 * (`pg3/src/scraper/runner.ts`):
 *   - `.search-itm`           → result card root
 *   - `.search-itm__rag`      → company name (ragione sociale)
 *   - `.search-itm__adr`      → address ("Via X, 12345 Comune (PV)")
 *   - `.search-itm__phone`,
 *     `.search-itm__phone-item` → phone(s)
 *   - `a.remove_blank_for_app` → PG canonical card URL
 *   - `a[href^="http"]`       → external website link, with PG/IO/plug.it skipped
 *
 * No browser, no network. Returns one `Lead` per parsed card; empty/malformed
 * cards are skipped silently — caller can compute `dropped = cards - results`.
 */

export interface PageGialleParseResult {
  results: Lead[];
  total_cards: number;
  dropped: number;
  overflow: boolean; // true when PG renders the ">200 results" banner
}

export interface PageGialleParseOptions {
  category?: string;
  /**
   * The comune/location string used in the PG search URL. Stored on each
   * lead as `query_location` so cross-comune dedupe by `pg_url` can
   * collapse the same agency seen via different queries.
   */
  queryLocation?: string;
}

/**
 * Hosts that PG renders as `<a href="http...">` inside cards but are NOT
 * the company's official website:
 *   - PG / Italiaonline / plug.it: PG-internal navigation links
 *   - wa.me / whatsapp.com / m.me: PG-generated "Click to chat" buttons
 *     (the URL contains `?text=Da+PagineGialle...`)
 *   - tel: / mailto: / sms: are non-http and skipped naturally by the
 *     `a[href^="http"]` selector
 */
const INTERNAL_HOST_BLOCKLIST =
  /paginegialle\.it|italiaonline\.it|plug\.it|wa\.me|whatsapp\.com|m\.me|messenger\.com/i;
const OVERFLOW_REGEX = /pi[uù]\s+di\s+200\s+risultat|oltre\s+200\s+risultat|more\s+than\s+200\s+result/i;

export function parsePagineGialleResults(
  html: string,
  opts: PageGialleParseOptions = {}
): PageGialleParseResult {
  if (!html || html.length < 100) {
    return { results: [], total_cards: 0, dropped: 0, overflow: false };
  }
  const $ = cheerio.load(html);
  const overflow = OVERFLOW_REGEX.test($('body').text());

  const cards = $('.search-itm').toArray();
  const total = cards.length;
  const out: Lead[] = [];

  for (const cardEl of cards) {
    const $card = $(cardEl);
    const lead = parseCard($card, opts);
    if (lead) out.push(lead);
  }

  return { results: out, total_cards: total, dropped: total - out.length, overflow };
}

function parseCard($card: CheerioCard, opts: PageGialleParseOptions): Lead | undefined {
  const category = opts.category;
  const rawName = $card.find('.search-itm__rag').first().text();
  const name = collapseSpaces(rawName);
  if (!name) return undefined;

  const rawAddr = $card.find('.search-itm__adr').first().text();
  const addr = collapseSpaces(rawAddr) || undefined;

  const phone = extractPhone($card);
  const website = extractWebsite($card);
  const pgUrl = $card.find('a.remove_blank_for_app').first().attr('href') || undefined;

  // Address parsing: "Via Roma 1, 32100 Belluno (BL)"
  const cap = addr?.match(/\b(\d{5})\b/)?.[1];
  const cityMatch = addr?.match(/\d{5}\s+([^()]+?)\s*\(/);
  const provMatch = addr?.match(/\(([A-Z]{2})\)/);

  const lead: Lead = {
    company_name: name,
    source: 'PG',
    sources: ['PG'],
  };
  if (category) lead.category = category;
  if (addr) lead.address = addr;
  if (cap) lead.zip_code = cap;
  if (cityMatch) lead.city = cityMatch[1].trim();
  if (provMatch) lead.province = provMatch[1];
  if (phone) lead.phone = phone;
  if (website) lead.website = website;
  if (pgUrl) {
    lead.pg_url = pgUrl;
    lead.source_url = pgUrl;
  }
  if (opts.queryLocation) {
    lead.query_location = opts.queryLocation;
    if (lead.city && lead.city.toLowerCase() !== opts.queryLocation.toLowerCase()) {
      lead.business_city = lead.city;
    }
  }
  // Phase 4.4: strip U+FFFD replacement runs that PG occasionally produces
  // when its CMS serves latin-1-encoded bytes (`Piazza Libert\xe0` →
  // `Piazza Libert��`). Conservative: drop the corrupted run only,
  // preserve valid accented characters elsewhere.
  return cleanMojibakeFields(lead, ['company_name', 'city', 'business_city', 'address']);
}

/**
 * Pull the first phone-like token from the card. PG sometimes renders multiple
 * phone-item spans inside one `.search-itm__phone` container; we keep only the
 * first phone because downstream dedupe benefits from a single canonical phone.
 *
 * Selector strategy:
 *   1. Prefer the most specific element: the FIRST `.search-itm__phone-item`.
 *   2. Fall back to `.search-itm__phone` only if no items are present.
 * (`.first()` over `.find('.a, .b')` does breadth-first and picks the parent
 *  container, concatenating both spans — wrong.)
 */
function extractPhone($card: CheerioCard): string | undefined {
  let raw = collapseSpaces($card.find('.search-itm__phone-item').first().text());
  if (!raw) raw = collapseSpaces($card.find('.search-itm__phone').first().text());
  if (!raw) return undefined;
  const m = raw.match(/[+]?\d[\d\s\-./()]{5,15}/);
  if (!m) return undefined;
  // Safety cap: an Italian phone has at most ~12 digits including country code.
  // Anything longer means two phones concatenated — keep only the first.
  const cleaned = m[0].trim();
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length <= 12) return cleaned;
  const head = cleaned.match(/^([+]?\d[\d\s\-./()]{4,12})/);
  return head ? head[1].trim() : cleaned;
}

/**
 * First external `http(s)` link inside the card that is NOT a PG/IO/plug.it
 * internal URL. PG renders the official site as either `.search-itm__website`
 * or just `a[href^="http"]`, so we scan all anchors generically.
 */
function extractWebsite($card: CheerioCard): string | undefined {
  let result: string | undefined;
  $card.find('a[href^="http"]').each((_idx, el) => {
    if (result) return false;
    const href = $card.find(el).attr('href') ?? '';
    if (!href || INTERNAL_HOST_BLOCKLIST.test(href)) return undefined;
    result = href;
    return false;
  });
  return result;
}

function collapseSpaces(s: string | undefined | null): string {
  if (!s) return '';
  return s.replace(/[\s ]+/g, ' ').trim();
}
