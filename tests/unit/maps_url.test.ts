import { describe, it, expect } from 'vitest';
import { buildMapsSearchUrl } from '../../src/discovery/sources/maps_url';

describe('buildMapsSearchUrl', () => {
  it('produces /maps/search/{q}/?hl=it', () => {
    expect(buildMapsSearchUrl('agenzie immobiliari', 'Feltre')).toBe(
      'https://www.google.com/maps/search/agenzie%20immobiliari%20Feltre/?hl=it'
    );
  });
  it('URL-encodes accented locations', () => {
    expect(buildMapsSearchUrl('cat', 'Cortina d\'Ampezzo')).toContain(encodeURIComponent("cat Cortina d'Ampezzo"));
  });
  it('throws on empty inputs', () => {
    expect(() => buildMapsSearchUrl('', 'Feltre')).toThrow(/category/);
    expect(() => buildMapsSearchUrl('cat', '')).toThrow(/location/);
  });
});
