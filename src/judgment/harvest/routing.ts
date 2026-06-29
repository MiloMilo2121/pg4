import type { Axis } from '../../types/judgment';
import type { SourceKind } from './source_harvest';

/**
 * Attribute↔source and signal↔axis routing — DATA, not code (mirrors the
 * "FIELD_REGISTRY is DATA not code" discipline). The harvester consults these to
 * decide which source to (cache-first) fetch for a request and which downstream
 * consumer reads which HarvestResult.
 *
 * NOTE on the same physical source feeding BOTH axes: e.g. `social` can feed a B
 * signal ("does the firm post on its OWN profile, how recently") AND, via search,
 * an A-adjacent signal. The resulting `Signal.axis` is stamped at build time by
 * the collector, so A and B never merge even when sourced from one fetch.
 */

/** Which sources can yield which attribute, in preference (cheapest-first) order. */
export const ATTRIBUTE_SOURCE_ROUTES: Record<string, SourceKind[]> = {
  email: ['website'],
  pec: ['website', 'registry'],
  instagram: ['website', 'social'],
  facebook: ['website', 'social'],
  linkedin: ['website', 'social'],
  vat: ['website', 'registry'],
  revenue: ['registry'],
  employees: ['registry'],
  address: ['maps_gbp', 'registry', 'website'],
};

/** Which sources feed which axis of signals. A and B kept explicitly separate. */
export const SIGNAL_SOURCE_ROUTES: Record<Axis, SourceKind[]> = {
  // A = third-party only. (Reviews CONTENT via places; registry; press/awards via search.)
  A: ['registry', 'maps_gbp'],
  // B = owned channels only. (Website; review MANAGEMENT via places; ads; social presence.)
  B: ['website', 'maps_gbp', 'social', 'ad_library'],
};

/** Default per-kind cache TTL (days). null = never expires (registry facts). */
export const SOURCE_TTL_DAYS: Record<SourceKind, number | null> = {
  registry: null, // firmographics don't change
  website: 7,
  maps_gbp: 14,
  social: 14,
  ad_library: 3, // ad cadence is volatile (§3.11)
};
