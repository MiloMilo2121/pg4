import type { Lead } from '../../types/lead';
import type { Signal, SubdimKey } from '../../types/judgment';
import { harvestSource } from '../harvest/source_harvest';
import type { HarvestContext, HarvestBundle } from '../harvest/source_harvest';
import { RegistrySourceAdapter } from '../harvest/adapters/registry_adapter';
import { PlacesSourceAdapter } from '../harvest/adapters/places_adapter';
import { companyNameMatches } from '../../enrichment/fields/field_registry';

/**
 * L3 A-collector — Axis A signals from THIRD-PARTY sources ONLY (registry,
 * places review CONTENT, press/awards via search). Imports NOTHING from the
 * B-collector and never touches an owned channel. COLLECTS, never judges.
 *
 * Hybrid split is enforced upstream (adapters stamp axis); here we additionally
 * FILTER to axis 'A' so an owned-channel signal can never leak into segnali_A.
 */

const SUBDIMS: SubdimKey[] = ['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7'];

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
      const hit = results.find((r) => companyNameMatches(name, `${r.title} ${r.snippet}`));
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
