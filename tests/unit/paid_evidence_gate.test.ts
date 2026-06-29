import { describe, it, expect } from 'vitest';
import { evaluatePaidEvidence } from '../../src/discovery/website/paid_evidence_gate';
import type { Lead } from '../../src/types/lead';
import type { NormalizedLead } from '../../src/types/discovery';

/**
 * R9 — structural Paid Evidence Gate tests.
 *
 * The gate is two rules:
 *   1. aggregator detection — distinct vat count ≥ 4 → REJECT
 *   2. sector density        — sector-vocabulary matches < 3 → REJECT
 *
 * Negative cases (must REJECT) — modelled on R8.1 VR FPs.
 * Positive cases (must ACCEPT) — modelled on confirmed BL/PD/VR TPs.
 */

function makeNorm(p: Partial<NormalizedLead>): NormalizedLead {
  return {
    company_name: p.company_name ?? 'Foo S.r.l.',
    company_name_variants: p.company_name_variants ?? [],
    quality_score: 0.5,
    raw: {} as Lead,
    ...p,
  };
}

describe('evaluatePaidEvidence — REJECT (low sector density)', () => {
  it('rejects leather firm with passing immobiliare mention (babileather.it style)', () => {
    const html = `<html><head><title>Ba.Bi Leather - Pelletteria</title></head><body>
      <h1>Babileather - Produzione di pelli per arredamento</h1>
      <p>Da oltre quarant'anni produciamo pellame italiano di qualità per
      l'industria del mobile imbottito. La nostra divisione immobiliare
      gestisce alcuni immobili aziendali. P.IVA 02000000001.</p>
      <p>Pellame di vacchetta, nappa, fiore. Lavorazione artigianale. Stampa
      digitale su pelle.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(
      html,
      makeNorm({ company_name: 'Ba.Bi Immobiliare S.r.l.' }),
      { company_name: 'Ba.Bi Immobiliare S.r.l.' },
    );
    expect(r.allow).toBe(false);
    expect(r.reasons.find((x) => x.startsWith('sector_density_too_low'))).toBeDefined();
  });

  it('rejects engineering firm with no sector signal (ingebau.it style)', () => {
    const html = `<html><head><title>Ingebau - Engineering & Construction</title></head><body>
      <h1>INGEBAU s.r.l.</h1>
      <p>Engineering and construction management. Idraulica civile,
      strutture, ambiente. Progettazione di opere infrastrutturali.
      P.IVA 02000000002.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(
      html,
      makeNorm({ company_name: 'Ingebau S.a.s.' }),
      { company_name: 'Ingebau S.a.s.' },
    );
    expect(r.allow).toBe(false);
  });

  it('rejects print shop (tipsammartino.it style)', () => {
    const html = `<html><head><title>Tipolitografia Sammartino</title></head><body>
      <h1>Tipografia digitale e offset</h1>
      <p>Stampa offset, design grafico, brochure aziendali. Cataloghi e
      packaging stampati. P.IVA 02000000003.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(
      html,
      makeNorm({ company_name: 'Sammartino Immobiliare S.r.l.' }),
      { company_name: 'Sammartino Immobiliare S.r.l.' },
    );
    expect(r.allow).toBe(false);
  });

  it('rejects research council (cnr.it style)', () => {
    const html = `<html><head><title>CNR - Consiglio Nazionale Ricerche</title></head><body>
      <h1>Consiglio Nazionale delle Ricerche</h1>
      <p>Italian National Research Council. Scientific divisions:
      biomedicine, chemistry, earth sciences, engineering, physics,
      humanities. P.IVA 02000000004.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(html, makeNorm({}), { company_name: 'x' });
    expect(r.allow).toBe(false);
  });

  it('rejects govt project tracker (opencup.gov.it style)', () => {
    const html = `<html><head><title>OpenCUP - Codice Unico Progetto</title></head><body>
      <h1>OpenCUP - Investimenti pubblici</h1>
      <p>Codice unico per conoscere gli investimenti pubblici. PNRR.
      Tracciamento progetti pubblici. P.IVA 02000000005.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(html, makeNorm({}), { company_name: 'x' });
    expect(r.allow).toBe(false);
  });

  it('rejects educational association (univalpo.it style)', () => {
    const html = `<html><head><title>Libera Università Popolare Valpolicella</title></head><body>
      <h1>Università popolare - cultura permanente</h1>
      <p>Corsi di lingue, cultura generale, laboratori. Apartitica,
      aconfessionale, senza fini di lucro. Volontari, comunità,
      formazione. P.IVA 02000000006.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(html, makeNorm({}), { company_name: 'x' });
    expect(r.allow).toBe(false);
  });

  it('rejects video platform (youtube.com style)', () => {
    const html = `<html><head><title>YouTube</title></head><body>
      <h1>YouTube</h1>
      <p>Watch videos. Music, gaming, news, sports, education, entertainment.
      Subscribe, share, comment. P.IVA 02000000007.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(html, makeNorm({}), { company_name: 'x' });
    expect(r.allow).toBe(false);
  });

  it('rejects business-document aggregator (visure24.com style)', () => {
    const html = `<html><head><title>Visure24 - documenti ufficiali</title></head><body>
      <h1>Visure camerali e catastali</h1>
      <p>Visure aziendali, bilanci, dati catastali, certificati ufficiali
      direttamente dal registro imprese. P.IVA 02000000008.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(html, makeNorm({}), { company_name: 'x' });
    expect(r.allow).toBe(false);
  });
});

describe('evaluatePaidEvidence — REJECT (aggregator pattern)', () => {
  it('rejects real-estate aggregator with many distinct vats (casabitare.it style)', () => {
    // Sector density would be HIGH on this page (real-estate
    // vocabulary), but the aggregator-veto fires first.
    const html = `<html><head><title>CasaBitare - immobiliare in tutta Italia</title></head><body>
      <h1>CasaBitare - cerca casa</h1>
      <p>Annunci immobiliari, vendita appartamenti, locazione, compravendita,
      affitto. Agenzie partner: P.IVA 02000000020 02000000021 02000000022
      02000000023 02000000024 02000000025 02000000026.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(html, makeNorm({}), { company_name: 'x' });
    expect(r.allow).toBe(false);
    expect(r.reasons[0]).toMatch(/aggregator_many_vats/);
  });

  it('rejects multi-category marketplace with many vats (sihappy.it style)', () => {
    const html = `<html><head><title>SiHappy - Centro Commerciale Naturale</title></head><body>
      <h1>SìHappy marketplace</h1>
      <p>Ristoranti, fashion, tecnologia, immobiliare, servizi. Vendita
      affitto compravendita appartamenti. P.IVA 02000000010 02000000011
      02000000012 02000000013 02000000014.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(html, makeNorm({}), { company_name: 'x' });
    expect(r.allow).toBe(false);
  });
});

describe('evaluatePaidEvidence — ACCEPT (high sector density)', () => {
  it('accepts a real agency homepage (studiozetapadova.it style)', () => {
    const html = `<html><head><title>Studio Zeta Padova - Agenzia Immobiliare</title></head><body>
      <h1>Studio Zeta - Intermediazioni Immobiliari Padova</h1>
      <p>Compravendita, locazioni, valutazione immobili a Padova. Agenzia
      immobiliare di fiducia dal 1990. Appartamenti in vendita, affitto
      uffici, intermediazione immobiliare. P.IVA 09999992283.</p>
      <p>I nostri servizi immobiliari coprono Padova centro, Padova nord,
      Padova sud. Affitto residenziale, compravendita appartamenti,
      locazione commerciale.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(
      html,
      makeNorm({ company_name: 'Studio Zeta Intermediazioni Immobiliari' }),
      { company_name: 'Studio Zeta Intermediazioni Immobiliari' },
    );
    expect(r.allow).toBe(true);
    expect(r.reasons.find((x) => x.startsWith('sector_density'))).toBeDefined();
  });

  it('accepts geographic-domain agency with generic title (cortina.it style)', () => {
    // The audit case: real agency, generic title; sector content
    // dominates the body.
    const html = `<html><head><title>Cortina.it - portale di Cortina d'Ampezzo</title></head><body>
      <h1>Agenzia Immobiliare Cortinese - Affitto e vendita</h1>
      <p>Affitto e vendita di immobili a Cortina d'Ampezzo. Compravendita
      appartamenti, chalet, hotel. Locazione stagionale, affitto
      settimanale. Agenzia immobiliare in Cortina. P.IVA 09999993257.</p>
      <p>Property management e consulenza immobiliare a Cortina d'Ampezzo.
      Vacation rentals di lusso. Real estate Dolomiti.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(
      html,
      makeNorm({ company_name: 'Agenzia Immobiliare Cortinese Sas' }),
      { company_name: 'Agenzia Immobiliare Cortinese Sas' },
    );
    expect(r.allow).toBe(true);
  });

  it('accepts page with the firm vat + one partner vat (≤3 distinct vats)', () => {
    const html = `<html><head><title>Immobiliare Bordignon</title></head><body>
      <h1>Bordignon Service - Immobiliare</h1>
      <p>Agenzia immobiliare a Montebelluna. Compravendita immobili,
      locazione appartamenti, affitto commerciale. P.IVA 09999994263.</p>
      <p>Partner: ${'\x20'}P.IVA 02000000099 (rete di franchising Bordignon).
      Compravendita, locazione, vendita immobili.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(
      html,
      makeNorm({ company_name: 'Bordignon Service' }),
      { company_name: 'Bordignon Service' },
    );
    expect(r.allow).toBe(true);
  });
});

describe('evaluatePaidEvidence — guards', () => {
  it('rejects empty / tiny HTML', () => {
    expect(evaluatePaidEvidence('', makeNorm({}), { company_name: 'x' }).allow).toBe(false);
    expect(evaluatePaidEvidence('<html/>', makeNorm({}), { company_name: 'x' }).allow).toBe(false);
  });

  it('aggregator-veto fires BEFORE sector-density check (cheaper rule first)', () => {
    const html = `<html><head><title>Real Estate Aggregator Italia</title></head><body>
      <h1>Real Estate Aggregator</h1>
      <p>Aggregatore di annunci immobiliari. Compravendita, locazione,
      affitto, vendita immobili appartamenti. Agenzie partner: P.IVA
      02000000001 02000000002 02000000003 02000000004 02000000005
      02000000006.</p>
    </body></html>`;
    const r = evaluatePaidEvidence(html, makeNorm({}), { company_name: 'x' });
    expect(r.allow).toBe(false);
    expect(r.reasons.find((x) => x.includes('aggregator_many_vats'))).toBeDefined();
  });
});
