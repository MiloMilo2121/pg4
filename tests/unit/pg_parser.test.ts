import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parsePagineGialleResults } from '../../src/discovery/sources/pagine_gialle_parser';

const html = (name: string) => fs.readFileSync(path.join(__dirname, '../fixtures/scraper', name), 'utf8');

describe('parsePagineGialleResults — Belluno (normal)', () => {
  const r = parsePagineGialleResults(html('pg_belluno_normal.html'), { category: 'agenzie immobiliari' });

  it('counts cards and drops empty-name ones', () => {
    expect(r.total_cards).toBe(5);
    expect(r.results).toHaveLength(4);
    expect(r.dropped).toBe(1);
  });

  it('does NOT detect overflow on normal page', () => {
    expect(r.overflow).toBe(false);
  });

  it('extracts company name with whitespace + nbsp collapsing', () => {
    const remax = r.results.find((x) => /re\s*\/\s*max/i.test(x.company_name));
    expect(remax).toBeDefined();
    expect(remax!.company_name).toBe('Re/Max Belluno');
  });

  it('extracts address + zip + city + province', () => {
    const studio = r.results.find((x) => x.company_name === 'Studio Immobiliare Dolomiti SRL')!;
    expect(studio.address).toContain('Via Mezzaterra 21');
    expect(studio.zip_code).toBe('32100');
    expect(studio.city).toBe('Belluno');
    expect(studio.province).toBe('BL');
  });

  it('captures the first phone only when multiple are present', () => {
    const cadore = r.results.find((x) => x.company_name === 'Immobiliare Cadore')!;
    expect(cadore.phone).toMatch(/0437\s?00123/);
    // multi-phone card had a 347 mobile too — verify only the first leaked
    expect(cadore.phone?.includes('347')).toBe(false);
  });

  it('captures website but ignores PG/IO/plug.it internal links', () => {
    const studio = r.results.find((x) => x.company_name === 'Studio Immobiliare Dolomiti SRL')!;
    expect(studio.website).toBe('https://www.studiodolomiti.it/');
    const casaBl = r.results.find((x) => /agenzia casa belluno/i.test(x.company_name))!;
    expect(casaBl.website).toBeUndefined(); // only PG + IO internal links → website left empty
  });

  it('captures pg_url from a.remove_blank_for_app', () => {
    const studio = r.results.find((x) => x.company_name === 'Studio Immobiliare Dolomiti SRL')!;
    expect(studio.pg_url).toContain('paginegialle.it/belluno/agenzie-immobiliari/');
    expect(studio.source_url).toBe(studio.pg_url);
  });

  it('keeps city different from search city when card belongs to another comune', () => {
    const remax = r.results.find((x) => /re\s*\/\s*max/i.test(x.company_name))!;
    expect(remax.city).toBe('Sedico');
  });

  it('tags every result with source=PG and the requested category', () => {
    expect(r.results.every((x) => x.source === 'PG')).toBe(true);
    expect(r.results.every((x) => x.category === 'agenzie immobiliari')).toBe(true);
  });
});

describe('parsePagineGialleResults — Milano (overflow)', () => {
  const r = parsePagineGialleResults(html('pg_milano_overflow.html'));
  it('detects the ">200 risultati" banner', () => {
    expect(r.overflow).toBe(true);
  });
  it('still parses the rendered subset (no early exit on overflow)', () => {
    expect(r.results.length).toBeGreaterThanOrEqual(2);
  });
});

describe('parsePagineGialleResults — empty / malformed', () => {
  it('returns empty result for empty HTML', () => {
    const r = parsePagineGialleResults('');
    expect(r.results).toEqual([]);
    expect(r.total_cards).toBe(0);
  });
  it('returns empty result when no .search-itm cards exist', () => {
    const r = parsePagineGialleResults('<!doctype html><html><body><h1>No results</h1></body></html>');
    expect(r.results).toEqual([]);
    expect(r.overflow).toBe(false);
  });
});
