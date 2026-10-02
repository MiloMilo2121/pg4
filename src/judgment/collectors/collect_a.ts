import type { Lead } from '../../types/lead';
import type { Signal, SubdimKey } from '../../types/judgment';
import type { SerpResult } from '../../types/providers';
import { harvestSource } from '../harvest/source_harvest';
import type { HarvestContext, HarvestBundle } from '../harvest/source_harvest';
import { RegistrySourceAdapter } from '../harvest/adapters/registry_adapter';
import { PlacesSourceAdapter } from '../harvest/adapters/places_adapter';
import { registrableDomain } from '../../util/domain';
import { normalizeCompanyNameForKey, normalizeForKey } from '../../discovery/deduper';

/**
 * L3 A-collector — Axis A signals from THIRD-PARTY sources ONLY (registry,
 * places review CONTENT, press/awards via search). Imports NOTHING from the
 * B-collector and never touches an owned channel. COLLECTS, never judges.
 *
 * Hybrid split is enforced upstream (adapters stamp axis); here we additionally
 * FILTER to axis 'A' so an owned-channel signal can never leak into segnali_A.
 */

const SUBDIMS: SubdimKey[] = ['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7'];

const NAME_LEGAL_FORMS = new Set(['srl', 'srls', 'spa', 'snc', 'sas', 'sapa', 'ss', 'sc', 'scarl', 'scrl', 'soc', 'coop']);
const NAME_CONNECTIVES = new Set(['del', 'dei', 'della', 'delle', 'dello', 'degli', 'per', 'con', 'and', 'the']);
// Words that say what a company does, not which company it is: a name made
// only of these ("Costruzioni Generali") cannot identify a search hit.
const GENERIC_TRADE_TOKENS = new Set([
  'immobiliare', 'immobiliari', 'agenzia', 'studio', 'servizi', 'service', 'services', 'gruppo', 'group',
  'italia', 'italiana', 'italy', 'international', 'internazionale', 'costruzioni', 'generali', 'edilizia', 'edile',
  'impianti', 'impresa', 'industria', 'industrie', 'industriale', 'meccanica', 'officine', 'officina', 'sistemi',
  'tecnologie', 'tecnica', 'commerciale', 'trasporti', 'logistica', 'produzione', 'consulting', 'consulenza',
  'casa', 'home', 'real', 'estate', 'nord', 'sud', 'centro', 'nuova', 'nuovo',
]);

function distinctiveNameTokens(name: string): string[] {
  return normalizeCompanyNameForKey(name)
    .split(' ')
    .filter((t) => t.length > 2 && !NAME_LEGAL_FORMS.has(t) && !NAME_CONNECTIVES.has(t));
}

function nameMatchesHit(name: string, hitText: string): boolean {
  const tokens = distinctiveNameTokens(name);
  if (tokens.length === 0) return false;
  if (!tokens.some((t) => t.length >= 4 && !GENERIC_TRADE_TOKENS.has(t))) return false;
  const words = new Set(normalizeForKey(hitText).split(' '));
  return tokens.every((t) => words.has(t));
}

function urlKey(url: string): string {
  return url.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * When a search hit may become a `confirmed_present` A signal.
 *
 * The queries embed the company name, so almost every result carries it: a
 * name match alone proves nothing (the company's own "awards" page, or a
 * namesake in another city, both match). A hit counts only when all three hold:
 *  1. Third-party: its registrable domain is not the company's own site and its
 *     URL is not one of the company's own social profiles (those are owned
 *     channels, i.e. axis B).
 *  2. Name: every distinctive token of the name appears in the title/snippet,
 *     and at least one of them is not a generic trade word. A single-token name
 *     ("Blurebus") qualifies on that token alone, provided it is distinctive.
 *  3. Corroboration: something besides the name ties the hit to this company:
 *     its city, its province written as "(PD)", its VAT number, or its own
 *     domain named in the text.
 */
function isCorroboratedThirdPartyHit(lead: Lead, hit: SerpResult): boolean {
  const ownDomains = [lead.official_website, lead.website].map((w) => registrableDomain(w)).filter((d): d is string => !!d);
  const hitDomain = registrableDomain(hit.url);
  if (!hitDomain || ownDomains.includes(hitDomain)) return false;
  const hitUrl = urlKey(hit.url);
  const ownProfiles = [lead.instagram, lead.facebook, lead.linkedin, lead.tiktok, lead.youtube].filter((u): u is string => !!u).map(urlKey);
  if (ownProfiles.some((p) => hitUrl === p || hitUrl.startsWith(`${p}/`))) return false;

  const text = `${hit.title} ${hit.snippet}`;
  if (!nameMatchesHit(lead.company_name ?? '', text)) return false;

  const normText = ` ${normalizeForKey(text)} `;
  const cities = [lead.city, lead.business_city].map((c) => (c ? normalizeForKey(c) : '')).filter((c) => c.length > 2);
  if (cities.some((c) => normText.includes(` ${c} `))) return true;
  const province = lead.province?.trim();
  if (province && /^[a-z]{2}$/i.test(province) && new RegExp(`\\(\\s*${province}\\s*\\)`, 'i').test(text)) return true;
  const vat = (lead.vat_code_final ?? lead.vat_code ?? '').replace(/\D/g, '');
  if (vat.length === 11 && text.match(/(?<!\d)\d{11}(?!\d)/g)?.includes(vat)) return true;
  const lowerText = text.toLowerCase();
  return ownDomains.some((d) => new RegExp(`(^|[^a-z0-9.-])(www\\.)?${escapeRegExp(d)}($|[^a-z0-9-])`).test(lowerText));
}

export async function collectA(lead: Lead, ctx: HarvestContext, bundle: HarvestBundle): Promise<Signal[]> {
  const iso = new Date(ctx.now()).toISOString();
  const out: Signal[] = [];

  // registry (A spine) — cache-shared; entity-guarded inside the adapter.
  const registry = await harvestSource(new RegistrySourceAdapter(), lead, bundle, ctx);
  for (const s of registry.signals) if (s.axis === 'A') out.push(s);

  // places — review CONTENT/rating only (the A side of the hybrid).
  const places = await harvestSource(new PlacesSourceAdapter(), lead, bundle, ctx);
  for (const s of places.signals) if (s.axis === 'A') out.push(s);

  // press / awards / patents / historic-marks via search (third-party).
  if (ctx.search) {
    const name = (lead.company_name as string | undefined) ?? '';
    const queries: Array<{ q: string; dim: SubdimKey; label: string }> = [
      { q: `${name} premio OR riconoscimento OR award`, dim: '2.7', label: 'premio/riconoscimento' },
      { q: `${name} brevetto OR marchio registrato`, dim: '2.2', label: 'brevetto/marchio' },
      { q: `${name} marchio storico`, dim: '2.3', label: 'marchio storico' },
      { q: `${name} intervista OR rassegna stampa`, dim: '2.7', label: 'menzione stampa' },
    ];
    for (const item of queries) {
      let results;
      try {
        results = await ctx.search(item.q);
      } catch {
        continue; // breaker/transport → leave this dimension to the unknown fill below
      }
      const hit = results.find((r) => isCorroboratedThirdPartyHit(lead, r));
      if (hit) {
        out.push({ axis: 'A', key: item.dim, state: 'confirmed_present', value: item.label, evidence: [{ source: 'search', url: hit.url, excerpt: hit.title, observedAt: iso, confidence: 0.55 }], notes: `third-party: ${item.label}` });
      }
    }
  }

  // Coverage map: any subdimension with NO collected signal becomes an explicit
  // `unknown` (so the judge sees coverage and never reads a gap as weakness).
  const covered = new Set(out.map((s) => s.key));
  for (const dim of SUBDIMS) {
    if (!covered.has(dim)) out.push({ axis: 'A', key: dim, state: 'unknown_not_found', evidence: [], notes: 'no third-party source reached for this subdimension' });
  }
  return out;
}
