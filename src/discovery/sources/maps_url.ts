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
