import { PROVINCE_CODES, PROVINCE_COMUNI } from '../geo/italy_geo';

/**
 * Validation of the dashboard's scrape request before any of it reaches the
 * CLI argv. execFile takes an argv array (no shell), so quoting is not the
 * risk; the risk is a value the CLI's own parser reads as a flag
 * (`--category --enable-paid` turns paid on), so flag-like values are refused.
 */

/** Sanitise an operator string into a safe CLI argument value. */
function cleanArg(s: string): string {
  return String(s).replace(/[^\p{L}\p{N}\s.,'’&/-]/gu, '').trim().slice(0, 80);
}

type Rejection = { ok: false; status: 400 | 422; error: string };
type ParsedArg = { ok: true; value: string } | Rejection;

function parseCliValue(name: string, raw: unknown): ParsedArg {
  if (raw === undefined || raw === null || raw === '') return { ok: false, status: 422, error: `${name} is required` };
  if (typeof raw !== 'string') return { ok: false, status: 400, error: `${name} must be a string` };
  const value = cleanArg(raw);
  if (!value) return { ok: false, status: 422, error: `${name} is required` };
  if (value.startsWith('-')) return { ok: false, status: 400, error: `${name} must not start with "-"` };
  return { ok: true, value };
}

/**
 * The wizard lists provinces by name ("Vicenza"). The engine expands a province
 * CODE into its curated comuni; any other string is scraped as one location,
 * so "Vicenza" would cover the capital only. A capital name is turned into its
 * code only where that list exists, otherwise "Bergamo" would become a bare
 * "BG" location and cover less than the name does.
 */
function provinceArg(value: string): string {
  const upper = value.toUpperCase();
  if (PROVINCE_CODES.has(upper)) return upper;
  const lower = value.toLowerCase();
  for (const [code, comuni] of Object.entries(PROVINCE_COMUNI)) {
    if (comuni[0]?.toLowerCase() === lower) return code;
  }
  return value;
}

/** The capital is the first of a province's curated comuni; a bare name is already one location. */
function capitalOf(province: string): string {
  return PROVINCE_COMUNI[province]?.[0] ?? province;
}

function parseList(name: string, list: unknown, single: unknown): { ok: true; value: string[] } | Rejection {
  const raw = list !== undefined ? list : single !== undefined ? [single] : [];
  if (!Array.isArray(raw)) return { ok: false, status: 400, error: `${name} must be an array` };
  const out: string[] = [];
  for (const item of raw) {
    const v = parseCliValue(name, item);
    if (!v.ok) return v;
    out.push(v.value);
  }
  if (out.length === 0) return { ok: false, status: 422, error: `${name} is required` };
  return { ok: true, value: out };
}

/** Wizard sources the run CLI can honour: PagineGialle always runs, Maps via --maps. */
const RUNNABLE_SOURCES = new Set(['pg', 'maps']);
const WIZARD_SOURCES = new Set(['pg', 'maps', 'fi', 'oa']);

/**
 * Each run is a whole province (hours with Maps) and runs sequentially, so 20
 * runs is already more than a day of scraping; a bigger selection is refused
 * rather than queued for a week.
 */
const MAX_SCRAPE_RUNS = 20;

/**
 * The wizard's "Profondità". `rapido` scrapes the province's capital only, one
 * PagineGialle page (about a minute end to end: a live demo); `completo` and
 * `esteso` run the whole province as before.
 */
const DEPTHS = new Set(['rapido', 'completo', 'esteso']);

type ScrapeTarget = { category: string; province: string; comuni?: string; maxPages?: number };
export interface ScrapeRequest {
  targets: ScrapeTarget[];
  maps: boolean;
}

/**
 * Accepts `{ categories[], provinces[], sources[], depth? }` from the wizard, or the
 * older `{ category, province }` body (PagineGialle only). A source the CLI
 * cannot run is refused with 422, never silently skipped.
 */
export function parseScrapeRequest(body: Record<string, unknown>): { ok: true; value: ScrapeRequest } | Rejection {
  if (body.paidEnabled === true) {
    return { ok: false, status: 422, error: 'paid is not available from the dashboard scrape (free tiers only); use the CLI with --enable-paid' };
  }
  const categories = parseList('categories', body.categories, body.category);
  if (!categories.ok) return categories;
  const provinces = parseList('provinces', body.provinces, body.province);
  if (!provinces.ok) return provinces;

  const sources = body.sources ?? ['pg'];
  if (!Array.isArray(sources) || !sources.every((s) => typeof s === 'string')) {
    return { ok: false, status: 400, error: 'sources must be an array of strings' };
  }
  const unknown = sources.filter((s) => !WIZARD_SOURCES.has(s));
  if (unknown.length) return { ok: false, status: 422, error: `unknown sources: ${unknown.join(', ')}` };
  if (!sources.includes('pg')) {
    return { ok: false, status: 422, error: 'pg (PagineGialle) is the discovery source of every run and cannot be deselected' };
  }
  const unavailable = sources.filter((s) => !RUNNABLE_SOURCES.has(s));
  if (unavailable.length) {
    return {
      ok: false,
      status: 422,
      error: `${unavailable.join(', ')}: paid sources are not available from the dashboard scrape (free tiers only); use the CLI with --enable-paid`,
    };
  }

  const depth = body.depth ?? 'completo';
  if (typeof depth !== 'string' || !DEPTHS.has(depth)) {
    return { ok: false, status: 400, error: 'depth must be one of: rapido, completo, esteso' };
  }

  const targets: ScrapeTarget[] = [];
  for (const category of new Set(categories.value)) {
    for (const province of new Set(provinces.value.map(provinceArg))) {
      targets.push(depth === 'rapido' ? { category, province, comuni: capitalOf(province), maxPages: 1 } : { category, province });
    }
  }
  if (targets.length > MAX_SCRAPE_RUNS) {
    return { ok: false, status: 422, error: `selection too large (${targets.length} category × province runs); max ${MAX_SCRAPE_RUNS} per scrape job` };
  }
  return { ok: true, value: { targets, maps: sources.includes('maps') } };
}
