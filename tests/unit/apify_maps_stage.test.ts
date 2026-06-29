import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApifyMapsStage } from '../../src/enrichment/stages/apify_maps_stage';
import { ApifyProvider } from '../../src/providers/apify/apify_provider';
import { resetEnvCache } from '../../src/config/env';
import type { ProviderRouter } from '../../src/providers/provider_router';
import type { PerLeadContext } from '../../src/types/enrichment';
import type { Lead } from '../../src/types/lead';
import type { NormalizedLead } from '../../src/types/discovery';

// A fake router that runs invoke()'s call when the meta is available (the real
// router's cost-gates are tested elsewhere; here we test the stage's fill logic).
const fakeRouter = {
  invoke: async (meta: { available: () => boolean }, call: () => Promise<{ ok: boolean; value: unknown } | null>) => {
    if (!meta.available()) return null;
    const r = await call();
    return r && r.ok ? r.value : null;
  },
} as unknown as ProviderRouter;

const ctxOf = (over: Partial<PerLeadContext> = {}): PerLeadContext =>
  ({ leadId: 'L1', runId: 'R1', costEur: 0, costCeilingEur: 0.1, runCostCeilingEur: 1, paidEnabled: true, providersUsed: new Set(), ...over } as unknown as PerLeadContext);

const NORM = {} as NormalizedLead;

function enableApify(): void {
  process.env.APIFY_ENABLED = 'true';
  process.env.APIFY_API_KEY = 'tok';
  process.env.APIFY_MAPS_ENABLED = 'true';
  resetEnvCache();
}

// Start every test from a CLEAN (disabled) state regardless of the operator's
// real .env (dotenv pre-seeds process.env; without this a live APIFY_ENABLED=true
// in .env would leak into the "skips when disabled" test).
function clearApifyEnv(): void {
  for (const k of ['APIFY_ENABLED', 'APIFY_API_KEY', 'APIFY_MAPS_ENABLED']) delete process.env[k];
  resetEnvCache();
}
beforeEach(clearApifyEnv);
afterEach(clearApifyEnv);

/** A provider whose Maps actor returns a fixed item via the injected HTTP post. */
function providerReturning(item: unknown): ApifyProvider {
  return new ApifyProvider(async () => ({ status: 200, json: item ? [item] : [] }));
}

describe('ApifyMapsStage', () => {
  it('skips cleanly when Apify is disabled', async () => {
    const stage = new ApifyMapsStage(fakeRouter, providerReturning(null));
    const out = await stage.run(ctxOf(), { company_name: 'Acme' } as Lead, NORM);
    expect(out.status).toBe('skipped');
    expect(out.detail).toBe('apify_maps_disabled');
  });

  it('fills rating/reviews/socials/website when the entity matches', async () => {
    enableApify();
    const stage = new ApifyMapsStage(
      fakeRouter,
      providerReturning({
        title: 'Immobiliare Acme',
        website: 'https://acme.it',
        phone: '049 111',
        totalScore: 4.3,
        reviewsCount: 57,
        instagrams: ['https://instagram.com/acme'],
      }),
    );
    const lead = { company_name: 'Immobiliare Acme', city: 'Padova' } as Lead;
    const out = await stage.run(ctxOf(), lead, NORM);
    expect(out.status).toBe('success');
    expect(lead.rating).toBe('4.3');
    expect(lead.reviews_count).toBe('57');
    expect(lead.instagram).toBe('https://instagram.com/acme');
    expect(lead.official_website).toBe('https://acme.it');
    expect(lead.website_discovery_method).toBe('MAPS_APIFY');
  });

  it('refuses a Maps place whose name is a different company (entity guard)', async () => {
    enableApify();
    const stage = new ApifyMapsStage(fakeRouter, providerReturning({ title: 'Tecnocasa Franchising SpA', totalScore: 4.9 }));
    const lead = { company_name: 'Immobiliare Bianchi', city: 'Padova' } as Lead;
    const out = await stage.run(ctxOf(), lead, NORM);
    expect(out.status).toBe('not_found');
    expect(out.detail).toContain('maps_entity_mismatch');
    expect(lead.rating).toBeUndefined();
  });

  it('does not overwrite an existing website (fill-only-missing)', async () => {
    enableApify();
    const stage = new ApifyMapsStage(fakeRouter, providerReturning({ title: 'Acme', website: 'https://maps-acme.it', totalScore: 4 }));
    const lead = { company_name: 'Acme', official_website: 'https://real-acme.it' } as Lead;
    await stage.run(ctxOf(), lead, NORM);
    expect(lead.official_website).toBe('https://real-acme.it');
    expect(lead.rating).toBe('4'); // but rating (which was empty) IS filled
  });
});
