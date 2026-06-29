import type { Lead } from '../../types/lead';
import type { Footprint, ChannelFootprint, FootprintChannel, EvidenceState } from '../../types/judgment';
import { registrableDomain } from '../../enrichment/extract/extract_from_body';
import { classifyBusinessModel } from '../business_model';
import { harvestSource, emptyBundle } from '../harvest/source_harvest';
import type { HarvestContext, HarvestResult, HarvestBundle } from '../harvest/source_harvest';
import { WebsiteSourceAdapter } from '../harvest/adapters/website_adapter';
import { SocialSourceAdapter } from '../harvest/adapters/social_adapter';
import { PlacesSourceAdapter } from '../harvest/adapters/places_adapter';
import { AdLibrarySourceAdapter } from '../harvest/adapters/ad_library_adapter';

/**
 * L2 — Discovery refinement. Produces a structured Digital Footprint with a
 * THREE-STATE status per surface.
 *
 * CARDINAL RULE (the §5.3.5 firewall, enforced here): a channel is
 * `confirmed_absent` ONLY when `searchedSeriously === true`. A fetch/search that
 * failed, was skipped, or was unavailable yields `unknown_not_found` — NEVER
 * `confirmed_absent`, so a discovery failure can never become a "B low" signal.
 */

const ALL_CHANNELS: FootprintChannel[] = [
  'website',
  'instagram',
  'facebook',
  'linkedin_company',
  'linkedin_founder',
  'tiktok',
  'youtube',
  'gbp',
  'marketplace',
  'ecommerce',
  'ad_library',
];

function channel(
  channelName: FootprintChannel,
  state: EvidenceState,
  searchedSeriously: boolean,
  iso: string,
  extra: Partial<ChannelFootprint> = {},
): ChannelFootprint {
  // Invariant guard, defence-in-depth: never emit confirmed_absent without a serious search.
  const safeState: EvidenceState = state === 'confirmed_absent' && !searchedSeriously ? 'unknown_not_found' : state;
  return {
    channel: channelName,
    state: safeState,
    ownership: extra.ownership ?? 'na',
    searchedSeriously,
    confidence: extra.confidence ?? 0,
    url: extra.url,
    discoveryMethod: extra.discoveryMethod,
    evidence: extra.evidence,
    lastCheckedAt: iso,
  };
}

/** Find a B signal for a surface key in a harvest result (state + value). */
function surfaceSignal(res: HarvestResult | undefined, key: string, platformHint?: string) {
  if (!res || !res.ok) return undefined;
  return res.signals.find((s) => s.axis === 'B' && s.key === key && (!platformHint || String(s.value ?? '').includes(platformHint)));
}

/** Pure footprint assembly from harvest results (testable, no I/O). */
export function buildFootprint(lead: Lead, results: { website?: HarvestResult; social?: HarvestResult; places?: HarvestResult; adlib?: HarvestResult }, iso: string): Footprint {
  const { website: ws, social, places, adlib } = results;
  const site = (lead.official_website as string | undefined) || (lead.website as string | undefined);
  const resolvedDomain = registrableDomain(site);

  const channels: ChannelFootprint[] = [];

  // --- website ---
  if (ws && ws.ok) {
    channels.push(channel('website', 'confirmed_present', true, iso, { ownership: 'owned_confirmed', url: ws.locator, discoveryMethod: 'website_fetch', confidence: 0.9 }));
  } else if (site) {
    // had a candidate site but couldn't fetch/verify → unknown (not absent)
    channels.push(channel('website', 'unknown_not_found', false, iso, { ownership: 'candidate_unverified', url: site, discoveryMethod: 'input', confidence: 0.2 }));
  } else {
    channels.push(channel('website', 'unknown_not_found', false, iso, { discoveryMethod: 'none' }));
  }

  // --- socials linked from the site (PRIMARY ownership, watch-item #3) vs found via search ---
  const socialChased = !!social && social.ok;
  const platforms: Array<{ ch: FootprintChannel; attr: string; surface: string; host: string }> = [
    { ch: 'instagram', attr: 'instagram', surface: '3.5', host: 'instagram.com' },
    { ch: 'facebook', attr: 'facebook', surface: '3.5', host: 'facebook.com' },
    { ch: 'linkedin_company', attr: 'linkedin', surface: '3.8', host: 'linkedin.com' },
    { ch: 'tiktok', attr: 'tiktok', surface: '3.6', host: 'tiktok.com' },
    { ch: 'youtube', attr: 'youtube', surface: '3.7', host: 'youtube.com' },
  ];
  for (const p of platforms) {
    const ownedUrl = ws?.ok ? ws.attributes[p.attr] : undefined;
    if (ownedUrl) {
      channels.push(channel(p.ch, 'confirmed_present', true, iso, { ownership: 'owned_confirmed', url: ownedUrl, discoveryMethod: 'website_link', confidence: 0.85 }));
      continue;
    }
    const candUrl = social?.ok ? social.attributes[p.attr] : undefined;
    if (candUrl) {
      channels.push(channel(p.ch, 'confirmed_present', true, iso, { ownership: 'candidate_unverified', url: candUrl, discoveryMethod: 'social_search', confidence: 0.6 }));
      continue;
    }
    // serious search ran and explicitly found no brand-matching profile → absent
    const absentSig = social?.ok ? social.signals.find((s) => s.key === p.surface && s.state === 'confirmed_absent') : undefined;
    if (absentSig && socialChased) {
      channels.push(channel(p.ch, 'confirmed_absent', true, iso, { ownership: 'na', discoveryMethod: 'social_search', confidence: 0.5 }));
    } else {
      channels.push(channel(p.ch, 'unknown_not_found', false, iso, { discoveryMethod: socialChased ? 'social_search' : 'none' }));
    }
  }

  // linkedin_founder — needs a decision-maker name; out of MVP discovery scope → unknown.
  channels.push(channel('linkedin_founder', 'unknown_not_found', false, iso, { discoveryMethod: 'none' }));

  // --- gbp (places) ---
  const gbpSig = surfaceSignal(places, '3.3');
  if (gbpSig) channels.push(channel('gbp', 'confirmed_present', true, iso, { ownership: 'owned_confirmed', discoveryMethod: 'places_api', confidence: 0.8, evidence: gbpSig.evidence }));
  else channels.push(channel('gbp', 'unknown_not_found', false, iso, { discoveryMethod: places && places.ok ? 'places_api' : 'none' }));

  // --- ad_library (authoritative: absent is valid when queried) ---
  const adPresent = surfaceSignal(adlib, '3.11');
  const adAbsent = adlib?.ok ? adlib.signals.find((s) => s.key === '3.11' && s.state === 'confirmed_absent') : undefined;
  if (adPresent) channels.push(channel('ad_library', 'confirmed_present', true, iso, { discoveryMethod: 'ad_library', confidence: 0.8, evidence: adPresent.evidence }));
  else if (adAbsent) channels.push(channel('ad_library', 'confirmed_absent', true, iso, { discoveryMethod: 'ad_library', confidence: 0.7, evidence: adAbsent.evidence }));
  else channels.push(channel('ad_library', 'unknown_not_found', false, iso, { discoveryMethod: adlib && adlib.ok ? 'ad_library' : 'none' }));

  // --- ecommerce (from website markers) ---
  const ecomSig = surfaceSignal(ws, '3.10');
  if (ecomSig) channels.push(channel('ecommerce', 'confirmed_present', true, iso, { ownership: 'owned_confirmed', discoveryMethod: 'website_markers', confidence: 0.6, evidence: ecomSig.evidence }));
  else channels.push(channel('ecommerce', 'unknown_not_found', false, iso, { discoveryMethod: ws && ws.ok ? 'website_markers' : 'none' }));

  // --- marketplace (no dedicated adapter in MVP) → unknown ---
  channels.push(channel('marketplace', 'unknown_not_found', false, iso, { discoveryMethod: 'none' }));

  // stable order
  channels.sort((a, b) => ALL_CHANNELS.indexOf(a.channel) - ALL_CHANNELS.indexOf(b.channel));

  return {
    resolvedDomain,
    domainConfidence: ws && ws.ok ? 0.9 : site ? 0.3 : 0,
    businessModelHint: classifyBusinessModel(lead),
    channels,
  };
}

export interface DiscoveryOptions {
  chaseSocial?: boolean; // default true
}

/** Run L2 discovery: harvest the relevant sources (cache-first) then build the footprint. */
export async function runDiscovery(lead: Lead, ctx: HarvestContext, opts: DiscoveryOptions = {}, bundle: HarvestBundle = emptyBundle()): Promise<{ footprint: Footprint; bundle: HarvestBundle }> {
  const iso = new Date(ctx.now()).toISOString();
  const website = await harvestSource(new WebsiteSourceAdapter(), lead, bundle, ctx);
  const social = opts.chaseSocial === false ? undefined : await harvestSource(new SocialSourceAdapter(), lead, bundle, ctx);
  const places = await harvestSource(new PlacesSourceAdapter(), lead, bundle, ctx);
  const adlib = await harvestSource(new AdLibrarySourceAdapter(), lead, bundle, ctx);
  const footprint = buildFootprint(lead, { website, social, places, adlib }, iso);
  return { footprint, bundle };
}
