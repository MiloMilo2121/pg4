import { describe, it, expect } from 'vitest';
import {
  extractDistinctiveTokens,
  compactStrippedBrand,
  compactFullName,
  isCommonBareStem,
  shortHost,
  hasBusinessCityEvidence,
  hasSectorEvidence,
  isTinyOrParked,
  evaluateSemanticEvidence,
} from '../../src/discovery/website/semantic_evidence';
import { normalizeLead } from '../../src/discovery/input_normalizer';

describe('semantic_evidence — pure helpers', () => {
  it('extractDistinctiveTokens drops descriptors / legal forms / short tokens', () => {
    expect(extractDistinctiveTokens('Agenzia Immobiliare SG di Mario S.R.L.')).toEqual(['mario']);
    expect(extractDistinctiveTokens('La Mia Casa Follina')).toEqual(['follina']);
    expect(extractDistinctiveTokens('Bloom')).toEqual(['bloom']);
    expect(extractDistinctiveTokens('Ufficio')).toEqual(['ufficio']);
    expect(extractDistinctiveTokens('Gecoimmobili SRL')).toEqual(['gecoimmobili']);
  });

  it('compactStrippedBrand keeps brand stem after stripping NER descriptors', () => {
    // NER strips "immobiliare" + legal forms; "agenzia" stays (not in NER's list).
    expect(compactStrippedBrand('Agenzia Immobiliare Pierobon')).toContain('pierobon');
    expect(compactStrippedBrand('DMC Legno SRL')).toMatch(/dmc/);
    expect(compactStrippedBrand('Bloom')).toBe('bloom');
  });

  it('compactFullName keeps descriptors but compacts to a-z0-9', () => {
    expect(compactFullName('Agenzia Immobiliare Estimo Pierobon')).toBe('agenziaimmobiliareestimopierobon');
    expect(compactFullName('Agenzia Immobiliare SG')).toBe('agenziaimmobiliaresg');
  });

  it('isCommonBareStem — audit denylist hits', () => {
    expect(isCommonBareStem('bloom')).toBe(true);
    expect(isCommonBareStem('ufficio')).toBe(true);
    expect(isCommonBareStem('area')).toBe(true);
    expect(isCommonBareStem('appia')).toBe(true);
    expect(isCommonBareStem('torri')).toBe(true);
    expect(isCommonBareStem('mia')).toBe(true);
    expect(isCommonBareStem('iniziative')).toBe(true);
    expect(isCommonBareStem('progetto')).toBe(true);
    // Real brands MUST NOT be in the denylist
    expect(isCommonBareStem('gecoimmobili')).toBe(false);
    expect(isCommonBareStem('pierobon')).toBe(false);
    expect(isCommonBareStem('andreotta')).toBe(false);
    expect(isCommonBareStem('giacin')).toBe(false);
  });

  it('shortHost extracts the registrable stem', () => {
    expect(shortHost('https://www.agenzialamiacasa.it/contatti')).toBe('agenzialamiacasa');
    expect(shortHost('https://gecoimmobili.it')).toBe('gecoimmobili');
    expect(shortHost('not a url')).toBe('');
  });

  it('hasBusinessCityEvidence matches lead.city in body', () => {
    const lead = normalizeLead({ company_name: 'X', city: 'Belluno' });
    expect(hasBusinessCityEvidence('Vendita immobili a Belluno', lead)).toBe(true);
    expect(hasBusinessCityEvidence('Vendita immobili a Modena', lead)).toBe(false);
  });

  it('hasSectorEvidence — aligned vs conflicting for real estate', () => {
    const aligned = hasSectorEvidence(
      'Compravendita e locazione di appartamenti, immobili in vendita',
      'agenzie immobiliari'
    );
    expect(aligned.aligned).toBe(true);
    expect(aligned.conflicting).toBe(false);

    const conflict = hasSectorEvidence(
      'Cartoleria e cancelleria, toner e cartucce per stampanti',
      'agenzie immobiliari'
    );
    expect(conflict.conflicting).toBe(true);

    const carpenteria = hasSectorEvidence(
      'Carpenteria metallica, fresatura e tornitura di precisione',
      'agenzie immobiliari'
    );
    expect(carpenteria.conflicting).toBe(true);
  });

  it('isTinyOrParked — short body, parked title, parking text', () => {
    expect(isTinyOrParked('')).toBe(true);
    expect(isTinyOrParked('<html><body>tiny</body></html>')).toBe(true);
    const parkedTitle =
      '<html><head><title>iniziative.org - For Sale</title></head><body>' +
      'x'.repeat(900) + '</body></html>';
    expect(isTinyOrParked(parkedTitle)).toBe(true);
    const parkedBody =
      '<html><head><title>Domain</title></head><body>' +
      'This domain is for sale, buy this domain via sedo.com. ' +
      'x'.repeat(900) + '</body></html>';
    expect(isTinyOrParked(parkedBody)).toBe(true);
  });

  it('isTinyOrParked tolerates "case in vendita" on real-estate pages', () => {
    const realEstate =
      '<html><head><title>Agenzia Foo</title></head><body>' +
      'Le nostre case in vendita a Belluno, immobili residenziali. ' +
      'x'.repeat(900) + '</body></html>';
    expect(isTinyOrParked(realEstate)).toBe(false);
  });
});

describe('semantic_evidence — evaluateSemanticEvidence', () => {
  const realEstateBody =
    'Compravendita e locazione di appartamenti. Immobili in vendita a Belluno. ' +
    'Trovi monolocale, bilocale, trilocale, ville e immobili commerciali. ' +
    'Servizio di valutazione gratuita. Consulenza per mutuo. Selezioniamo accuratamente ' +
    'gli immobili in linea con le richieste della clientela. Visita la sede in centro a Belluno. ' +
    'Pubblichiamo costantemente nuove proposte di immobili in vendita e in affitto. ' +
    'Servizi offerti: gestione contratti di locazione, consulenza fiscale sugli investimenti ' +
    'immobiliari, consulenza per la stipula di contratti preliminari, verifica della regolarità ' +
    'urbanistica e catastale, supporto per la successione e la divisione ereditaria. ' +
    'Iscritta al ruolo agenti immobiliari della Camera di Commercio di Belluno. ' +
    'Contatti per richiedere informazioni o fissare un appuntamento con i nostri agenti.';

  it('layerB fires on stripped brand stem in domain (Gecoimmobili)', () => {
    const lead = normalizeLead({ company_name: 'Gecoimmobili SRL', city: 'Belluno', category: 'agenzie immobiliari' });
    const html = `<html><head><title>Gecoimmobili</title></head><body>${realEstateBody}</body></html>`;
    const ev = evaluateSemanticEvidence('https://gecoimmobili.it', html, lead);
    expect(ev.layerBStrippedBrand).toBe(true);
    expect(ev.hasCommonBareStem).toBe(false);
    expect(ev.tinyOrParked).toBe(false);
  });

  it('layerA fires on long compact full name in domain (Pierobon)', () => {
    const lead = normalizeLead({
      company_name: 'Agenzia Immobiliare Estimo Pierobon',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const html = `<html><head><title>Pierobon</title></head><body>${realEstateBody} Pierobon è la nostra agenzia.</body></html>`;
    const ev = evaluateSemanticEvidence('https://agenziaimmobiliareestimopierobon.com', html, lead);
    expect(ev.layerAFullName).toBe(true);
    expect(ev.compactFull.length).toBeGreaterThanOrEqual(14);
  });

  it('hasCommonBareStem fires on single-token denylist brand (Bloom, Ufficio)', () => {
    const bloom = normalizeLead({ company_name: 'Bloom', city: 'Pieve di Cadore' });
    const html = `<html><body>${realEstateBody}</body></html>`;
    const ev = evaluateSemanticEvidence('https://bloom.it', html, bloom);
    expect(ev.hasCommonBareStem).toBe(true);

    const ufficio = normalizeLead({ company_name: 'Ufficio', city: 'Cortina' });
    const ev2 = evaluateSemanticEvidence('https://ufficio.com', html, ufficio);
    expect(ev2.hasCommonBareStem).toBe(true);
  });

  it('sectorConflicting fires on carpentry/cartoleria when category=immobiliare', () => {
    const lead = normalizeLead({
      company_name: 'Dalla Riva',
      city: 'Feltre',
      category: 'agenzie immobiliari',
    });
    const html =
      '<html><body>Carpenteria metallica, fresatura e tornitura di precisione. ' +
      'Lavorazioni meccaniche di precisione per il settore industriale. ' +
      'x'.repeat(800) + '</body></html>';
    const ev = evaluateSemanticEvidence('https://dallariva.it', html, lead);
    expect(ev.sectorConflicting).toBe(true);
    expect(ev.sectorAligned).toBe(false);
  });
});
