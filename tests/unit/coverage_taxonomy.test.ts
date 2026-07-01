import { describe, it, expect } from 'vitest';
import { loadAtecoDivisions, atecoDivisionOf, atecoLabel } from '../../src/coverage/ateco';
import { Crosswalk } from '../../src/coverage/crosswalk';
import { IstatAsiaUniverse } from '../../src/coverage/universe';

describe('ATECO taxonomy', () => {
  it('carica le 88 divisioni con sezione e label', () => {
    const d = loadAtecoDivisions();
    expect(d).toHaveLength(88);
    const re = d.find((x) => x.division === '68');
    expect(re?.section).toBe('L');
    expect(atecoLabel('68')).toMatch(/immobiliar/i);
  });

  it('normalizza codici ATECO grezzi alla divisione 2 cifre', () => {
    expect(atecoDivisionOf('68.31')).toBe('68');
    expect(atecoDivisionOf('682010')).toBe('68');
    expect(atecoDivisionOf('291 — Fabbricazione di autoveicoli')).toBe('29');
    expect(atecoDivisionOf('')).toBeUndefined();
    expect(atecoDivisionOf(undefined)).toBeUndefined();
  });
});

describe('Crosswalk categoria -> ATECO', () => {
  const cw = new Crosswalk();

  it('classifica le categorie di produzione', () => {
    expect(cw.classify('agenzie immobiliari')).toBe('68');
    expect(cw.classify('Agenzia Immobiliare')).toBe('68'); // case/accent
    expect(cw.classify('ristorante')).toBe('56');
    expect(cw.classify('centro estetico')).toBe('96');
    expect(cw.classify('studio dentistico')).toBe('86');
  });

  it('disambigua col token piu\' lungo (barbiere != bar)', () => {
    expect(cw.classify('barbiere')).toBe('96'); // non 56 via "bar"
  });

  it('ritorna undefined per categorie ignote', () => {
    expect(cw.classify('categoria inventata xyz')).toBeUndefined();
    expect(cw.classify(undefined)).toBeUndefined();
  });

  it('reverse: keyword per divisione, ordinate', () => {
    const kw = cw.keywordsFor('68');
    expect(kw[0]).toBe('agenzie immobiliari');
    expect(kw.length).toBeGreaterThan(1);
  });
});

const SAMPLE_UNIVERSE = 'data/reference/istat_asia_universe.sample.csv';

describe('IstatAsiaUniverse', () => {
  it('default = dati ISTAT reali (ASIA 2024)', () => {
    const u = new IstatAsiaUniverse();
    expect(u.hasData()).toBe(true);
    const mi = u.count('68', 'MI');
    expect(mi?.activeFirms).toBe(26000); // valore reale ISTAT, verificato contro la fonte
    expect(mi?.provenance).toBe('istat-asia');
    expect(u.count('68', 'PD')?.activeFirms).toBe(6177);
    // sezioni A/O/T/U non coperte da ASIA → divisione 99 assente
    expect(u.count('99', 'AO')).toBeNull();
  });

  it('fixture sample per i test deterministici', () => {
    const s = new IstatAsiaUniverse(SAMPLE_UNIVERSE);
    expect(s.hasData()).toBe(true);
    const c = s.count('68', 'PD');
    expect(c?.activeFirms).toBe(2200);
    expect(c?.provenance).toBe('sample');
    expect(s.count('99', 'AO')).toBeNull();
  });
});
