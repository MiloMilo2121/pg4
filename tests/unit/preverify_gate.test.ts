import { describe, it, expect } from 'vitest';
import { PreVerifyGate } from '../../src/discovery/website/preverify_gate';
import { normalizeLead } from '../../src/discovery/input_normalizer';

describe('PreVerifyGate', () => {
  it('VERIFIED when P.IVA digits appear in body', () => {
    const lead = normalizeLead({ company_name: 'Acme', city: 'Milano', vat_code: '12345678901' });
    const html =
      '<html><head><title>Acme</title></head><body>Acme è una società italiana. P.IVA 12345678901, sede legale via Roma 1, Milano. Tutti i diritti riservati.</body></html>';
    const r = PreVerifyGate.check('https://acme.it', html, lead);
    expect(r.status).toBe('VERIFIED');
    expect(r.evidence).toBe('piva_match');
  });

  it('VERIFIED_SEMANTIC when stripped brand stem matches the domain (Layer B)', () => {
    const lead = normalizeLead({
      company_name: 'Gecoimmobili SRL',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    // > 800 useful bytes so the tiny_or_parked guard doesn't fire.
    const html =
      '<html><head><title>Gecoimmobili — agenzia immobiliare Belluno</title></head><body>' +
      '<h1>Gecoimmobili</h1>' +
      '<p>Agenzia immobiliare a Belluno, specializzata in compravendita e locazione di appartamenti e ville. ' +
      'Trovi case in vendita, monolocale, bilocale, trilocale, immobili commerciali e residenziali. ' +
      'Da oltre 20 anni a fianco di chi cerca casa nelle Dolomiti. ' +
      'Servizio di valutazione gratuita, consulenza per mutuo e successioni.</p>' +
      '<p>Visita la nostra sede in centro a Belluno per scoprire tutte le proposte. ' +
      'Pubblichiamo costantemente nuove proposte di immobili in vendita e in affitto. ' +
      'Selezioniamo accuratamente solo immobili in linea con le richieste della nostra clientela.</p>' +
      '<p>Servizi offerti: valutazione gratuita, gestione contratti di locazione, consulenza fiscale ' +
      'sugli investimenti immobiliari, consulenza per la stipula di contratti preliminari, ' +
      'verifica della regolarità urbanistica e catastale, supporto per la successione e ' +
      'la divisione ereditaria, ricerche personalizzate.</p>' +
      '<p>Contatti: telefono e email per richiedere informazioni o fissare un appuntamento.</p>' +
      '<p>Gecoimmobili è iscritta al ruolo agenti immobiliari della Camera di Commercio di Belluno.</p>' +
      '</body></html>';
    const r = PreVerifyGate.check('https://gecoimmobili.it', html, lead);
    expect(r.status).toBe('VERIFIED_SEMANTIC');
    expect(r.evidence).toBe('strong_brand');
  });

  it('REJECTED when no signals match', () => {
    const lead = normalizeLead({ company_name: 'Acme SRL', city: 'Milano', vat_code: '12345678901' });
    const html = '<html><body>Welcome to a totally unrelated site</body></html>';
    const r = PreVerifyGate.check('https://random.com', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('REJECTED for empty html', () => {
    const lead = normalizeLead({ company_name: 'A', city: 'B' });
    expect(PreVerifyGate.check('https://x.it', '', lead).status).toBe('REJECTED');
  });
});

/**
 * Phase D — pin every false-positive from the Phase C audit so a future
 * loosening of the gate can never resurrect them. Companion to the
 * acceptance set below.
 */
const realEstateBody =
  'Compravendita e locazione di appartamenti. Immobili in vendita. ' +
  'Trovi monolocale, bilocale, trilocale, ville e immobili commerciali. ' +
  'Servizio di valutazione gratuita. Consulenza per mutuo. Selezioniamo ' +
  'accuratamente gli immobili in linea con le richieste della clientela. ' +
  'Pubblichiamo costantemente nuove proposte di immobili in vendita e in affitto. ' +
  'Servizi offerti: gestione contratti di locazione, consulenza fiscale sugli ' +
  'investimenti, verifica della regolarità urbanistica e catastale, supporto per ' +
  'la successione e la divisione ereditaria, ricerche personalizzate per la clientela. ' +
  'Iscritta al ruolo agenti immobiliari della Camera di Commercio. ' +
  'Contatti per richiedere informazioni o fissare un appuntamento con i nostri agenti. ' +
  'La nostra agenzia opera da oltre venti anni nel territorio, garantendo professionalità ' +
  'e serietà a chi cerca casa o desidera vendere il proprio immobile.';

function htmlPage(title: string, body: string): string {
  return `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

describe('PreVerifyGate — Phase D audit REJECT cases (must NOT match)', () => {
  it('Bloom → bloom.it (single-token denylist)', () => {
    const lead = normalizeLead({ company_name: 'Bloom', city: 'Pieve di Cadore', category: 'agenzie immobiliari' });
    const html = htmlPage('Bloom Org Consulting', realEstateBody);
    const r = PreVerifyGate.check('https://bloom.it', html, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Ufficio → ufficio.com (single-token denylist + sector conflict)', () => {
    const lead = normalizeLead({ company_name: 'Ufficio', city: 'Cortina', category: 'agenzie immobiliari' });
    const conflictBody =
      'Cartoleria e cancelleria, toner e cartucce per stampanti. ' +
      'Forniture per ufficio, articoli di cancelleria di alta qualità. '.repeat(8);
    const r = PreVerifyGate.check('https://ufficio.com', htmlPage('Ufficio', conflictBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Area Immobiliare Belluno → areaimmobiliare.com (Bergamo, common stem)', () => {
    const lead = normalizeLead({
      company_name: 'Area Immobiliare',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    // Body mentions Bergamo not Belluno → no city evidence; stripped="area" common stem.
    const html = htmlPage('Area Immobiliare', realEstateBody.replace(/Belluno/g, 'Bergamo') +
      ' La nostra agenzia opera a Bergamo e provincia.');
    const r = PreVerifyGate.check('https://areaimmobiliare.com', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Agenzia Le Torri → agenzialetorri.com (Modena, common stem "torri")', () => {
    const lead = normalizeLead({
      company_name: 'Agenzia Le Torri',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Le Torri', realEstateBody.replace(/Belluno/g, 'Modena') + ' Modena.');
    const r = PreVerifyGate.check('https://agenzialetorri.com', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('La Mia Casa Follina → agenzialamiacasa.it (Cuneo, common stem "mia")', () => {
    const lead = normalizeLead({
      company_name: 'La Mia Casa',
      city: 'Follina',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('La Mia Casa', realEstateBody.replace(/Belluno/g, 'Cuneo') + ' Cuneo.');
    const r = PreVerifyGate.check('https://agenzialamiacasa.it', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Immobiliare Appia → immobiliareappia.it (Roma, common stem "appia")', () => {
    const lead = normalizeLead({
      company_name: 'Immobiliare Appia',
      city: 'Cortina',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Immobiliare Appia', realEstateBody.replace(/Belluno/g, 'Roma') + ' Roma.');
    const r = PreVerifyGate.check('https://immobiliareappia.it', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Dalla Riva (immobiliare) → dallariva.it (carpenteria — sector conflict)', () => {
    const lead = normalizeLead({
      company_name: 'Dalla Riva',
      city: 'Feltre',
      category: 'agenzie immobiliari',
    });
    const conflictBody =
      'Carpenteria metallica, fresatura e tornitura di precisione. ' +
      'Lavorazioni meccaniche di precisione per il settore industriale. '.repeat(8);
    const r = PreVerifyGate.check('https://dallariva.it', htmlPage('Dalla Riva', conflictBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Savim → savim.it (verniciatura industriale — sector conflict)', () => {
    const lead = normalizeLead({
      company_name: 'Savim',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const conflictBody =
      'Verniciatura industriale e trattamento superfici metalliche. ' +
      'Servizi di carpenteria e meccanica di precisione per industria. '.repeat(8);
    const r = PreVerifyGate.check('https://savim.it', htmlPage('Savim', conflictBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('agenziaimmobiliare.it generic portal — no distinctive tokens', () => {
    const lead = normalizeLead({
      company_name: 'Agenzia Immobiliare',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Agenzia Immobiliare', realEstateBody);
    const r = PreVerifyGate.check('https://agenziaimmobiliare.it', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Agenzia Mercato Immobiliare → am.com (domain stem too short)', () => {
    // 2-3 char domains substring-match into long company-name compacts
    // and used to leak through Layer A. Phase D enforces a 6-char
    // minimum domain stem to block this class of FPs.
    const lead = normalizeLead({
      company_name: 'Agenzia Mercato Immobiliare',
      city: 'Borgo Valbelluna',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('AM', realEstateBody);
    const r = PreVerifyGate.check('https://am.com', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Pb Properties → pbproperties.com (acronym + generic English noun, US homonym)', () => {
    // Phase D.1 regression: audit Phase C identified Pb Properties as
    // FP_GENERIC_HOMONYM (the actual pbproperties.com is "Premier
    // Business Properties, Inc.", a US firm). The previous Phase D
    // gate let this through Layer B because "pb" qualified as a short
    // acronym and "properties" got stripped as a descriptor, so the
    // pattern "acronym + generic English real-estate noun" matched
    // the domain. Layer B now requires a strong ≥4-char distinctive
    // brand token; short acronyms are valid only via Layer A's
    // length-anchored full-name match.
    const lead = normalizeLead({
      company_name: 'Pb Properties S.r.l.',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Pb Properties', realEstateBody);
    const r = PreVerifyGate.check('https://pbproperties.com', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase D.5 — Broker S.r.l. → broker.eu (Belgian broker, not Italian SMB)', () => {
    const lead = normalizeLead({
      company_name: 'Broker S.r.l.',
      city: 'Montebelluna',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Broker', realEstateBody);
    const r = PreVerifyGate.check('https://broker.eu', html, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Phase D.5 — Contea S.r.l. → contea.com (Spaceship marketplace listing)', () => {
    const lead = normalizeLead({
      company_name: 'Contea S.r.l.',
      city: 'Montebelluna',
      category: 'agenzie immobiliari',
    });
    // Even with a "live" body, the COMMON_BARE_STEMS rule must reject.
    const html = htmlPage('Contea', realEstateBody);
    const r = PreVerifyGate.check('https://contea.com', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase D.5 — contea.com Spaceship marketplace title triggers tiny_or_parked', () => {
    // Even without the COMMON_BARE_STEMS rule, the marketplace title
    // pattern "<domain> for sale | Spaceship.com" must be detected
    // as parked.
    const lead = normalizeLead({
      company_name: 'Some Other Company',
      city: 'Treviso',
      category: 'agenzie immobiliari',
    });
    const parked =
      '<html><head><title>contea.com for sale | Spaceship.com</title></head><body>' +
      'x'.repeat(900) +
      'spaceship.com domain marketplace transaction support secure payments' +
      '</body></html>';
    const r = PreVerifyGate.check('https://contea.com', parked, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/tiny_or_parked/);
  });

  it('Phase E — Palace Immobiliare → palace.it (Palace Merano medical spa, not real estate)', () => {
    const lead = normalizeLead({
      company_name: 'Palace Immobiliare S.r.l.',
      city: 'Montagnana',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Palace', realEstateBody);
    const r = PreVerifyGate.check('https://palace.it', html, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Phase E — Domino S.r.l. → domino.it (digital marketing agency Turin/Venice)', () => {
    const lead = normalizeLead({
      company_name: 'Domino S.r.l.',
      city: 'Lazise',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Domino', realEstateBody);
    const r = PreVerifyGate.check('https://domino.it', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase E — Camelot Sas → camelot.it (e-voting platform Ivrea)', () => {
    const lead = normalizeLead({
      company_name: 'Camelot Sas',
      city: 'Villafranca di Verona',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Camelot', realEstateBody);
    const r = PreVerifyGate.check('https://camelot.it', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase E — Libertà Immobiliare → liberta.eu (Nameshift domain marketplace)', () => {
    const lead = normalizeLead({
      company_name: "Liberta' Immobiliare S.r.l.",
      city: 'Legnago',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Liberta', realEstateBody);
    const r = PreVerifyGate.check('https://liberta.eu', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase E — Alfa Omega Immobiliare → alfaomega.it (Monza pharmaceuticals, multi-token brand)', () => {
    // Multi-token brand: NER tokens=["alfa","omega"] → distinctive=2.
    // The 1-distinctive-token denylist check would miss this; the
    // compactStripped denylist check (D.5) catches "alfaomega".
    const lead = normalizeLead({
      company_name: 'Alfa Omega Immobiliare',
      city: 'Verona',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Alfa Omega', realEstateBody);
    const r = PreVerifyGate.check('https://alfaomega.it', html, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Phase F — Americanino → americanino.eu (clothing brand, not real estate)', () => {
    const lead = normalizeLead({
      company_name: 'Americanino',
      city: 'Padova',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://americanino.eu', htmlPage('Americanino', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Phase F — Raffaello S.r.l. → raffaello.it (Ferrero confectionery brand)', () => {
    const lead = normalizeLead({
      company_name: 'Raffaello S.r.l.',
      city: 'Limena',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://raffaello.it', htmlPage('Raffaello', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase F — Cantele S.r.l. → cantele.it (wine producer Salento)', () => {
    const lead = normalizeLead({
      company_name: 'Cantele S.r.l.',
      city: 'Padova',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://cantele.it', htmlPage('Cantele', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase F — Immobiliare Gemini → gemini.it (condo management software)', () => {
    const lead = normalizeLead({
      company_name: 'Immobiliare Gemini S.r.l.',
      city: 'Albignasego',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://gemini.it', htmlPage('Gemini', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase F — Fusion S.a.s. → fusion.org (parked / domain marketplace)', () => {
    const lead = normalizeLead({
      company_name: 'Fusion S.a.s.',
      city: 'Albignasego',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://fusion.org', htmlPage('Fusion', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase F — My Home S.r.l. → myhome.com (US Williston Financial real-estate tech)', () => {
    const lead = normalizeLead({
      company_name: 'My Home S.r.l.',
      city: 'Padova',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://myhome.com', htmlPage('My Home', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase F — Immobiliare Orchidea → orchidea.it (Orchidea Milano furniture retail)', () => {
    const lead = normalizeLead({
      company_name: 'Immobiliare Orchidea S.r.l.',
      city: 'Mestrino',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://orchidea.it', htmlPage('Orchidea', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase F — Ypsilon S.r.l. → ypsilon.net (travel tech AG, ISO/PCI)', () => {
    const lead = normalizeLead({
      company_name: 'Ypsilon S.r.l.',
      city: 'Albignasego',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://ypsilon.net', htmlPage('Ypsilon', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase F — Alessandra S.r.l. → alessandra.com (Dr. Tony Alessandra US consultant)', () => {
    const lead = normalizeLead({
      company_name: 'Alessandra S.r.l.',
      city: 'Padova',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://alessandra.com', htmlPage('Alessandra', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase F.1 — Franca Immobiliare → franca.it (Residence Franca tourist residence Arco TN)', () => {
    const lead = normalizeLead({
      company_name: 'Franca Immobiliare',
      city: 'Albignasego',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://franca.it', htmlPage('Franca', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Phase F.1 — Immobiliare Sartori → sartori.it (Sartori Studio Legale Trento law firm)', () => {
    const lead = normalizeLead({
      company_name: 'Immobiliare Sartori',
      city: 'Casalserugo',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://sartori.it', htmlPage('Sartori', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase F.1 — Studio Immobiliare Colonna → colonna.net (Wittmann family personal site)', () => {
    const lead = normalizeLead({
      company_name: 'Studio Immobiliare Colonna',
      city: 'Montegrotto Terme',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://colonna.net', htmlPage('Colonna', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase F.1 — Immobiliare Chemello → chemello.it (Chemello Metalworking, same town, different business)', () => {
    // Edge case: same surname AND same town as the lead, but the
    // chemello.it owner is "Chemello Metalworking Srl" (funeral-art
    // metalwork). Same family, different legal entity. Treat as FP
    // because pg4 cannot determine the relationship at zero cost.
    const lead = normalizeLead({
      company_name: 'Immobiliare Chemello',
      city: 'Sandrigo',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://chemello.it', htmlPage('Chemello', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase F.1 — La Chiave → lachiave.com stays MATCHED (audit-confirmed TP)', () => {
    // Manual WebFetch confirmed lachiave.com IS Immobiliare La Chiave
    // (Padova, Via Torino 11). Real estate agency, same firm, same
    // city. TP regression pin.
    const lead = normalizeLead({
      company_name: 'Immobiliare La Chiave S.r.l.',
      city: 'Padova',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('La Chiave', `${realEstateBody} Sede a Padova.`);
    const r = PreVerifyGate.check('https://lachiave.com', html, lead);
    expect(r.status).toBe('VERIFIED_SEMANTIC');
  });

  it('Phase F.1 — Phosphoro → phosphoro.com stays MATCHED (audit-confirmed TP)', () => {
    // Manual WebFetch confirmed phosphoro.com IS Phosphoro rental
    // platform headquartered in Padova ("Affitti sicuri di stanze,
    // appartamenti..."). Same firm, same city. TP regression pin.
    const lead = normalizeLead({
      company_name: 'Phosphoro S.r.l.',
      city: 'Padova',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Phosphoro', `${realEstateBody} Sede a Padova. Phosphoro affitti sicuri.`);
    const r = PreVerifyGate.check('https://phosphoro.com', html, lead);
    expect(r.status).toBe('VERIFIED_SEMANTIC');
  });

  it('Phase F.3 — Academy S.r.l. → academy.it (The British Academy English school, Lazio)', () => {
    const lead = normalizeLead({
      company_name: 'Academy S.r.l.',
      city: 'Rovigo',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://academy.it', htmlPage('Academy', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Phase F.3 — Giemme S.r.l. → giemme.org (Gi. Emme Macchine Utensili, same town different sector)', () => {
    // Same town as the lead (Albignasego PD), but giemme.org is a
    // machine-tools company since 1997, not a real estate agency.
    // Same family pattern as Chemello in F.1: shared
    // surname/family/town, distinct legal entity, distinct sector.
    const lead = normalizeLead({
      company_name: 'Giemme S.r.l.',
      city: 'Albignasego',
      category: 'agenzie immobiliari',
    });
    const r = PreVerifyGate.check('https://giemme.org', htmlPage('Giemme', realEstateBody), lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase E — Cangrande Immobiliare → cangrande.it stays MATCHED (audit-confirmed TP)', () => {
    // Manual WebFetch confirmed cangrande.it IS Cangrande Immobiliare
    // di Francesco Geom. Savino, Verona — same firm, same sector,
    // same city. Must NOT regress to REJECTED when adding Phase E
    // denylist entries. `cangrande` is intentionally NOT in
    // COMMON_BARE_STEMS.
    const lead = normalizeLead({
      company_name: 'Cangrande Immobiliare',
      city: 'Verona',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Cangrande', `${realEstateBody} Sede a Verona.`);
    const r = PreVerifyGate.check('https://cangrande.it', html, lead);
    expect(r.status).toBe('VERIFIED_SEMANTIC');
  });

  it('Phase D.5 — Immobiliare Possagno → possagno.it (town stem, intermittent placeholder)', () => {
    const lead = normalizeLead({
      company_name: 'Immobiliare Possagno',
      city: 'Treviso',
      category: 'agenzie immobiliari',
    });
    // Even if the page momentarily returns substantive HTML, the
    // single-token brand "possagno" matches the town name and the
    // domain is `possagno.<tld>` — almost always a comune portal or
    // placeholder. Same family as `comelico`.
    const html = htmlPage('Possagno', realEstateBody);
    const r = PreVerifyGate.check('https://possagno.it', html, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Phase D.5 — possagno.it "coming soon" placeholder rejected', () => {
    const lead = normalizeLead({
      company_name: 'Some Real Estate',
      city: 'Treviso',
      category: 'agenzie immobiliari',
    });
    const placeholder =
      '<html><head><title>possagno.it - coming soon</title></head><body>' +
      'This domain is coming soon. ' +
      'x'.repeat(900) + '</body></html>';
    const r = PreVerifyGate.check('https://possagno.it', placeholder, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/tiny_or_parked/);
  });

  it('Phase D.5 — Immobiliare Galileo → galileo.it (e-learning portal)', () => {
    const lead = normalizeLead({
      company_name: 'Immobiliare Galileo S.r.l.',
      city: 'Montebelluna',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Galileo', realEstateBody);
    const r = PreVerifyGate.check('https://galileo.it', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase D.5 — Sinergia S.r.l. → sinergia.it (consulting in Pesaro, not real estate)', () => {
    const lead = normalizeLead({
      company_name: 'Sinergia S.r.l.',
      city: 'Castelfranco Veneto',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Sinergia', realEstateBody);
    const r = PreVerifyGate.check('https://sinergia.it', html, lead);
    expect(r.status).toBe('REJECTED');
  });

  it('Phase D.5 — Solar System S.r.l. → solarsystem.it (solar panels in Sicily)', () => {
    // Multi-token brand: NER tokens=["solar","system"]. The
    // 1-distinctive-token denylist check would miss this; the new
    // compactStripped denylist check catches "solarsystem".
    const lead = normalizeLead({
      company_name: 'Solar System S.r.l.',
      city: 'Castelfranco Veneto',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Solar System', realEstateBody);
    const r = PreVerifyGate.check('https://solarsystem.it', html, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Studio Master Immobiliare → master.it (electrical manufacturer in Este — generic English noun)', () => {
    // Phase D.4 TV audit (p64): "Studio Master Immobiliare" was
    // matched to master.it. master.it is "Master S.r.l. Divisione
    // Elettrica", an electrical materials manufacturer in Este (PD)
    // — confirmed via WebFetch. "master" is also a generic English
    // brand-noise stem. Added to COMMON_BARE_STEMS.
    const lead = normalizeLead({
      company_name: 'Studio Master Immobiliare',
      city: 'Paese',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Master', realEstateBody);
    const r = PreVerifyGate.check('https://master.it', html, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Immobiliare Europa → europa.eu (EU institutional portal — generic supranational stem)', () => {
    // Phase D.2 TV audit (p61): "Immobiliare Europa" was matched to
    // europa.eu (the European Union's official institutional portal).
    // The Layer-A reverse-include direction (compactFull.includes
    // (domainStem)) had let "immobiliareeuropa" swallow the 6-char
    // "europa" suffix. Added to COMMON_BARE_STEMS to block the bare
    // generic supranational stem.
    const lead = normalizeLead({
      company_name: 'Immobiliare Europa',
      city: 'Treviso',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Europa', realEstateBody);
    const r = PreVerifyGate.check('https://europa.eu', html, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Studio Belluno → belluno.eu (only token IS the lead city — generic portal)', () => {
    const lead = normalizeLead({
      company_name: 'Studio Belluno SRL',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Belluno', realEstateBody);
    const r = PreVerifyGate.check('https://belluno.eu', html, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/common_stem/);
  });

  it('Iniziative S.p.a. → iniziative.org (For Sale parking page)', () => {
    const lead = normalizeLead({
      company_name: 'Iniziative S.p.A.',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const parked =
      '<html><head><title>iniziative.org - For Sale</title></head><body>' +
      'This domain is for sale. Buy this domain via sedo.com. ' +
      'x'.repeat(900) + '</body></html>';
    const r = PreVerifyGate.check('https://iniziative.org', parked, lead);
    expect(r.status).toBe('REJECTED');
    expect(r.detail).toMatch(/tiny_or_parked/);
  });
});

describe('PreVerifyGate — Phase D audit ACCEPT cases (must remain matched)', () => {
  it('Pierobon → agenziaimmobiliareestimopierobon.com (Layer A full-name)', () => {
    const lead = normalizeLead({
      company_name: 'Agenzia Immobiliare Estimo Pierobon',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Pierobon', `${realEstateBody} Pierobon è la nostra agenzia a Belluno.`);
    const r = PreVerifyGate.check('https://agenziaimmobiliareestimopierobon.com', html, lead);
    expect(r.status).toBe('VERIFIED_SEMANTIC');
    expect(r.evidence).toBe('strong_full_name');
  });

  it('Gecoimmobili → gecoimmobili.it (Layer B brand stem)', () => {
    const lead = normalizeLead({
      company_name: 'Gecoimmobili SRL',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Gecoimmobili', `${realEstateBody} Sede a Belluno.`);
    const r = PreVerifyGate.check('https://gecoimmobili.it', html, lead);
    expect(r.status).toBe('VERIFIED_SEMANTIC');
    expect(r.evidence).toBe('strong_brand');
  });

  it('Giacin → giacin.com (Layer B)', () => {
    const lead = normalizeLead({
      company_name: 'Giacin',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Giacin', `${realEstateBody} Studio Giacin a Belluno.`);
    const r = PreVerifyGate.check('https://giacin.com', html, lead);
    expect(r.status).toBe('VERIFIED_SEMANTIC');
  });

  it('Cortina Properties → cortinaproperties.com (Layer A or B)', () => {
    const lead = normalizeLead({
      company_name: 'Cortina Properties',
      city: 'Cortina',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage(
      'Cortina Properties',
      `${realEstateBody.replace(/Belluno/g, 'Cortina')} Cortina Properties.`
    );
    const r = PreVerifyGate.check('https://cortinaproperties.com', html, lead);
    expect(r.status).toBe('VERIFIED_SEMANTIC');
  });

  it('Andreotta → agenziaandreotta.it (Layer A or B)', () => {
    const lead = normalizeLead({
      company_name: 'Agenzia Andreotta',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('Andreotta', `${realEstateBody} Andreotta a Belluno.`);
    const r = PreVerifyGate.check('https://agenziaandreotta.it', html, lead);
    expect(r.status).toBe('VERIFIED_SEMANTIC');
  });

  it('Agenzia Immobiliare SG → agenziaimmobiliaresg.it (Layer A — long compact full)', () => {
    const lead = normalizeLead({
      company_name: 'Agenzia Immobiliare SG',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const html = htmlPage('SG', `${realEstateBody} SG a Belluno.`);
    const r = PreVerifyGate.check('https://agenziaimmobiliaresg.it', html, lead);
    expect(r.status).toBe('VERIFIED_SEMANTIC');
    expect(r.evidence).toBe('strong_full_name');
  });

  it('DMC Legno → dmclegno.it (Layer B accepts despite mis-categorised sector)', () => {
    // PG mis-categorises this carpentry firm as "agenzie immobiliari".
    // Layer B identity match must still accept — sector conflict is
    // tolerated when identity evidence is strong.
    const lead = normalizeLead({
      company_name: 'DMC Legno',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const carpenteriaBody =
      'Falegnameria e carpenteria in legno con sede a Belluno. Realizziamo strutture ' +
      'in legno lamellare per edilizia, tettoie, pergolati, case in legno a Belluno. ' +
      'Lavorazioni di precisione del legno per progetti residenziali e commerciali. ' +
      ('Servizi di posa in opera in tutto il territorio bellunese. ' +
        'Realizziamo opere su misura per privati e imprese di costruzione. ').repeat(8);
    const html = htmlPage('DMC Legno', carpenteriaBody);
    const r = PreVerifyGate.check('https://dmclegno.it', html, lead);
    expect(r.status).toBe('VERIFIED_SEMANTIC');
  });
});
