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
 * R7.0 — paid SERP semantic-only veto.
 *
 * Same precision rule R6.1 introduced for PgDetailStage now applies
 * to the paid pass: only `verdict.method === 'piva' | 'phone'` may
 * set `official_website` with method=SERP_PAID. A semantic-only
 * match is rejected and the lead ends NOT_FOUND with no website
 * pinned. Side-effects on the lead are cleared.
 *
 * The PG audit lesson generalises: paid SERP returns aggregator and
 * directory pages whose body mentions the lead's brand as marketing
 * text (luxuryestate.com, casavenezia.it, …) — semantic match
 * accepts those at confidence 0.7-0.8, but they aren't the firm's
 * site.
 */

class StubFreeSerp implements SerpProvider {
  id = 'stub_free';
  family = 'serp' as const;
  tier = 0;
  costPerCallEur = 0;
  available() { return true; }
  async search(): Promise<SerpResult[]> {
    return []; // free pass empty → paid pass runs (assuming gate allows)
  }
}

class StubPaidSerp implements SerpProvider {
  id = 'serper';
  family = 'serp' as const;
  tier = 2;
  costPerCallEur = 0.001;
  callCount = 0;
  constructor(private candidate: string) {}
  available() { return true; }
  async search(): Promise<SerpResult[]> {
    this.callCount += 1;
    return [
      { title: 'x', url: this.candidate, snippet: '', rank: 1, source_provider: this.id },
    ];
  }
}

class StubHttp implements HttpProvider {
  id = 'stub_http';
  family = 'http' as const;
  tier = 0;
  costPerCallEur = 0;
  available() { return true; }
  constructor(private html: string) {}
  async fetch(url: string): Promise<HttpFetchResult> {
    return {
      status: 200,
      html: this.html,
      finalUrl: url,
      duration_ms: 0,
      cost_eur: 0,
      provider: this.id,
    };
  }
}

const deadDns = async () => Promise.reject(new Error('ENOTFOUND'));

describe('SerpStage paid pass — R7.0 semantic-only veto', () => {
  it('rejects SERP_PAID candidate when verify accepts only via semantic match', async () => {
    const run = createRun({ paidEnabled: true, costCeilingEur: 1.0, runCostCeilingEur: 0.20 });

    // The paid candidate body mentions the lead's BRAND + locality
    // strongly enough to fire PreVerifyGate's Layer A (long
    // distinctive brand "Pierobon Estimo Immobiliare", Padova). It
    // contains NEITHER the lead's vat nor phone — exactly the
    // luxuryestate.com / casavenezia.it failure mode.
    const longBrand = 'Pierobon Estimo Immobiliare';
    const aggregatorPage =
      `<html><head><title>${longBrand} Padova</title></head><body>` +
      `<h1>${longBrand}</h1><h2>${longBrand}</h2>` +
      `<p>${longBrand} agenzia immobiliare a Padova. Consulenza, compravendita, ` +
      `valutazione gratuita immobili a Padova. ${longBrand} opera a Padova da ` +
      `oltre vent'anni. Servizi offerti a Padova: gestione locazioni, vendita.</p>` +
      `</body></html>`;

    const free = new StubFreeSerp();
    const paid = new StubPaidSerp('https://random-aggregator.example/agencies/pierobon');
    const http = new StubHttp(aggregatorPage);
    const router = new ProviderRouter([free, paid], [http], [], run.ledger);

    const lead = {
      company_name: longBrand,
      city: 'Padova',
      // Lead vat / phone deliberately do NOT appear in the body.
      vat_code: '99999999999',
      phone: '049 0000000',
    };

    const r = await runEnrichmentPipeline({
      run,
      perLead: createPerLeadContext(run),
      router,
      lead,
      dnsResolver: deadDns,
    });

    // Gate allows (vat + phone signals present, brand multi-token).
    expect(paid.callCount).toBeGreaterThanOrEqual(1);

    // R7.0 invariant: rejected, no website, NOT_FOUND.
    expect(r.lead.official_website).toBeUndefined();
    expect(r.lead.website_discovery_method).toBeUndefined();
    expect(r.lead.website_confidence).toBeUndefined();
    expect(r.lead.status).toBe('NOT_FOUND');
  });

  it('ACCEPTS SERP_PAID when verify hits piva on the candidate site', async () => {
    const run = createRun({ paidEnabled: true, costCeilingEur: 1.0, runCostCeilingEur: 0.20 });
    const longBrand = 'Pierobon Estimo Immobiliare';
    // R9: page must clear sector-density ≥3 in addition to piva match.
    const realPage =
      `<html><body><h1>${longBrand}</h1>` +
      `<p>Agenzia immobiliare a Padova. Compravendita immobili, locazione ` +
      `appartamenti, intermediazione immobiliare. P.IVA 01234567890.</p>` +
      `<p>Via Roma 1, Padova. Vendita immobili, affitto, real estate.</p>` +
      `</body></html>`;
    const free = new StubFreeSerp();
    const paid = new StubPaidSerp('https://www.pierobonestimo.it');
    const http = new StubHttp(realPage);
    const router = new ProviderRouter([free, paid], [http], [], run.ledger);
    const lead = {
      company_name: longBrand,
      city: 'Padova',
      vat_code: '01234567890',
      phone: '049 1234567',
    };
    const r = await runEnrichmentPipeline({
      run,
      perLead: createPerLeadContext(run),
      router,
      lead,
      dnsResolver: deadDns,
    });
    expect(paid.callCount).toBeGreaterThanOrEqual(1);
    expect(r.lead.official_website).toBe('https://www.pierobonestimo.it');
    expect(r.lead.website_discovery_method).toBe('SERP_PAID');
    expect(r.lead.status).toBe('FOUND_WEBSITE_ONLY');
  });
});
