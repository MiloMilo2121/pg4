import { describe, it, expect } from 'vitest';
import { runEnrichmentPipeline } from '../../src/enrichment/enrichment_pipeline';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import { createPerLeadContext, createRun } from '../../src/runtime/run_context';
import type { HttpProvider, HttpFetchResult } from '../../src/types/providers';

class StubFetch implements HttpProvider {
  id = 'stub_fetch';
  family = 'http' as const;
  tier = 0;
  costPerCallEur = 0;
  constructor(private map: Record<string, string>) {}
  available() { return true; }
  async fetch(url: string): Promise<HttpFetchResult> {
    if (this.map[url] !== undefined) {
      return { status: 200, html: this.map[url], finalUrl: url, duration_ms: 1, cost_eur: 0, provider: this.id };
    }
    return { status: 404, html: undefined, finalUrl: url, duration_ms: 1, cost_eur: 0, provider: this.id, error: 'not in stub map' };
  }
}

// Default DNS mock for unit tests: every host is dead. Real DNS is forbidden
// in unit tests; the smoke suite covers live resolution.
const deadDns = async (_host: string) => Promise.reject(new Error('ENOTFOUND'));

describe('enrichment pipeline (vertical slice)', () => {
  it('produces a row with status + reason_code on EVERY input — happy path PIVA match', async () => {
    const run = createRun();
    const ledger = new CostLedger();
    const stub = new StubFetch({
      'https://acme.it':
        '<html><head><title>Acme SRL</title></head><body>Acme SRL è una società italiana. P.IVA 12345678901, sede legale Milano. Contatti.</body></html>',
    });
    const router = new ProviderRouter([], [stub], [], ledger);
    const lead = { company_name: 'Acme SRL', city: 'Milano', province: 'MI', vat_code: '12345678901', website: 'https://acme.it' };
    const result = await runEnrichmentPipeline({ run, perLead: createPerLeadContext(run), router, lead, dnsResolver: deadDns });
    expect(result.lead.status).toBe('FOUND_WEBSITE_ONLY');
    expect(result.lead.reason_code).toBe('FOUND_WEBSITE_ONLY');
    expect(result.lead.official_website).toBe('https://acme.it');
    expect(result.lead.website_discovery_method).toBe('INPUT_PIVA_MATCH');
  });

  it('returns NOT_FOUND with INPUT_WEBSITE_NOT_VERIFIED when html does not match', async () => {
    const run = createRun();
    const ledger = new CostLedger();
    const stub = new StubFetch({
      'https://wrong.com':
        '<html><head><title>Random Site</title></head><body>This is a completely unrelated website with no matching information whatsoever to that company name.</body></html>',
    });
    const router = new ProviderRouter([], [stub], [], ledger);
    const lead = { company_name: 'Acme SRL', city: 'Milano', vat_code: '12345678901', website: 'https://wrong.com' };
    const result = await runEnrichmentPipeline({ run, perLead: createPerLeadContext(run), router, lead, dnsResolver: deadDns });
    expect(result.lead.status).toBe('NOT_FOUND');
    expect(result.lead.reason_code).toBe('INPUT_WEBSITE_NOT_VERIFIED');
    expect(result.lead.official_website).toBeUndefined();
  });

  it('skips low-quality input with INPUT_QUALITY_TOO_LOW', async () => {
    const run = createRun();
    const ledger = new CostLedger();
    const router = new ProviderRouter([], [], [], ledger);
    const lead = { company_name: 'Solo Nome' };
    const result = await runEnrichmentPipeline({ run, perLead: createPerLeadContext(run), router, lead, dnsResolver: deadDns });
    expect(result.lead.status).toBe('SKIPPED');
    expect(result.lead.reason_code).toBe('INPUT_QUALITY_TOO_LOW');
  });

  it('flags ERROR_INVALID_INPUT_ROW when ingestError is set', async () => {
    const run = createRun();
    const ledger = new CostLedger();
    const router = new ProviderRouter([], [], [], ledger);
    const result = await runEnrichmentPipeline({
      run,
      perLead: createPerLeadContext(run),
      router,
      lead: { company_name: '' },
      ingestError: 'Missing company_name',
    });
    expect(result.lead.status).toBe('ERROR');
    expect(result.lead.reason_code).toBe('ERROR_INVALID_INPUT_ROW');
  });

  it('rejects DIRECTORY_OR_SOCIAL website with INPUT_WEBSITE_DIRECTORY_OR_SOCIAL', async () => {
    const run = createRun();
    const ledger = new CostLedger();
    const router = new ProviderRouter([], [], [], ledger);
    const lead = { company_name: 'Acme', city: 'Milano', province: 'MI', phone: '021', vat_code: '12345678901', website: 'https://linkedin.com/company/acme' };
    const result = await runEnrichmentPipeline({ run, perLead: createPerLeadContext(run), router, lead, dnsResolver: deadDns });
    expect(result.lead.status).toBe('NOT_FOUND');
    expect(result.lead.reason_code).toBe('INPUT_WEBSITE_DIRECTORY_OR_SOCIAL');
  });

  it('every code path produces a duration_ms and providers_used array', async () => {
    const run = createRun();
    const ledger = new CostLedger();
    const router = new ProviderRouter([], [], [], ledger);
    const lead = { company_name: 'Solo Nome' };
    const result = await runEnrichmentPipeline({ run, perLead: createPerLeadContext(run), router, lead, dnsResolver: deadDns });
    expect(typeof result.lead.duration_ms).toBe('number');
    expect(Array.isArray(result.lead.providers_used)).toBe(true);
  });
});
