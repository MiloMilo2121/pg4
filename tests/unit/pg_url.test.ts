import { describe, it, expect } from 'vitest';
import { pgSlug, buildPgSearchUrl } from '../../src/discovery/sources/pg_url';

describe('pgSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(pgSlug('Centro Estetico')).toBe('centro-estetico');
  });
  it("strips Italian apostrophes (Cortina d'Ampezzo)", () => {
    expect(pgSlug("Cortina d'Ampezzo")).toBe('cortina-d-ampezzo');
  });
  it('strips diacritics', () => {
    expect(pgSlug("Bardolino — Garda")).toBe('bardolino-garda');
    expect(pgSlug("Sant'Ambrogio")).toBe('sant-ambrogio');
    expect(pgSlug('Forlì')).toBe('forli');
  });
  it('coalesces consecutive hyphens', () => {
    expect(pgSlug('Foo  &  Bar')).toBe('foo-bar');
  });
  it('handles empty', () => {
    expect(pgSlug('')).toBe('');
    expect(pgSlug('   ')).toBe('');
  });
});

describe('buildPgSearchUrl', () => {
  it('produces canonical /ricerca/{cat}/{loc}/p-1', () => {
    expect(buildPgSearchUrl('agenzie immobiliari', 'Belluno')).toBe(
      'https://www.paginegialle.it/ricerca/agenzie-immobiliari/belluno/p-1'
    );
  });
  it('includes 1-indexed page', () => {
    expect(buildPgSearchUrl('agenzie immobiliari', 'Belluno', 3)).toBe(
      'https://www.paginegialle.it/ricerca/agenzie-immobiliari/belluno/p-3'
    );
  });
  it('clamps page to >= 1', () => {
    expect(buildPgSearchUrl('a', 'b', 0)).toContain('/p-1');
    expect(buildPgSearchUrl('a', 'b', -5)).toContain('/p-1');
  });
  it("handles d'-style locations", () => {
    expect(buildPgSearchUrl('agenzie immobiliari', "Cortina d'Ampezzo")).toContain('cortina-d-ampezzo');
  });
  it('throws on empty inputs', () => {
    expect(() => buildPgSearchUrl('', 'Belluno')).toThrow(/category/);
    expect(() => buildPgSearchUrl('cat', '')).toThrow(/location/);
  });
});
