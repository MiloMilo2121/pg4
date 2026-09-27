import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApifyProvider, type ApifyHttpPost } from '../../src/providers/apify/apify_provider';
import { ApifyMapsStage } from '../../src/enrichment/stages/apify_maps_stage';
import { isMapsPlaceUrl } from '../../src/discovery/sources/maps_url';
import { resetEnvCache } from '../../src/config/env';
import type { ProviderRouter } from '../../src/providers/provider_router';
import type { PerLeadContext } from '../../src/types/enrichment';
import type { Lead } from '../../src/types/lead';
import type { NormalizedLead } from '../../src/types/discovery';

const fakeRouter = {
  invoke: async (meta: { available: () => boolean }, call: () => Promise<{ ok: boolean; value: unknown } | null>) => {
    if (!meta.available()) return null;
    const r = await call();
    return r && r.ok ? r.value : null;
  },
} as unknown as ProviderRouter;

const ctxOf = (): PerLeadContext =>
  ({ leadId: 'L1', runId: 'R1', costEur: 0, costCeilingEur: 0.1, runCostCeilingEur: 1, paidEnabled: true, providersUsed: new Set() } as unknown as PerLeadContext);

const NORM = {} as NormalizedLead;
const PLACE = 'https://www.google.com/maps/place/Immobiliare+Acme/@45.4,11.8,17z/data=abc';

function enableApify(): void {
  process.env.APIFY_ENABLED = 'true';
  process.env.APIFY_API_KEY = 'tok';
  process.env.APIFY_MAPS_ENABLED = 'true';
  resetEnvCache();
}
function clearEnv(): void {
  for (const k of ['APIFY_ENABLED', 'APIFY_API_KEY', 'APIFY_MAPS_ENABLED']) delete process.env[k];
  resetEnvCache();
}
beforeEach(clearEnv);
afterEach(clearEnv);

function capturingProvider(item: unknown): { provider: ApifyProvider; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const post: ApifyHttpPost = async (_url, body) => {
    bodies.push(body as Record<string, unknown>);
    return { status: 200, json: item ? [item] : [] };
  };
  return { provider: new ApifyProvider(post), bodies };
}

describe('isMapsPlaceUrl', () => {
  it('accepts only /maps/place/ URLs', () => {
    expect(isMapsPlaceUrl(PLACE)).toBe(true);
    expect(isMapsPlaceUrl('https://www.google.com/maps/search/agenzie+padova/?hl=it')).toBe(false);
    expect(isMapsPlaceUrl('https://acme.it/maps/place/x')).toBe(false);
    expect(isMapsPlaceUrl(undefined)).toBe(false);
    expect(isMapsPlaceUrl('')).toBe(false);
  });
});

describe('mapsLookup placeUrl', () => {
  it('uses startUrls (no text search) when a placeUrl is given', async () => {
    enableApify();
    const { provider, bodies } = capturingProvider({ title: 'Acme' });
    await provider.mapsLookup('Acme', 'Padova', { placeUrl: PLACE });
    expect(bodies[0].startUrls).toEqual([{ url: PLACE }]);
    expect(bodies[0].searchStringsArray).toBeUndefined();
  });

  it('falls back to the name+city text search without placeUrl', async () => {
    enableApify();
    const { provider, bodies } = capturingProvider({ title: 'Acme' });
    await provider.mapsLookup('Acme', 'Padova');
    expect(bodies[0].searchStringsArray).toEqual(['Acme Padova']);
    expect(bodies[0].startUrls).toBeUndefined();
  });
});

describe('ApifyMapsStage maps_url reuse', () => {
  it('passes the scraper-captured place URL to the actor', async () => {
    enableApify();
    const { provider, bodies } = capturingProvider({ title: 'Immobiliare Acme', totalScore: 4.5 });
    const stage = new ApifyMapsStage(fakeRouter, provider);
    const lead = { company_name: 'Immobiliare Acme', city: 'Padova', maps_url: PLACE } as Lead;
    const out = await stage.run(ctxOf(), lead, NORM);
    expect(out.status).toBe('success');
    expect(bodies[0].startUrls).toEqual([{ url: PLACE }]);
  });

  it('ignores a synthesized /maps/search/ URL (text search instead)', async () => {
    enableApify();
    const { provider, bodies } = capturingProvider({ title: 'Immobiliare Acme', totalScore: 4.5 });
    const stage = new ApifyMapsStage(fakeRouter, provider);
    const lead = { company_name: 'Immobiliare Acme', city: 'Padova', maps_url: 'https://www.google.com/maps/search/x/?hl=it' } as Lead;
    await stage.run(ctxOf(), lead, NORM);
    expect(bodies[0].searchStringsArray).toBeDefined();
    expect(bodies[0].startUrls).toBeUndefined();
  });

  it('keeps the entity guard on the placeUrl path (stale place → refused)', async () => {
    enableApify();
    const { provider } = capturingProvider({ title: 'Pizzeria Da Mario', totalScore: 4.9 });
    const stage = new ApifyMapsStage(fakeRouter, provider);
    const lead = { company_name: 'Immobiliare Acme', city: 'Padova', maps_url: PLACE } as Lead;
    const out = await stage.run(ctxOf(), lead, NORM);
    expect(out.status).toBe('not_found');
    expect(out.detail).toContain('maps_entity_mismatch');
    expect(lead.rating).toBeUndefined();
  });
});
