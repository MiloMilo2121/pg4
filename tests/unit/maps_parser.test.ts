import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseGoogleMapsResults } from '../../src/discovery/sources/google_maps_parser';

const html = (name: string) => fs.readFileSync(path.join(__dirname, '../fixtures/scraper', name), 'utf8');

describe('parseGoogleMapsResults — Feltre feed (4 cards)', () => {
  const r = parseGoogleMapsResults(html('maps_feltre_feed.html'), { category: 'agenzie immobiliari' });

  it('parses all 4 visible feed cards', () => {
    expect(r.total_cards).toBe(4);
    expect(r.results).toHaveLength(4);
    expect(r.dropped).toBe(0);
  });

  it('extracts company name from .qBF1Pd', () => {
    expect(r.results.map((x) => x.company_name).sort()).toEqual(
      ['Casa Sicura Servizi Immobiliari', 'Immobiliare Feltre Casa', 'Re/Max Feltre', 'Studio Immobiliare Bellunese'].sort()
    );
  });

  it('classifies info spans into address vs phone', () => {
    const ifc = r.results.find((x) => x.company_name === 'Immobiliare Feltre Casa')!;
    expect(ifc.address).toContain('Via Mezzaterra 14');
    expect(ifc.phone).toContain('+39 0439 00089');
  });

  it('handles "Loc." address prefix variant', () => {
    const cs = r.results.find((x) => x.company_name === 'Casa Sicura Servizi Immobiliari')!;
    expect(cs.address).toContain('Loc. Mugnai');
    expect(cs.phone).toBe('0439 00081');
  });

  it('skips cards with no phone when no phone span is present', () => {
    const sib = r.results.find((x) => x.company_name === 'Studio Immobiliare Bellunese')!;
    expect(sib.phone).toBeUndefined();
    expect(sib.address).toContain('Largo Castaldi 3');
  });

  it('captures website via aria-label fallback selector', () => {
    const remax = r.results.find((x) => x.company_name === 'Re/Max Feltre')!;
    expect(remax.website).toBe('https://www.remaxfeltre.it/');
  });

  it('captures website via data-value="Sito web"', () => {
    const ifc = r.results.find((x) => x.company_name === 'Immobiliare Feltre Casa')!;
    expect(ifc.website).toBe('https://www.feltrecasa.it/');
  });

  it('extracts maps_url from a[href*="/maps/place/"]', () => {
    const ifc = r.results.find((x) => x.company_name === 'Immobiliare Feltre Casa')!;
    expect(ifc.maps_url).toContain('https://www.google.com/maps/place/');
    expect(ifc.source_url).toBe(ifc.maps_url);
  });

  it('parses zip + city + province from address tail', () => {
    const ifc = r.results.find((x) => x.company_name === 'Immobiliare Feltre Casa')!;
    expect(ifc.zip_code).toBe('32032');
    expect(ifc.city).toBe('Feltre');
    expect(ifc.province).toBe('BL');
  });

  it('tags every result with source=MAPS and the requested category', () => {
    expect(r.results.every((x) => x.source === 'MAPS')).toBe(true);
    expect(r.results.every((x) => x.category === 'agenzie immobiliari')).toBe(true);
  });
});

describe('parseGoogleMapsResults — incomplete cards', () => {
  const r = parseGoogleMapsResults(html('maps_incomplete.html'));

  it('drops the empty-name card', () => {
    expect(r.total_cards).toBe(4);
    expect(r.results.length).toBe(3); // 1 dropped
    expect(r.dropped).toBe(1);
  });

  it('falls back to a[aria-label] when .qBF1Pd is missing', () => {
    expect(r.results.some((x) => x.company_name === 'Casa & Co Sedico')).toBe(true);
  });

  it('preserves name-only card when no other fields are present', () => {
    const onlyName = r.results.find((x) => x.company_name === 'Agenzia Sedico')!;
    expect(onlyName.address).toBeUndefined();
    expect(onlyName.phone).toBeUndefined();
    expect(onlyName.website).toBeUndefined();
  });
});

describe('parseGoogleMapsResults — empty / malformed', () => {
  it('returns empty result without a feed container', () => {
    const r = parseGoogleMapsResults('<html><body>no feed</body></html>');
    expect(r.results).toEqual([]);
    expect(r.total_cards).toBe(0);
  });

  it('returns empty result for empty input', () => {
    const r = parseGoogleMapsResults('');
    expect(r.results).toEqual([]);
  });
});
