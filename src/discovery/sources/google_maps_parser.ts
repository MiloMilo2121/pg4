import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Lead } from '../../types/lead';
import { classifyCategoryMatch } from './category_match';
import { cleanMojibakeFields } from '../text_cleanup';

type CheerioCard = cheerio.Cheerio<AnyNode>;

/**
 * Threshold above which we assume the Maps feed query has hit its
 * ~120-result cap and the result set is incomplete. Phase 3.7 docs §7.
 */
const MAPS_CAP_LIKELY_THRESHOLD = 110;

/**
 * Pure parser for Google Maps result-feed HTML.
 *
 * Selectors follow `pg3/src/scraper/providers/maps_grid_provider.ts`:
 *   - `div[role="feed"]`              → feed container
 *   - `div.Nv2PK`                     → result card root
 *   - `.qBF1Pd`, `div.fontHeadlineSmall`, or `a[aria-label]` → name
 *   - `.W4Efsd span`                  → mixed info spans (address + phone + tags)
 *   - `a[data-value="Sito web"]`,
 *     `a[aria-label*="sito web" i]`,
 *     `a[aria-label*="Website" i]`    → website
 *   - `.MW4etd`                       → rating
 *
 * The feed mixes signal types (rating, status, address, phone) into bare
 * `<span>` siblings — we type each span by regex to extract address vs phone.
 */

export interface MapsParseResult {
  results: Lead[];
  total_cards: number;
  dropped: number;
  /**
   * True when the feed length looks capped (~120). Orchestrator should
   * narrow the query (smaller geo grid / sub-keyword) and re-run.
   */
  cap_likely: boolean;
}

/**
 * Maps card spans frequently begin with a `·` bullet (Maps uses bullets as
 * visual field separators). We strip them before classification.
 */
const BULLET_PREFIX_RE = /^[·•▪]\s*/;

/**
 * Address prefix whitelist. Real-Maps spans often co-mingle phone numbers
 * with status text; we DO NOT accept the bare 5-digit-token fallback that
 * the synthetic-fixture parser tolerated, because Italian phones can match
 * `\d{5}` too (`0439 00699` would otherwise be classified as a ZIP).
 */
/**
 * Italian street prefixes. Word-boundary (`\b`) matches the transition
 * between an alphanumeric character and a non-alphanumeric. Tokens that
 * already end in `.` (like `Loc.`, `V.le`, `C.so`, `P.za`) cannot use `\b`
 * because `. ` is a non-word→non-word transition; we follow them with
 * `(?=\s|$)` instead.
 */
const ADDRESS_PREFIX_RE =
  /^(Via|Viale|Piazza|Corso|Largo|Vicolo|Strada(?:\s+Provinciale|\s+Statale)?|Località|Borgo|Contrada|Frazione|Piazzale)\b|^(V\.le|Loc\.|C\.so|P\.za|Pza)(?=\s|,|$)/i;

/**
 * Phone regex: Italian landline (0xx-prefix) or mobile (3xx-prefix) with
 * canonical Italian spacing. Rejects bare numerics that are too short or
 * lack the typical Italian shape.
 */
const PHONE_RE = /^(?:\+39\s?)?(?:0\d{1,4}|3\d{2})[\s\-./]?\d[\d\s\-./]{4,12}$/;

export function parseGoogleMapsResults(
  html: string,
  opts: { category?: string; cityHint?: string } = {}
): MapsParseResult {
  if (!html || html.length < 100) return { results: [], total_cards: 0, dropped: 0, cap_likely: false };
  const $ = cheerio.load(html);
  const feed = $('div[role="feed"]').first();
  if (!feed.length) return { results: [], total_cards: 0, dropped: 0, cap_likely: false };

  const cards = feed.find('div.Nv2PK').toArray();
  const out: Lead[] = [];

  for (const cardEl of cards) {
    const $card = $(cardEl);
    const lead = parseCard($card, opts);
    if (lead) out.push(lead);
  }
  return {
    results: out,
    total_cards: cards.length,
    dropped: cards.length - out.length,
    cap_likely: cards.length >= MAPS_CAP_LIKELY_THRESHOLD,
  };
}

function parseCard($card: CheerioCard, opts: { category?: string; cityHint?: string }): Lead | undefined {
  // Name: try .qBF1Pd, then .fontHeadlineSmall, then a[aria-label]
  const nameFromHeadline = collapse($card.find('.qBF1Pd, div.fontHeadlineSmall').first().text());
  const nameFromAria = collapse($card.find('a[aria-label]').first().attr('aria-label') ?? '');
  const name = nameFromHeadline || nameFromAria;
  if (!name) return undefined;

  // Maps card URL — first <a> with href that looks like a place link
  let mapsUrl: string | undefined;
  $card.find('a[href*="/maps/place/"]').each((_i, el) => {
    if (mapsUrl) return false;
    const href = $card.find(el).attr('href');
    if (href) mapsUrl = href.startsWith('http') ? href : `https://www.google.com${href}`;
    return false;
  });

  // Info spans — classify each as address / phone / noise
  // Real Maps DOM has many duplicates and `·` bullet prefixes; we dedupe
  // by text and strip the leading bullet before classification.
  let address: string | undefined;
  let phone: string | undefined;
  let permanentlyClosed = false;
  let typeTag: string | undefined; // first non-noise span — usually the category tag
  const seenSpanText = new Set<string>();
  $card.find('.W4Efsd span').each((_i, el) => {
    const raw = collapse($card.find(el).text());
    if (!raw) return;
    const cleaned = raw.replace(BULLET_PREFIX_RE, '').trim();
    if (!cleaned || cleaned === '·' || seenSpanText.has(cleaned)) return;
    seenSpanText.add(cleaned);
    // Phase C.4 — "Chiuso definitivamente" is the status span Maps renders
    // on dead businesses (en: "Permanently closed"). Distinct from the
    // daily-hours "Chiuso"/"Chiude alle…" statuses, which stay ignored.
    if (/^(Chiuso definitivamente|Permanently closed)/i.test(cleaned)) {
      permanentlyClosed = true;
      return;
    }
    if (!address && ADDRESS_PREFIX_RE.test(cleaned)) {
      address = cleaned;
      return;
    }
    if (!phone && PHONE_RE.test(cleaned)) {
      phone = cleaned;
      return;
    }
    // First short non-address, non-phone, non-status text → likely type tag
    // (e.g. "Agenzia immobiliare", "Centro estetico"). We avoid status text
    // by rejecting strings that contain digits or the typical status verbs.
    if (
      !typeTag &&
      cleaned.length >= 4 &&
      cleaned.length <= 60 &&
      !/\d/.test(cleaned) &&
      !/^(Aperto|Chiuso|Aperto·|Chiude|Apre|Chiude tra)/i.test(cleaned)
    ) {
      typeTag = cleaned;
    }
  });

  // Address parsing: Maps usually formats "Via X 1, 32100 Comune BL"
  let zip: string | undefined;
  let city: string | undefined;
  let province: string | undefined;
  if (address) {
    const zipMatch = address.match(/\b(\d{5})\b/);
    if (zipMatch) zip = zipMatch[1];
    // Try "ZIP City PV" or "ZIP City (PV)"
    const cityMatch =
      address.match(/\d{5}\s+([^()]+?)\s+([A-Z]{2})\b/) ||
      address.match(/\d{5}\s+([^()]+?)\s*\(([A-Z]{2})\)/);
    if (cityMatch) {
      city = cityMatch[1].trim();
      province = cityMatch[2];
    }
  }
  if (!city && opts.cityHint) city = opts.cityHint;

  // Website
  let website: string | undefined;
  const websiteSelectors = ['a[data-value="Sito web"]', 'a[aria-label*="sito web" i]', 'a[aria-label*="Website" i]'];
  for (const sel of websiteSelectors) {
    const href = $card.find(sel).first().attr('href');
    if (href && href.startsWith('http')) {
      website = href;
      break;
    }
  }

  const lead: Lead = { company_name: name, source: 'MAPS', sources: ['MAPS'] };
  if (opts.category) lead.category = opts.category;
  if (address) lead.address = address;
  if (zip) lead.zip_code = zip;
  if (city) lead.city = city;
  if (province) lead.province = province;
  if (phone) lead.phone = phone;
  if (website) lead.website = website;
  if (mapsUrl) {
    lead.maps_url = mapsUrl;
    lead.source_url = mapsUrl;
  }
  if (opts.cityHint) lead.query_location = opts.cityHint;
  if (city && opts.cityHint && city !== opts.cityHint) lead.business_city = city;
  if (opts.category) lead.category_match = classifyCategoryMatch(opts.category, typeTag);
  if (permanentlyClosed) lead.permanently_closed = true;
  // Phase 4.4: same conservative mojibake strip as PG. Maps' DOM is
  // usually clean UTF-8 but occasional listing pages mirror PG's bad
  // bytes via review imports.
  return cleanMojibakeFields(lead, ['company_name', 'city', 'business_city', 'address']);
}

function collapse(s: string | undefined | null): string {
  if (!s) return '';
  return s.replace(/[\s ]+/g, ' ').trim();
}
