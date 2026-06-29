import { describe, it, expect } from 'vitest';
import {
  expandMapsQueryVariants,
  hasFullCoverageVariants,
} from '../../src/discovery/sources/maps_coverage';

/**
 * R5 — `maps_coverage` 0-network unit tests.
 *
 * The module is pure: input is a category + coverage mode, output is
 * an ordered list of Maps query variants. We test:
 *   - default mode always returns a single-variant list
 *   - full mode expands curated categories
 *   - unknown categories silently fall back to the original
 *   - case / whitespace insensitivity for category lookup
 *   - `hasFullCoverageVariants` reflects the coverage table
 */

describe('expandMapsQueryVariants', () => {
  it('returns a single-element list in default mode', () => {
    expect(expandMapsQueryVariants('agenzie immobiliari', 'default'))
      .toEqual(['agenzie immobiliari']);
    expect(expandMapsQueryVariants('macelleria', 'default'))
      .toEqual(['macelleria']);
  });

  it('expands "agenzie immobiliari" to multiple sector-keyword variants in full mode', () => {
    const r = expandMapsQueryVariants('agenzie immobiliari', 'full');
    expect(r.length).toBeGreaterThan(1);
    expect(r[0]).toBe('agenzie immobiliari'); // most-general first
    expect(r).toContain('agenzia immobiliare');
    expect(r).toContain('mediatore immobiliare');
  });

  it('falls back to the original category when full coverage is unknown', () => {
    expect(expandMapsQueryVariants('barbiere', 'full')).toEqual(['barbiere']);
  });

  it('is case- and whitespace-insensitive for category lookup', () => {
    expect(expandMapsQueryVariants('  Agenzie  Immobiliari  ', 'full').length)
      .toBeGreaterThan(1);
    expect(expandMapsQueryVariants('AGENZIE IMMOBILIARI', 'full').length)
      .toBeGreaterThan(1);
  });

  it('returns a defensive copy (caller cannot mutate the table)', () => {
    const a = expandMapsQueryVariants('agenzie immobiliari', 'full');
    a.push('mutated');
    const b = expandMapsQueryVariants('agenzie immobiliari', 'full');
    expect(b).not.toContain('mutated');
  });
});

describe('hasFullCoverageVariants', () => {
  it('reports true for the curated real-estate category', () => {
    expect(hasFullCoverageVariants('agenzie immobiliari')).toBe(true);
    expect(hasFullCoverageVariants('  AGENZIE   IMMOBILIARI ')).toBe(true);
  });

  it('reports false for unknown categories', () => {
    expect(hasFullCoverageVariants('barbiere')).toBe(false);
    expect(hasFullCoverageVariants('')).toBe(false);
  });
});
