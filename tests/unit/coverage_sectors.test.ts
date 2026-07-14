import { describe, it, expect } from 'vitest';
import { loadSectors, sectorBySlug } from '../../src/coverage/sectors';
import { atecoIndex } from '../../src/coverage/ateco';
import { Crosswalk } from '../../src/coverage/crosswalk';

// Blindatura dell'espandibilita': se qualcuno aggiunge un settore mal-configurato
// a sectors.json, questi test falliscono invece di lasciar passare un buco.
describe('sectors catalog (espandibilita)', () => {
  const sectors = loadSectors();
  const ateco = atecoIndex();
  const crosswalk = new Crosswalk();

  it('carica i settori con i campi richiesti', () => {
    expect(sectors.length).toBeGreaterThanOrEqual(5);
    for (const s of sectors) {
      expect(s.slug).toBeTruthy();
      expect(s.keyword).toBeTruthy();
      expect(Array.isArray(s.atecoDivisions) && s.atecoDivisions.length).toBeTruthy();
      expect(Array.isArray(s.queryVariants) && s.queryVariants.length).toBeTruthy();
    }
  });

  it('slug unici', () => {
    const slugs = sectors.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('ogni divisione ATECO dichiarata esiste nella tassonomia', () => {
    for (const s of sectors) {
      for (const d of s.atecoDivisions) {
        expect(ateco.has(d), `divisione ${d} (settore ${s.slug}) assente da ateco_divisions.json`).toBe(true);
      }
    }
  });

  it('la keyword di ogni settore e\' classificabile in una delle sue divisioni', () => {
    // garantisce che i lead scrapati per quel settore vengano bucketizzati giusti in coverage
    for (const s of sectors) {
      const div = crosswalk.classify(s.keyword);
      expect(div, `keyword "${s.keyword}" (${s.slug}) non classificata dal crosswalk`).toBeTruthy();
      expect(s.atecoDivisions).toContain(div!);
    }
  });

  it('sectorBySlug funziona', () => {
    expect(sectorBySlug('immobiliare')?.atecoDivisions).toContain('68');
    expect(sectorBySlug('inesistente')).toBeUndefined();
  });
});
