import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';
import type { PerLeadContext, Stage } from '../../types/enrichment';
import type { StageOutcome } from '../../types/output';
import { DiscoveryMethod } from '../../types/output';
import type { ProviderRouter } from '../../providers/provider_router';
import { ApifyProvider } from '../../providers/apify/apify_provider';
import { companyNameMatches } from '../fields/field_registry';

/**
 * Apify Google-Maps enrichment stage. PAID (tier 2), default-OFF. Runs AFTER the
 * website ladder. Maps uniquely supplies, for IT SMBs, what the site rarely
 * declares: **rating + reviews_count** (the judgment A-axis, historically
 * `unknown`), plus website (recall) / phone / instagram / facebook.
 *
 * Cost-safe: goes through `router.invoke` so the SAME paid-gate / per-lead budget
 * / run-ceiling / breaker / ledger apply. Entity-guarded by `companyNameMatches`
 * (a Maps place with a different name is refused). Never throws — degrades to a
 * `skipped`/`not_found` outcome.
 */
export class ApifyMapsStage implements Stage {
  readonly name = 'apify_maps';

  constructor(private router: ProviderRouter, private provider: ApifyProvider = new ApifyProvider()) {}

  async run(ctx: PerLeadContext, lead: Lead, _normalized: NormalizedLead): Promise<StageOutcome> {
    const start = Date.now();
    const meta = this.provider.meta('maps');
    if (!meta.available()) return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'apify_maps_disabled' };
    // Nothing new to gain if we already have website + rating + phone.
    if (lead.official_website && lead.rating && lead.phone) {
      return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'already_complete' };
    }

    const name = (lead.company_name as string | undefined) ?? '';
    const city = (lead.city as string | undefined) ?? (lead.business_city as string | undefined) ?? (lead.query_location as string | undefined);
    const remaining = (ctx.costCeilingEur ?? 0) - ctx.costEur;

    const place = await this.router.invoke(
      meta,
      async () => {
        const p = await this.provider.mapsLookup(name, city, { timeoutMs: 60_000 });
        return p ? { ok: true, value: p } : null;
      },
      {
        paidEnabled: ctx.paidEnabled === true,
        remainingLeadBudgetEur: remaining,
        runCostCeilingEur: ctx.runCostCeilingEur,
        meta: { lead_id: ctx.leadId, run_id: ctx.runId ?? '', stage: this.name },
      },
    );

    if (!place) return { stage: this.name, status: 'not_found', duration_ms: Date.now() - start, detail: 'no_maps_match_or_gated' };
    // Entity guard — a Maps place with a clearly different name is a wrong match.
    if (place.name && !companyNameMatches(place.name, name)) {
      return { stage: this.name, status: 'not_found', duration_ms: Date.now() - start, provider: meta.id, detail: `maps_entity_mismatch:${place.name}` };
    }

    const filled: string[] = [];
    const fill = (k: keyof Lead, v: string | undefined): void => {
      if (v && (lead[k] === undefined || lead[k] === null || lead[k] === '')) {
        (lead as Record<string, unknown>)[k as string] = v;
        filled.push(k as string);
      }
    };
    fill('rating', place.rating);
    fill('reviews_count', place.reviews_count);
    fill('instagram', place.instagram);
    fill('facebook', place.facebook);
    fill('phone', place.phone);
    if (place.website && (lead.official_website === undefined || lead.official_website === '')) {
      lead.official_website = place.website.startsWith('http') ? place.website : `https://${place.website}`;
      lead.website_discovery_method = DiscoveryMethod.MAPS_APIFY;
      lead.website_confidence = 0.75; // Google-verified listing + entity-name match
      filled.push('official_website');
    }

    return {
      stage: this.name,
      status: filled.length > 0 ? 'success' : 'not_found',
      duration_ms: Date.now() - start,
      provider: meta.id,
      detail: filled.length > 0 ? `filled=${filled.join(',')}` : 'no_new_fields',
    };
  }
}
