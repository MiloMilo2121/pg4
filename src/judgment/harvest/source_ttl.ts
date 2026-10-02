import type { SourceKind } from './source_harvest';

/** Default per-kind cache TTL (days). null = never expires (registry facts). */
export const SOURCE_TTL_DAYS: Record<SourceKind, number | null> = {
  registry: null, // firmographics don't change
  website: 7,
  maps_gbp: 14,
  social: 14,
  ad_library: 3, // ad cadence is volatile
};
