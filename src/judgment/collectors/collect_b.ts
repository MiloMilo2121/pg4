import type { Lead } from '../../types/lead';
import type { Signal, Footprint } from '../../types/judgment';
import { harvestSource } from '../harvest/source_harvest';
import type { HarvestContext, HarvestBundle } from '../harvest/source_harvest';
import { WebsiteSourceAdapter } from '../harvest/adapters/website_adapter';
import { PlacesSourceAdapter } from '../harvest/adapters/places_adapter';
import { SocialSourceAdapter } from '../harvest/adapters/social_adapter';
import { AdLibrarySourceAdapter } from '../harvest/adapters/ad_library_adapter';

/**
 * L3 B-collector — Axis B signals from OWNED/garrisoned channels ONLY (website,
 * GBP completeness + review MANAGEMENT, social presence, ad presence). Imports
 * NOTHING from the A-collector. COLLECTS, never judges.
 *
 * §5.3.5 firewall: a surface whose FOOTPRINT channel is `unknown` becomes a
 * `unknown` B signal — NEVER `confirmed_absent`. Only a footprint
 * `confirmed_absent` (a serious search found nothing) may surface as absence.
 */

/** B surfaces this collector reasons about (subset of §3.1–3.15 that is observable). */
const B_SURFACES = ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '3.9', '3.10', '3.11', '3.12', '3.13', '3.14', '3.15'] as const;

export async function collectB(lead: Lead, ctx: HarvestContext, bundle: HarvestBundle, footprint?: Footprint): Promise<Signal[]> {
  const out: Signal[] = [];

  const website = await harvestSource(new WebsiteSourceAdapter(), lead, bundle, ctx);
  for (const s of website.signals) if (s.axis === 'B') out.push(s);

  const places = await harvestSource(new PlacesSourceAdapter(), lead, bundle, ctx);
  for (const s of places.signals) if (s.axis === 'B') out.push(s);

  const social = await harvestSource(new SocialSourceAdapter(), lead, bundle, ctx);
  for (const s of social.signals) if (s.axis === 'B') out.push(s);

  const adlib = await harvestSource(new AdLibrarySourceAdapter(), lead, bundle, ctx);
  for (const s of adlib.signals) if (s.axis === 'B') out.push(s);

  // Reconcile with footprint: a surface backed only by an `unknown` channel must
  // be `unknown` (firewall). Map footprint channels → surfaces.
  const footprintState = footprintSurfaceStates(footprint);

  const covered = new Set(out.map((s) => s.key));
  for (const surface of B_SURFACES) {
    if (covered.has(surface)) continue;
    const fp = footprintState[surface];
    if (fp === 'confirmed_absent') {
      out.push({ axis: 'B', key: surface, state: 'confirmed_absent', evidence: [], notes: 'footprint: serious search found this surface absent' });
    } else {
      out.push({ axis: 'B', key: surface, state: 'unknown_not_found', evidence: [], notes: 'no owned-channel signal observed' });
    }
  }
  return out;
}

/** Collapse footprint channels into per-surface states (for the firewall fill). */
function footprintSurfaceStates(footprint?: Footprint): Record<string, 'confirmed_present' | 'confirmed_absent' | 'unknown_not_found'> {
  const map: Record<string, 'confirmed_present' | 'confirmed_absent' | 'unknown_not_found'> = {};
  if (!footprint) return map;
  const ch = (c: string) => footprint.channels.find((x) => x.channel === c)?.state;
  const set = (surface: string, state?: 'confirmed_present' | 'confirmed_absent' | 'unknown_not_found') => {
    if (!state) return;
    // present wins; absent only if not already present; unknown is the floor
    if (map[surface] === 'confirmed_present') return;
    if (state === 'confirmed_present') map[surface] = 'confirmed_present';
    else if (state === 'confirmed_absent') map[surface] = 'confirmed_absent';
    else if (!map[surface]) map[surface] = 'unknown_not_found';
  };
  set('3.1', ch('website'));
  set('3.3', ch('gbp'));
  set('3.5', ch('instagram'));
  set('3.5', ch('facebook'));
  set('3.6', ch('tiktok'));
  set('3.7', ch('youtube'));
  set('3.8', ch('linkedin_company'));
  set('3.8', ch('linkedin_founder'));
  set('3.9', ch('marketplace'));
  set('3.10', ch('ecommerce'));
  set('3.11', ch('ad_library'));
  return map;
}
