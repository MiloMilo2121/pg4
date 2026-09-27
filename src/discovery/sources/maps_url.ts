/**
 * Pure URL builder for Google Maps search. No network, no browser.
 * Live navigation in `maps_live.ts`.
 */

export function buildMapsSearchUrl(category: string, location: string): string {
  if (!category.trim()) throw new Error('buildMapsSearchUrl: category is required');
  if (!location.trim()) throw new Error('buildMapsSearchUrl: location is required');
  // Google Maps' search endpoint joins category + location with a single "+".
  // We URL-encode so accented or apostrophe-bearing locations survive.
  const q = encodeURIComponent(`${category.trim()} ${location.trim()}`);
  return `https://www.google.com/maps/search/${q}/?hl=it`;
}

/**
 * True only for a PLACE-specific Maps URL (captured by the scraper from a
 * card click, `/maps/place/…`) — never for the synthesized `/maps/search/…`
 * query URLs built above. Distinguishes "we know the exact listing" (usable
 * as an Apify startUrl) from "we only know what we searched".
 */
export function isMapsPlaceUrl(url: string | undefined): boolean {
  const u = parseGoogleUrl(url);
  return !!u && !u.hostname.startsWith('maps.') && u.pathname.startsWith('/maps/place/');
}

/** Any Google-Maps URL (listing, search, `maps.google.*`) — never a business's own site. */
export function isGoogleMapsUrl(url: string | undefined): boolean {
  const u = parseGoogleUrl(url);
  return !!u && (u.hostname.startsWith('maps.') || u.pathname === '/maps' || u.pathname.startsWith('/maps/'));
}

/**
 * Google's own hosts only: google.<cc>, google.com.<cc>, google.co.<cc>, with
 * an optional `www.`/`maps.` prefix. Anchored on the full hostname, so
 * `google.com.evil.io` or `notgoogle.it` never pass.
 */
const GOOGLE_HOST_RE = /^(?:www\.|maps\.)?google\.(?:[a-z]{2,3}|com\.[a-z]{2}|co\.[a-z]{2})$/i;

function parseGoogleUrl(url: string | undefined): URL | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const u = new URL(url.trim());
    return /^https?:$/.test(u.protocol) && GOOGLE_HOST_RE.test(u.hostname) ? u : undefined;
  } catch {
    return undefined;
  }
}
