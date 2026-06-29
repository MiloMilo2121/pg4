import { describe, it, expect } from 'vitest';
import { isDirectoryOrSocial } from '../../src/discovery/website/content_filter';
import { dedupeLeads } from '../../src/discovery/deduper';
import { parsePagineGialleResults } from '../../src/discovery/sources/pagine_gialle_parser';
import { parseGoogleMapsResults } from '../../src/discovery/sources/google_maps_parser';
import { classifyCategoryMatch } from '../../src/discovery/sources/category_match';
import { mapLegacyRow, mapLegacyRows } from '../../src/io/legacy_csv_mapper';
import fs from 'fs';
import path from 'path';

/**
 * Phase 3.7 — guardrail regression tests. Each test corresponds to a section
 * in `docs/legacy_failure_taxonomy.md`. If a regression brings back the pg3
 * behavior, one of these fails first.
 */

describe('§2 — dirty hosts NEVER count as official_website', () => {
  const samples = [
    'https://www.immobiliare.it/agenzie/foo',
    'https://www.tecnocasa.it/agenzie/milano-centro',
    'https://www.casa.it/agenzia/123',
    'https://retecasa.it/foo',
    'https://professionecasa.it/x',
    'https://gabetti.it/agenzia/xxx',
    'https://www.facebook.com/share/foo',
    'https://wa.me/+393331234567',
    'https://idealista.it/foo',
    'https://feltre1.tecnocasa.it/contatti',
    'https://www.bing.com/search?q=foo',
    'https://www.google.com/maps/place/foo',
    // Phase E.1 — directory portals that surfaced in p72 VR run
    'https://www.coobiz.it/azienda/badia-polesine-agenzia-intermediazione/co6341031',
    'https://italialei.it/informazioni-dettagliate/33013116/lanza-luigi/',
    'https://inelenco.com/?dir=vedi&id=3397091-privati',
    // Phase G.1 — Serper-observed directory aggregators in p90 PD run
    'https://cercacasa.it/dettaglio-agenzia/foo',
    'https://atoka.io/public/it/azienda/foo',
    'https://agentiimmobiliariabilitati.it/agenti/veneto/padova/foo',
    'https://www.padovamls.it/it/agenti/foo',
    'https://www.portaleagenzieimmobiliari.it/annunci-agenzia-immobiliare/123-foo',
    'https://infoisinfo.it/carta/foo',
    'https://www.oikia.it/agenzie-immobiliari/foo',
    'https://www.companyreports.it/foo',
    'https://gowork.it/foo-padova',
    'https://www.ioaffitto.it/dettaglio_agenzia/foo.html',
    'https://www.fiaipveneto.it/associati/foo/',
    'https://www.anacipadova.it/elenco-amministratori-anaci-a-padova/',
    'https://www.immobiliweb.com/Scheda-Agenzia_foo_padova.html',
    'https://reportazienda.it/aziende/PD/foo',
    'https://www.tellows.it/num/049000628',
    // Phase G.1 — wrong-sector / public-admin observed in p90
    'https://www.treccani.it/enciclopedia/italia/',
    'https://www.beniculturali.unipd.it/foo',
    'https://www.consorziopadovaovest.it/foo',
    'https://www.helvetia.com/it/web/it/chi-siamo.html',
    'https://www.bonaldo.com/',
    'https://www.bed-and-breakfast.it/it/padova',
    'https://www.pickandroll.it/foo',
    'https://lucabottoniteam.wordpress.com/',
    // Phase G.2 — Serper round-2 directory FPs from p91
    'https://www.casavenezia.it/it/agenzie/le_agenzie/foo/',
    'https://www.intercasarredamenti.it/chi-siamo/', // furniture, wrong sector
    'https://www.impresaitalia.info/kk03424261/foo/padova.aspx',
    'https://www.mioaffitto.it/microsite/foo.html',
    'https://cittanostra.it/agenzie-immobiliari/scheda-foo',
    'https://www.bedandbreakfast.it/it/vicino/stazione-padova',
    'https://www.bancadellecase.it/agenzia/foo',
    'https://www.icribis.com/it/scheda-azienda/PD258373_FOO',
    'https://www.agenziaroma.com/',
    'https://www.aterpadova.it/',                 // public housing auth
    'https://www.aopd.veneto.it/sez,217',          // hospital
    'https://www.arte-casa.info/',
    // R10.b TV — 2 FPs that slipped past R9 PaidEvidenceGate
    'https://trasparenza.cultura.gov.it/foo/contratti/123',
    'https://www.infoimmobile.it/agenzia/treviso/foo',
  ];
  for (const s of samples) {
    it(`blocks ${s}`, () => {
      expect(isDirectoryOrSocial(s)).toBe(true);
    });
  }
});

describe('§1 — cross-comune dedupe by stable identity', () => {
  it('collapses two PG records with same pg_url under different query_locations', () => {
    const out = dedupeLeads([
      { company_name: 'Studio Foo', city: 'Belluno', query_location: 'Belluno', pg_url: 'https://www.paginegialle.it/studiofoo' },
      { company_name: 'Studio Foo', city: 'Cortina', query_location: 'Cortina', pg_url: 'https://www.paginegialle.it/studiofoo' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].query_location).toBe('Belluno'); // first wins
  });

  it('collapses by phone across cities', () => {
    const out = dedupeLeads([
      { company_name: 'A', city: 'Belluno', phone: '+39 0437 000123' },
      { company_name: 'A', city: 'Sedico', phone: '0437 000123' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('collapses by registrable host across sources', () => {
    const out = dedupeLeads([
      { company_name: 'A', city: 'Feltre', source: 'PG', sources: ['PG'], website: 'https://www.exampleagency.it' },
      { company_name: 'A', city: 'Feltre', source: 'MAPS', sources: ['MAPS'], website: 'http://exampleagency.it/contatti' },
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('§9 — sources[] is a UNION across merged records', () => {
  it('merges sources arrays without losing provenance', () => {
    const out = dedupeLeads([
      { company_name: 'Foo', city: 'Belluno', pg_url: 'https://www.paginegialle.it/foo', source: 'PG', sources: ['PG'] },
      { company_name: 'Foo', city: 'Belluno', pg_url: 'https://www.paginegialle.it/foo', source: 'MAPS', sources: ['MAPS'] },
    ]);
    expect(out).toHaveLength(1);
    expect((out[0].sources ?? []).sort()).toEqual(['MAPS', 'PG']);
  });
});

describe('§7 — Maps cap_likely flag', () => {
  it('returns cap_likely=false for small feeds', () => {
    const html = fs.readFileSync(
      path.join(__dirname, '../fixtures/scraper/maps_feltre_feed.html'),
      'utf8'
    );
    const r = parseGoogleMapsResults(html);
    expect(r.cap_likely).toBe(false);
  });
  it('returns cap_likely=true at the cap threshold', () => {
    // Synthesize a feed with 115 cards by repeating a card stub.
    const card = `<div class="Nv2PK"><a aria-label="X${'$'}{i}"><div class="qBF1Pd">X${'$'}{i}</div></a></div>`;
    let body = '<div role="feed">';
    for (let i = 0; i < 115; i++) body += card.replace(/\$\{i\}/g, String(i));
    body += '</div>';
    const html = `<!doctype html><html><body>${body}</body></html>`;
    const r = parseGoogleMapsResults(html);
    expect(r.total_cards).toBe(115);
    expect(r.cap_likely).toBe(true);
  });
});

describe('§8 — category_match marker', () => {
  it('returns confirmed when card type tag matches', () => {
    expect(classifyCategoryMatch('agenzie immobiliari', 'Agenzia immobiliare')).toBe('confirmed');
  });
  it('returns mismatch when card type is something else', () => {
    expect(classifyCategoryMatch('agenzie immobiliari', 'Bar e caffetteria')).toBe('mismatch');
  });
  it('returns unknown when card type is missing', () => {
    expect(classifyCategoryMatch('agenzie immobiliari', undefined)).toBe('unknown');
  });
  it('handles centro estetico canonical category', () => {
    expect(classifyCategoryMatch('centro estetico', 'Centro estetico')).toBe('confirmed');
    expect(classifyCategoryMatch('centro estetico', 'Pizzeria')).toBe('mismatch');
  });
});

describe('§1 — query_location is propagated by parsers', () => {
  it('PG parser sets query_location and business_city when card city differs', () => {
    const html = fs.readFileSync(
      path.join(__dirname, '../fixtures/scraper/pg_belluno_normal.html'),
      'utf8'
    );
    const r = parsePagineGialleResults(html, { category: 'agenzie immobiliari', queryLocation: 'Belluno' });
    expect(r.results.every((l) => l.query_location === 'Belluno')).toBe(true);
    // Re/Max card is in Sedico — should mark business_city
    const remax = r.results.find((l) => /re\s*\/\s*max/i.test(l.company_name));
    expect(remax?.business_city).toBe('Sedico');
  });
});

describe('§10 — legacy CSV schema mapper', () => {
  it('maps the pg3 raw+scoring schema to canonical Lead', () => {
    const lead = mapLegacyRow({
      company_name: 'Foo SRL',
      city: 'Belluno',
      province: 'BL',
      vat_code: '12345678901',
      website: 'https://foo.it',
      geriko_tier: 'A',
      score_total: '0.92',
      score_negatives: '0',
    });
    expect(lead.company_name).toBe('Foo SRL');
    expect(lead.vat_code).toBe('12345678901');
    expect((lead as Record<string, unknown>).legacy_geriko_tier).toBe('A');
    expect((lead as Record<string, unknown>).legacy_score_total).toBe('0.92');
  });

  it('maps the pg3 export schema (dm_*, email_type, contact_source)', () => {
    const lead = mapLegacyRow({
      company_name: 'Foo',
      city: 'Milano',
      website: 'https://foo.it',
      email: 'sales@foo.it',
      email_type: 'business',
      pec: 'pec@foo.legalmail.it',
      contact_source: 'website',
      dm_name: 'Mario Rossi',
      dm_role: 'CEO',
      dm_linkedin: 'https://linkedin.com/in/mario',
      dm_confidence: '0.8',
      employees: '12',
    });
    expect(lead.decision_maker_name).toBe('Mario Rossi');
    expect(lead.decision_maker_role).toBe('CEO');
    expect(lead.decision_maker_linkedin).toBe('https://linkedin.com/in/mario');
    expect(lead.email_type).toBe('business');
    expect((lead as Record<string, unknown>).legacy_contact_source).toBe('website');
    expect((lead as Record<string, unknown>).legacy_dm_confidence).toBe('0.8');
  });

  it('throws on a row missing company_name', () => {
    expect(() => mapLegacyRow({ city: 'Foo' })).toThrow(/company_name/);
  });

  it('mapLegacyRows skips malformed rows without crashing', () => {
    const out = mapLegacyRows([
      { company_name: 'A' },
      { city: 'no name here' },
      { company_name: 'C' },
    ]);
    expect(out.map((l) => l.company_name)).toEqual(['A', 'C']);
  });

  it('parses combined source string ("PG + Maps") into sources[]', () => {
    const lead = mapLegacyRow({ company_name: 'X', source: 'PG + Maps' });
    expect((lead.sources ?? []).sort()).toEqual(['Maps', 'PG']);
  });
});
