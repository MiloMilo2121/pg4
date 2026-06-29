import { describe, it, expect } from 'vitest';
import { runEnrichmentPipeline } from '../../src/enrichment/enrichment_pipeline';
import { ProviderRouter } from '../../src/providers/provider_router';
import { createPerLeadContext, createRun } from '../../src/runtime/run_context';
import type {
  HttpProvider,
  HttpFetchResult,
  SerpProvider,
  SerpResult,
} from '../../src/types/providers';

/**
 * R4 — SmartSerperGate × SerpStage integration.
 *
 * The gate is the EARLIER veto layer in front of the paid pass.
 * These tests prove that when the gate denies, no paid SERP call is
 * issued — which is the load-bearing behaviour of R4 (precision
 * over recall, "Serper bisturi non rete da pesca").
 */

class StubHttp implements HttpProvider {
  id = 'stub_http';
  family = 'http' as const;
  tier = 0;
  costPerCallEur = 0;
  available() { return true; }
  async fetch(): Promise<HttpFetchResult> {
    return { status: 404, finalUrl: '', duration_ms: 0, cost_eur: 0, provider: this.id, error: 'not found' };
  }
}

class StubFreeSerp implements SerpProvider {
  id = 'stub_free';
  family = 'serp' as const;
  tier = 0;
  costPerCallEur = 0;
  callCount = 0;
  available() { return true; }
  async search(): Promise<SerpResult[]> {
    this.callCount += 1;
    return []; // empty so we always reach the paid pass when it's allowed
  }
}

class StubPaidSerp implements SerpProvider {
  id = 'serper';
  family = 'serp' as const;
  tier = 2;
  costPerCallEur = 0.001;
  callCount = 0;
  available() { return true; }
  async search(): Promise<SerpResult[]> {
    this.callCount += 1;
    return [
      { title: 'x', url: 'https://random-host.invalid', snippet: '', rank: 1, source_provider: this.id },
    ];
  }
}

const deadDns = async () => Promise.reject(new Error('ENOTFOUND'));

describe('SerpStage × SmartSerperGate', () => {
  it('does NOT call paid SERP when the lead has only a company name (gate denies)', async () => {
    const run = createRun({ paidEnabled: true, costCeilingEur: 1.0 });
    const free = new StubFreeSerp();
    const paid = new StubPaidSerp();
    const router = new ProviderRouter([free, paid], [new StubHttp()], [], run.ledger);
    // City makes the lead pass the pipeline's quality_score threshold
    // but city alone is NOT a "signal" in the gate's terms (we require
    // address+locality together, where address is a real street ≥6 chars).
    const lead = { company_name: 'Solo Nome S.r.l.', city: 'Padova' };
    const r = await runEnrichmentPipeline({
      run,
      perLead: createPerLeadContext(run),
      router,
      lead,
      dnsResolver: deadDns,
    });
    expect(free.callCount).toBeGreaterThanOrEqual(1); // free pass still runs
    expect(paid.callCount).toBe(0);                    // gate blocks paid
    expect(r.lead.cost_eur).toBe(0);
  });

  it('does NOT call paid SERP when the brand reduces to a COMMON_BARE_STEM', async () => {
    const run = createRun({ paidEnabled: true, costCeilingEur: 1.0 });
    const free = new StubFreeSerp();
    const paid = new StubPaidSerp();
    const router = new ProviderRouter([free, paid], [new StubHttp()], [], run.ledger);
    const lead = {
      // "Bloom" is in COMMON_BARE_STEMS (audit #15). Even with vat
      // and phone, the gate vetoes paid SERP.
      company_name: 'Bloom S.r.l.',
      city: 'Padova',
      vat_code: '01234567890',
      phone: '+39 049 1234567',
    };
    const r = await runEnrichmentPipeline({
      run,
      perLead: createPerLeadContext(run),
      router,
      lead,
      dnsResolver: deadDns,
    });
    expect(paid.callCount).toBe(0);
    expect(r.lead.cost_eur).toBe(0);
  });

  it('DOES call paid SERP when the gate allows (vat_code + locality)', async () => {
    const run = createRun({ paidEnabled: true, costCeilingEur: 1.0 });
    const free = new StubFreeSerp();
    const paid = new StubPaidSerp();
    const router = new ProviderRouter([free, paid], [new StubHttp()], [], run.ledger);
    const lead = {
      company_name: 'Pierobon Estimo Immobiliare',
      city: 'Padova',
      vat_code: '01234567890',
    };
    const r = await runEnrichmentPipeline({
      run,
      perLead: createPerLeadContext(run),
      router,
      lead,
      dnsResolver: deadDns,
    });
    expect(paid.callCount).toBeGreaterThanOrEqual(1);
    expect(r.lead.cost_eur).toBeCloseTo(0.001 * paid.callCount, 6);
  });
});
