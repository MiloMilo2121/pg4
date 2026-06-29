import type { Lead } from '../../../types/lead';
import type { Signal, EvidenceRef } from '../../../types/judgment';
import { companyNameMatches } from '../../../enrichment/fields/field_registry';
import type { SourceAdapter, HarvestContext, HarvestResult } from '../source_harvest';
import { SOURCE_TTL_DAYS } from '../routing';

/**
 * Social SourceAdapter — discovers social profiles via SEARCH when they are NOT
 * linked from the official site (the website adapter already harvests linked
 * profiles, which are the PRIMARY ownership proof). Profiles found via search are
 * weaker: emitted as B presence with LOWER confidence and brand-matched against
 * the company name (reusing the same `companyNameMatches` used for VAT precision).
 *
 * Reachability decided at harvest by `ctx.search`. No search → ok:false →
 * collector marks `unknown` (NOT absent). A channel is only `confirmed_absent`
 * after a serious search returned a non-empty, non-matching result set.
 */
const PLATFORMS: Array<{ host: string; surface: string }> = [
  { host: 'instagram.com', surface: '3.5' },
  { host: 'facebook.com', surface: '3.5' },
  { host: 'linkedin.com', surface: '3.8' },
  { host: 'tiktok.com', surface: '3.6' },
  { host: 'youtube.com', surface: '3.7' },
];

export class SocialSourceAdapter implements SourceAdapter {
  readonly kind = 'social' as const;
  readonly id = 'social_search';
  readonly tier = 1 as const;
  readonly costEur = 0;

  available(): boolean {
    return true; // capability; actual reachability needs ctx.search at harvest time
  }

  ttlDays(): number | null {
    return SOURCE_TTL_DAYS.social;
  }

  locate(lead: Lead): string | undefined {
    const name = lead.company_name as string | undefined;
    if (!name) return undefined;
    const city = (lead.city as string | undefined) ?? '';
    return `${name} ${city}`.trim();
  }

  async harvest(locator: string, ctx: HarvestContext): Promise<HarvestResult> {
    const iso = new Date(ctx.now()).toISOString();
    const base: HarvestResult = { source: this.kind, sourceId: this.id, locator, fetchedAt: iso, ok: false, attributes: {}, signals: [] };
    if (!ctx.search) return base; // can't search → unknown, never absent

    const brand = locator.split(/\s{2,}|,/)[0] || locator;
    const signals: Signal[] = [];
    const attributes: Record<string, string> = {};
    let anySearchRan = false;

    for (const p of PLATFORMS) {
      let results;
      try {
        results = await ctx.search(`${brand} site:${p.host}`);
      } catch {
        continue; // breaker/transport → leave this platform unknown
      }
      anySearchRan = true;
      const hit = results.find((r) => r.url.includes(p.host) && companyNameMatches(brand, `${r.title} ${r.snippet}`));
      const ev: EvidenceRef[] = hit ? [{ source: 'social_search', url: hit.url, excerpt: hit.title, observedAt: iso, confidence: 0.6 }] : [];
      if (hit) {
        signals.push({ axis: 'B', key: p.surface, state: 'confirmed_present', value: hit.url, evidence: ev, notes: 'found via search (candidate ownership, weaker than site link)' });
        if (p.host === 'instagram.com') attributes.instagram ??= hit.url;
        if (p.host === 'facebook.com') attributes.facebook ??= hit.url;
        if (p.host === 'linkedin.com') attributes.linkedin ??= hit.url;
      } else if (results.length > 0) {
        // serious search, non-empty, no brand match → confirmed_absent for THIS channel
        signals.push({ axis: 'B', key: p.surface, state: 'confirmed_absent', evidence: [{ source: 'social_search', excerpt: `searched ${p.host}, no brand-matching profile`, observedAt: iso, confidence: 0.5 }] });
      }
      // empty result set from a healthy provider → leave unknown (no signal)
    }

    return { source: this.kind, sourceId: this.id, locator, fetchedAt: iso, ok: anySearchRan, attributes, signals };
  }
}
