import { describe, expect, it } from 'vitest';
import type { Lead } from '../../../src/types/lead';
import type { HarvestContext } from '../../../src/judgment/harvest/source_harvest';
import { emptyBundle, harvestSource } from '../../../src/judgment/harvest/source_harvest';
import { RegistrySourceAdapter } from '../../../src/judgment/harvest/adapters/registry_adapter';
import type { OpenapiCompany } from '../../../src/providers/openapi_it/openapi_client';
import { InMemoryEnrichmentCache } from '../../../src/persistence/enrichment_cache';
import { CostLedger } from '../../../src/runtime/cost_ledger';
import { ProviderRouter } from '../../../src/providers/provider_router';
import { CALL_COST_EUR } from '../../../src/providers/pricing';

// 12345678903 passes the Italian P.IVA checksum, so locate() accepts it.
const VAT = '12345678903';

/** A registry client stand-in: counts calls and answers with a fixed record. */
function fakeClient(rec: OpenapiCompany | undefined) {
  const calls: string[] = [];
  return {
    calls,
    available: () => true,
    advancedByVat: async (vat: string | undefined) => {
      calls.push(String(vat));
      return rec;
    },
  };
}

function ctx(o: { paidEnabled: boolean; router?: ProviderRouter; cache?: InMemoryEnrichmentCache }): HarvestContext {
  return {
    tenantId: 't',
    cache: o.cache ?? new InMemoryEnrichmentCache(),
    fetcher: async () => undefined,
    paidEnabled: o.paidEnabled,
    router: o.router,
    now: () => 1_750_000_000_000,
  };
}

const lead = (company_name: string | undefined): Lead => ({ company_name: company_name as string, vat_code: VAT });

const ACME: OpenapiCompany = { vatCode: VAT, companyName: 'ACME MECCANICA S.R.L.', revenue: 4_200_000, employees: '25' };

describe('registry adapter — paid gate', () => {
  it('makes no registry call when paid is disabled', async () => {
    const client = fakeClient(ACME);
    const ledger = new CostLedger();
    const res = await harvestSource(new RegistrySourceAdapter(client), lead('Acme Meccanica Srl'), emptyBundle(), ctx({ paidEnabled: false, router: new ProviderRouter([], [], [], ledger) }));
    expect(client.calls).toHaveLength(0);
    expect(res.ok).toBe(false);
    expect(ledger.getTotal()).toBe(0);
  });

  it('makes no registry call without a router, even with paid enabled (no ledger, no spend)', async () => {
    const client = fakeClient(ACME);
    const res = await harvestSource(new RegistrySourceAdapter(client), lead('Acme Meccanica Srl'), emptyBundle(), ctx({ paidEnabled: true }));
    expect(client.calls).toHaveLength(0);
    expect(res.ok).toBe(false);
  });

  it('records the real openapi_advanced cost in the router ledger', async () => {
    const client = fakeClient(ACME);
    const ledger = new CostLedger();
    const adapter = new RegistrySourceAdapter(client);
    const res = await harvestSource(adapter, lead('Acme Meccanica Srl'), emptyBundle(), ctx({ paidEnabled: true, router: new ProviderRouter([], [], [], ledger) }));
    expect(client.calls).toEqual([VAT]);
    expect(res.ok).toBe(true);
    expect(adapter.costEur).toBe(CALL_COST_EUR.openapi_advanced);
    expect(adapter.tier).toBe(2);
    expect(ledger.getTotal()).toBeCloseTo(CALL_COST_EUR.openapi_advanced, 6);
    expect(ledger.getByProvider().openapi?.calls).toBe(1);
  });

  it('a run ceiling already reached blocks the call', async () => {
    const client = fakeClient(ACME);
    const ledger = new CostLedger();
    ledger.record('earlier', 'serp', 0.95, true);
    const c = ctx({ paidEnabled: true, router: new ProviderRouter([], [], [], ledger) });
    c.route = { runCostCeilingEur: 1 };
    await harvestSource(new RegistrySourceAdapter(client), lead('Acme Meccanica Srl'), emptyBundle(), c);
    expect(client.calls).toHaveLength(0);
  });
});

describe('registry adapter — entity guard fails closed', () => {
  const paid = () => ctx({ paidEnabled: true, router: new ProviderRouter([], [], [], new CostLedger()) });

  it('attaches firmographics when the registered name matches the lead', async () => {
    const res = await harvestSource(new RegistrySourceAdapter(fakeClient(ACME)), lead('Acme Meccanica Srl'), emptyBundle(), paid());
    expect(res.attributes.revenue).toBe('4200000');
    expect(res.signals.some((s) => s.axis === 'A' && s.key === '2.6')).toBe(true);
  });

  it('refuses a different legal entity (franchisor VAT on a local agency)', async () => {
    const franchisor: OpenapiCompany = { vatCode: VAT, companyName: 'TECNOCASA FRANCHISING S.P.A.', revenue: 58_024_680 };
    const res = await harvestSource(new RegistrySourceAdapter(fakeClient(franchisor)), lead('Agenzia Immobiliare Tecnocasa Albignasego'), emptyBundle(), paid());
    expect(res.attributes).toEqual({});
    expect(res.signals).toEqual([]);
  });

  it('refuses when the registry returns no name (cannot verify)', async () => {
    const res = await harvestSource(new RegistrySourceAdapter(fakeClient({ vatCode: VAT, revenue: 58_024_680 })), lead('Acme Meccanica Srl'), emptyBundle(), paid());
    expect(res.attributes).toEqual({});
    expect(res.signals).toEqual([]);
  });

  it('refuses when the lead has no company name (cannot verify)', async () => {
    const res = await harvestSource(new RegistrySourceAdapter(fakeClient(ACME)), lead(undefined), emptyBundle(), paid());
    expect(res.attributes).toEqual({});
    expect(res.signals).toEqual([]);
  });

  it('re-checks every lead on a cache hit: a shared VAT does not leak firmographics to another entity', async () => {
    const cache = new InMemoryEnrichmentCache();
    const router = new ProviderRouter([], [], [], new CostLedger());
    const client = fakeClient(ACME);
    const adapter = new RegistrySourceAdapter(client);
    const first = await harvestSource(adapter, lead('Acme Meccanica Srl'), emptyBundle(), ctx({ paidEnabled: true, router, cache }));
    expect(first.attributes.revenue).toBe('4200000');
    const second = await harvestSource(adapter, lead('Studio Commerciale Bianchi'), emptyBundle(), ctx({ paidEnabled: true, router, cache }));
    expect(client.calls).toHaveLength(1); // served from the cache, paid once
    expect(second.attributes).toEqual({});
    expect(second.signals).toEqual([]);
  });
});
