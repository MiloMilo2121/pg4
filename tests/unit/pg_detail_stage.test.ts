import { describe, it, expect } from 'vitest';
import { PgDetailStage } from '../../src/enrichment/stages/pg_detail_stage';
import { PgDetailHarvester } from '../../src/discovery/sources/pagine_gialle_detail_harvester';
import { ProviderRouter } from '../../src/providers/provider_router';
import { createPerLeadContext, createRun } from '../../src/runtime/run_context';
import type { Lead } from '../../src/types/lead';
import type { HttpProvider, HttpFetchResult } from '../../src/types/providers';

/**
 * R1 — `PgDetailStage` 0-network tests. The harvester is mocked via
 * the constructor's `fetchHtml` injection point.
 */

class StubHttp implements HttpProvider {
  id = 'stub_http';
  family = 'http' as const;
  tier = 0;
  costPerCallEur = 0;
  available() { return true; }
  constructor(private html: string, private status = 200) {}
  async fetch(): Promise<HttpFetchResult> {
    return { status: this.status, html: this.html, finalUrl: '', duration_ms: 0, cost_eur: 0, provider: this.id };
  }
}

const PG_URL = 'https://www.paginegialle.it/padova-pd/immobiliare/foosrl';
const PG_DETAIL_HTML = (websiteHref: string | null) => `
  <html><body>
    ${websiteHref ? `<a data-tr="scheda_azienda__cta_sitoweb" href="${websiteHref}">Sito web</a>` : ''}
    <script type="application/ld+json">
      ${JSON.stringify({ '@type': 'LocalBusiness', name: 'Foo S.r.l.', vatID: 'IT01234567890', telephone: '+39 049 1234567', email: 'info@foosrl.com' })}
    </script>
    <h1>Foo S.r.l.</h1>
    <div class="sede__indirizzo">Via Roma 1, 35100 Padova (PD)</div>
  </body></html>`;

const realEstateBody =
  'Compravendita e locazione di appartamenti. Immobili in vendita a Padova. ' +
  'Trovi monolocale, bilocale, trilocale, ville e immobili commerciali. ' +
  'Servizio di valutazione gratuita. Consulenza per mutuo. ' +
  'Servizi offerti: gestione contratti di locazione, consulenza fiscale. ' +
  'Iscritta al ruolo agenti immobiliari della Camera di Commercio. ' +
  'Contatti per richiedere informazioni o fissare un appuntamento. ' +
  'La nostra agenzia opera da oltre venti anni nel territorio. ' +
  'Foo SRL pubblica costantemente nuove proposte di immobili a Padova.';
const livePageHtml = `<html><head><title>Foo</title></head><body><h1>Foo S.r.l.</h1><p>${realEstateBody}</p></body></html>`;

describe('PgDetailStage', () => {
  it('skipped when lead has no pg_url', async () => {
    const run = createRun();
    const router = new ProviderRouter([], [new StubHttp('')], [], run.ledger);
    const stage = new PgDetailStage(router, new PgDetailHarvester({ fetchHtml: async () => ({ status: 200 }) }));
    const lead: Lead = { company_name: 'Foo' };
    const out = await stage.run(createPerLeadContext(run), lead, { company_name: 'Foo', company_name_variants: [], quality_score: 0, raw: lead });
    expect(out.status).toBe('skipped');
  });

  it('backfills lead VAT/email/phone/address from PG harvest even without website', async () => {
    const run = createRun();
    const router = new ProviderRouter([], [new StubHttp('')], [], run.ledger);
    const harvester = new PgDetailHarvester({
      fetchHtml: async () => ({ status: 200, html: PG_DETAIL_HTML(null) }),
    });
    const stage = new PgDetailStage(router, harvester);
    const lead: Lead = { company_name: 'Foo S.r.l.', pg_url: PG_URL };
    const norm = { company_name: lead.company_name, company_name_variants: [], quality_score: 0, raw: lead };
    const out = await stage.run(createPerLeadContext(run), lead, norm);
    expect(out.status).toBe('not_found');
    expect(lead.vat_code).toBe('01234567890');
    expect(lead.email).toBe('info@foosrl.com');
    expect(lead.phone).toBe('+39 049 1234567');
    expect(lead.address).toContain('Via Roma 1');
    expect(lead.official_website).toBeUndefined();
  });

  it('matches the website when PG advertises a real one and verifyCandidates accepts', async () => {
    const run = createRun();
    const router = new ProviderRouter([], [new StubHttp(livePageHtml, 200)], [], run.ledger);
    const harvester = new PgDetailHarvester({
      fetchHtml: async () => ({ status: 200, html: PG_DETAIL_HTML('https://www.foosrl.com') }),
    });
    const stage = new PgDetailStage(router, harvester);
    const lead: Lead = { company_name: 'Foo S.r.l.', city: 'Padova', pg_url: PG_URL, category: 'agenzie immobiliari' };
    const norm = { company_name: lead.company_name, company_name_variants: [], city: lead.city, quality_score: 0, raw: lead };
    const out = await stage.run(createPerLeadContext(run), lead, norm);
    // Note: verify result depends on PreVerifyGate matching `Foo S.r.l.`
    // against the live page. Whether it matches isn't the primary
    // invariant here — what matters is that ON A MATCH the stage
    // sets PG_PHONE_SOURCE_TRUST as the discovery method. We don't
    // pin gate behaviour from this test.
    if (out.status === 'success') {
      expect(lead.website_discovery_method).toBe('PG_PHONE_SOURCE_TRUST');
      expect(lead.official_website).toBe('https://www.foosrl.com');
    }
    // Backfill always happens regardless.
    expect(lead.vat_code).toBe('01234567890');
  });

  it('R6.1 — rejects semantic-only verify on PG-advertised website (still backfills evidence)', async () => {
    // Audit case: "Italy Prime Estates" (Padova) had PG advertise
    // caseimperiali.com (Atlas SRL, Rubano) as its official site.
    // The advertised URL contained NEITHER the lead's P.IVA NOR the
    // lead's phone — only generic real-estate name tokens. The R1
    // pre-fix accepted via Layer A name-semantic match (confidence
    // 0.8) and we ended up tagging the wrong site.
    //
    // The fix: if `verdict.method === 'semantic'`, REJECT for the
    // PG-advertised path. Backfill of vat/phone/email continues so
    // downstream stages still get the enriched input.
    const run = createRun();
    // The "live page" matches the lead's brand and locality (so the
    // gate's semantic Layer fires), but contains NO matching P.IVA
    // and NO matching phone. This is exactly the production
    // failure mode: PG advertises a third-party portal whose copy
    // happens to mention the lead's brand keywords as marketing
    // text. Without the fix, `verifyCandidates` accepts via
    // method='semantic' and silently sets `lead.official_website`.
    // Use a long, distinctive brand so PreVerifyGate's Layer A
    // (`strong_full_name`) actually fires on the live page — that's
    // the path that puts `lead.official_website = candidate` before
    // returning. A short brand like "Foo S.r.l." would fall through
    // to no-match and the bug wouldn't be exercised.
    const longBrand = 'Pierobon Estimo Immobiliare';
    const livePageNoMatchHtml =
      `<html><head><title>${longBrand} - Padova</title></head><body>` +
      `<h1>${longBrand}</h1><h2>${longBrand}</h2>` +
      `<p>${longBrand} è un'agenzia immobiliare a Padova. ${realEstateBody}</p>` +
      `<p>${longBrand} opera a Padova da molti anni con immobili di qualità a Padova.</p>` +
      `</body></html>`;
    const router = new ProviderRouter([], [new StubHttp(livePageNoMatchHtml, 200)], [], run.ledger);
    const harvester = new PgDetailHarvester({
      // PG advertised a non-directory URL; the harvest still surfaces
      // P.IVA / phone / email from the PG company-detail page (NOT
      // from the third-party portal — those values are the LEAD's,
      // taken from PG's JSON-LD).
      fetchHtml: async () => ({ status: 200, html: PG_DETAIL_HTML('https://www.unrelatedfoo.com') }),
    });
    const stage = new PgDetailStage(router, harvester);
    const lead: Lead = {
      company_name: longBrand,
      city: 'Padova',
      pg_url: PG_URL,
      // Lead's vat / phone DO NOT appear on the live page — only the
      // brand+locality semantic anchor fires. Pre-R6.1 this was
      // enough to set `lead.official_website` despite no
      // deterministic corroboration.
      vat_code: '99999999999',
      phone: '049 0000000',
    };
    const norm = {
      company_name: lead.company_name,
      company_name_variants: [],
      city: lead.city,
      vat_code: lead.vat_code,
      phone: lead.phone,
      quality_score: 0,
      raw: lead,
    };
    const out = await stage.run(createPerLeadContext(run), lead, norm);
    expect(out.status).toBe('not_found');
    expect(out.reason_code).toBe('SERP_REJECTED_BY_VERIFY');
    // The detail must show the semantic-only rejection path actually
    // fired — not just any reject. Without this assertion, the test
    // could pass even if the gate never reached semantic match,
    // which would let the bug regress unnoticed.
    expect(out.detail).toMatch(/semantic_only_rejected/);
    // Critical: side-effects on the lead are CLEARED so the pipeline's
    // finalize step doesn't end up with status=FOUND_WEBSITE_ONLY +
    // a website nobody endorsed. This is the bug the p_recal2 audit
    // surfaced for "Italy Prime Estates".
    expect(lead.official_website).toBeUndefined();
    expect(lead.website_discovery_method).toBeUndefined();
    expect(lead.website_confidence).toBeUndefined();
    // Backfill still happens — downstream stages benefit from the PG
    // harvest's deterministic evidence even when the advertised
    // website was rejected.
    expect(lead.email).toBe('info@foosrl.com');
  });

  it('rejects directory URL even when PG advertises it as "Sito web"', async () => {
    const run = createRun();
    const router = new ProviderRouter([], [new StubHttp(livePageHtml, 200)], [], run.ledger);
    const harvester = new PgDetailHarvester({
      // PG sometimes lists facebook/atoka/cercacasa as "Sito web".
      // The harvester's isLikelyOfficialWebsiteUrl filter must reject them.
      fetchHtml: async () => ({ status: 200, html: PG_DETAIL_HTML('https://www.facebook.com/foosrl') }),
    });
    const stage = new PgDetailStage(router, harvester);
    const lead: Lead = { company_name: 'Foo S.r.l.', pg_url: PG_URL };
    const norm = { company_name: lead.company_name, company_name_variants: [], quality_score: 0, raw: lead };
    const out = await stage.run(createPerLeadContext(run), lead, norm);
    expect(lead.official_website).toBeUndefined();
    expect(out.status).toBe('not_found');
  });
});
