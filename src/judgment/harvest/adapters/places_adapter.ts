import type { Lead } from '../../../types/lead';
import type { Signal, EvidenceRef } from '../../../types/judgment';
import { getEnv } from '../../../config/env';
import type { SourceAdapter, HarvestContext, HarvestResult } from '../source_harvest';
import { SOURCE_TTL_DAYS } from '../routing';

/**
 * Google Places SourceAdapter — the OFFICIAL source for Maps/GBP/reviews/hours
 * (plan §19: official API over Maps HTML scraping). HYBRID: review CONTENT/rating
 * → Axis A (§2.4); GBP completeness + review MANAGEMENT (responses/recency) →
 * Axis B (§3.3/§3.4). Disabled by default (GOOGLE_PLACES_ENABLED).
 *
 * Watch-item #2: review MANAGEMENT (responses) is only PARTIALLY observable via
 * the official API. When a B aspect is not observable, this adapter LEAVES IT
 * OUT (→ collector marks it `unknown`) rather than asserting `confirmed_absent`.
 *
 * MIGRATED to the NEW Places API (addendum R5 — the legacy maps.googleapis.com
 * `textsearch/json` endpoint is deprecated): POST `places.googleapis.com/v1/places:searchText`
 * with `X-Goog-Api-Key` + a mandatory `X-Goog-FieldMask`. The FieldMask is scoped to the
 * fields we use (displayName, rating, userRatingCount, formattedAddress, businessStatus)
 * to control the billing SKU. Parses defensively; any failure → ok:false → `unknown`.
 */
const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = 'places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.businessStatus';

export class PlacesSourceAdapter implements SourceAdapter {
  readonly kind = 'maps_gbp' as const;
  readonly id = 'google_places';
  readonly tier = 2 as const;
  readonly costEur = 0.06; // New API Text Search (Pro) + rating field, €/call estimate

  available(): boolean {
    const e = getEnv();
    return e.GOOGLE_PLACES_ENABLED === true && typeof e.GOOGLE_PLACES_API_KEY === 'string' && e.GOOGLE_PLACES_API_KEY.length > 0;
  }

  ttlDays(): number | null {
    return SOURCE_TTL_DAYS.maps_gbp;
  }

  locate(lead: Lead): string | undefined {
    const name = lead.company_name as string | undefined;
    if (!name) return undefined;
    const city = (lead.city as string | undefined) ?? (lead.province as string | undefined) ?? '';
    return `${name} ${city}`.trim();
  }

  async harvest(locator: string, ctx: HarvestContext): Promise<HarvestResult> {
    const iso = new Date(ctx.now()).toISOString();
    const base: HarvestResult = { source: this.kind, sourceId: this.id, locator, fetchedAt: iso, ok: false, attributes: {}, signals: [] };
    if (!ctx.paidEnabled) return base; // tier-2: respect the paid gate
    const e = getEnv();
    const body = await ctx.fetcher(PLACES_SEARCH_URL, {
      method: 'POST',
      headers: {
        'X-Goog-Api-Key': e.GOOGLE_PLACES_API_KEY ?? '',
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: locator, languageCode: 'it', regionCode: 'IT' }),
    });
    if (!body) return base;
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return base;
    }
    const top = pickTopResult(json);
    if (!top) return base;

    const ev = (excerpt: string, c = 0.8): EvidenceRef[] => [{ source: 'google_places', url: PLACES_SEARCH_URL, excerpt, observedAt: iso, confidence: c }];
    const signals: Signal[] = [];
    const closed = top.businessStatus === 'CLOSED_PERMANENTLY';
    // A side — review CONTENT/rating (§2.4 perceived quality). A permanently-closed
    // business is not a live A signal — skip the positive rating assertion.
    if (!closed && typeof top.rating === 'number') {
      signals.push({ axis: 'A', key: '2.4', state: 'confirmed_present', value: top.rating, evidence: ev(`rating ${top.rating} (${top.userRatingCount ?? '?'} reviews)`) });
    }
    // B side — GBP presence/completeness (§3.3).
    signals.push({ axis: 'B', key: '3.3', state: 'confirmed_present', value: 'gbp_present', evidence: ev('GBP profile present') });
    // B side — review volume present (§3.4); MANAGEMENT/responses NOT exposed → left unknown.
    if (typeof top.userRatingCount === 'number') {
      signals.push({ axis: 'B', key: '3.4', state: 'confirmed_present', value: top.userRatingCount, evidence: ev(`${top.userRatingCount} reviews on GBP`), notes: 'volume only; responses/recency not observable via API (watch-item #2)' });
    }

    const attributes: Record<string, string> = {};
    if (top.formattedAddress) attributes.address = top.formattedAddress;
    if (top.businessStatus) attributes.business_status = top.businessStatus;
    return { source: this.kind, sourceId: this.id, locator, fetchedAt: iso, ok: true, attributes, signals, raw: json };
  }
}

interface PlaceTop {
  rating?: number;
  userRatingCount?: number;
  formattedAddress?: string;
  businessStatus?: string;
}

/** Parse the NEW Places API shape: { places: [{ displayName:{text}, rating, userRatingCount, ... }] }. Exposed for tests. */
export function pickTopResult(json: unknown): PlaceTop | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const places = (json as { places?: unknown }).places;
  if (!Array.isArray(places) || places.length === 0) return undefined;
  const r = places[0] as Record<string, unknown>;
  return {
    rating: typeof r.rating === 'number' ? r.rating : undefined,
    userRatingCount: typeof r.userRatingCount === 'number' ? r.userRatingCount : undefined,
    formattedAddress: typeof r.formattedAddress === 'string' ? r.formattedAddress : undefined,
    businessStatus: typeof r.businessStatus === 'string' ? r.businessStatus : undefined,
  };
}
