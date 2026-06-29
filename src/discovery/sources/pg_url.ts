/**
 * Pure URL builders for PagineGialle. Pure functions — no network, no
 * navigation, no browser. Live navigation lives in `pg_live.ts`.
 *
 * PG canonical search URLs use lowercase ASCII slugs separated by hyphens.
 * Italian diacritics, apostrophes, and any non-alphanumeric characters
 * collapse to a single hyphen and consecutive hyphens are coalesced.
 */

/**
 * Slugify an Italian-language token to PG's canonical hyphenated form:
 *   "Cortina d'Ampezzo"  → "cortina-d-ampezzo"
 *   "Reggio nell'Emilia" → "reggio-nell-emilia"
 *   "Centro Estetico"    → "centro-estetico"
 *   "Agenzie Immobiliari"→ "agenzie-immobiliari"
 */
export function pgSlug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')          // strip diacritics
    .toLowerCase()
    .replace(/['‘’`´]/g, ' ')         // apostrophe variants → space
    .replace(/[^a-z0-9]+/g, '-')      // anything non-alphanum → -
    .replace(/^-+|-+$/g, '')          // trim leading/trailing -
    .replace(/-{2,}/g, '-');          // collapse repeats
}

/**
 * Build the canonical PG search URL for `(category, location, page)`.
 * Page is 1-indexed (PG uses `/p-1`, `/p-2`, …).
 */
export function buildPgSearchUrl(category: string, location: string, page = 1): string {
  if (!category.trim()) throw new Error('buildPgSearchUrl: category is required');
  if (!location.trim()) throw new Error('buildPgSearchUrl: location is required');
  const p = Math.max(1, Math.floor(page));
  return `https://www.paginegialle.it/ricerca/${pgSlug(category)}/${pgSlug(location)}/p-${p}`;
}
