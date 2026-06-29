import { describe, it, expect } from 'vitest';
import { runEnrichmentPipeline } from '../../src/enrichment/enrichment_pipeline';
import { ProviderRouter } from '../../src/providers/provider_router';
import { createPerLeadContext, createRun } from '../../src/runtime/run_context';
import type { HttpProvider, HttpFetchResult, SerpProvider, SerpResult } from '../../src/types/providers';

/**
 * Phase 4.2.1 cost integration test.
 *
 * Validates that `lead.cost_eur` is sourced from the canonical CostLedger
 * (via `meta.lead_id`), not from in-memory stage counters that depended
 * on each stage remembering to populate `StageOutcome.cost_eur`. This is
 * the prerequisite for safely turning on paid providers (Serper, Exa,
 * Perplexity, OpenAI, Firecrawl, BrightData, Hunter).
 */

class StubHttp implements HttpProvider {
  id = 'stub_http';
  family = 'http' as const;
  tier = 0;
  costPerCallEur = 0;
  available() { return true; }
  async fetch(_url: string): Promise<HttpFetchResult> {
    return { status: 404, html: undefined, finalUrl: _url, duration_ms: 0, cost_eur: 0, provider: this.id, error: 'not found' };
  }
}

/** Simulates a paid SERP provider that costs €0.05 per call and returns a result. */
class PaidSerp implements SerpProvider {
  id = 'paid_serp';
  family = 'serp' as const;
  tier = 1;
  costPerCallEur = 0.05;
  callCount = 0;
  available() { return true; }
  async search(): Promise<SerpResult[]> {
    this.callCount += 1;
    return [{ title: 'fake', url: 'https://random-host-noresolve.invalid', snippet: '', rank: 1, source_provider: this.id }];
  }
}

const deadDns = async () => Promise.reject(new Error('ENOTFOUND'));

describe('lead.cost_eur is sourced from the CostLedger (per-lead)', () => {
  it('reflects the cost of every router call tagged with this lead_id', async () => {
    // Phase G — paid is default-deny in createRun, so the test must
    // opt in. Cost ceiling must be high enough to cover repeated
    // €0.05 paid SERP calls (multiple stages may invoke).
    const run = createRun({ paidEnabled: true, costCeilingEur: 1.0 });
    const paid = new PaidSerp();
    const router = new ProviderRouter([paid], [new StubHttp()], [], run.ledger);
    const lead = { company_name: 'Acme SRL', city: 'Milano', province: 'MI', vat_code: '12345678901', phone: '021', address: 'Via Roma 1' };
    const result = await runEnrichmentPipeline({
      run,
      perLead: createPerLeadContext(run),
      router,
      lead,
      dnsResolver: deadDns,
    });
    // SerpStage called the paid provider; the verifyCandidates fetch hit
    // StubHttp (cost 0). Final cost should equal the paid SERP call(s).
    expect(paid.callCount).toBeGreaterThanOrEqual(1);
    expect(result.lead.cost_eur).toBeCloseTo(0.05 * paid.callCount, 6);
    // The ledger and the lead must agree.
    expect(run.ledger.getTotal()).toBeCloseTo(result.lead.cost_eur ?? 0, 6);
  });

  it('isolates costs per lead via meta.lead_id', async () => {
    const run = createRun({ paidEnabled: true, costCeilingEur: 1.0 });
    const paid = new PaidSerp();
    const router = new ProviderRouter([paid], [new StubHttp()], [], run.ledger);
    const baseLead = { company_name: 'Acme SRL', city: 'Milano', province: 'MI', vat_code: '12345678901', phone: '021', address: 'Via Roma 1' };

    const r1 = await runEnrichmentPipeline({ run, perLead: createPerLeadContext(run), router, lead: { ...baseLead }, dnsResolver: deadDns });
    const r2 = await runEnrichmentPipeline({ run, perLead: createPerLeadContext(run), router, lead: { ...baseLead, company_name: 'Beta SPA' }, dnsResolver: deadDns });

    expect(r1.lead.cost_eur).toBeGreaterThan(0);
    expect(r2.lead.cost_eur).toBeGreaterThan(0);
    expect(run.ledger.getTotal()).toBeCloseTo((r1.lead.cost_eur ?? 0) + (r2.lead.cost_eur ?? 0), 6);
  });

  it('zero-cost run keeps lead.cost_eur === 0 (regression: free-only stays free)', async () => {
    const run = createRun();
    const router = new ProviderRouter([], [new StubHttp()], [], run.ledger);
    const lead = { company_name: 'Solo Nome' };
    const result = await runEnrichmentPipeline({ run, perLead: createPerLeadContext(run), router, lead });
    expect(result.lead.cost_eur).toBe(0);
  });
});
