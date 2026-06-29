import { describe, it, expect } from 'vitest';
import {
  PROVINCE_CODES,
  PROVINCE_COMUNI,
  getComuniForProvince,
  parseComuniList,
} from '../../src/discovery/sources/italy_geo';

describe('PROVINCE_CODES', () => {
  it('contains the canonical 110 Italian province sigle (≥107 to allow micro-province movements)', () => {
    expect(PROVINCE_CODES.size).toBeGreaterThanOrEqual(107);
  });
  it('includes the standard set', () => {
    for (const code of ['MI', 'RM', 'TO', 'BL', 'NA', 'BS', 'BO']) {
      expect(PROVINCE_CODES.has(code)).toBe(true);
    }
  });
});

describe('getComuniForProvince', () => {
  it('returns curated list for BL with capital first', () => {
    const c = getComuniForProvince('BL');
    expect(c[0]).toBe('Belluno');
    expect(c).toContain('Feltre');
    expect(c).toContain('Sedico');
  });
  it('is case-insensitive', () => {
    expect(getComuniForProvince('bl')).toEqual(getComuniForProvince('BL'));
  });
  it('returns [] for unknown province code', () => {
    expect(getComuniForProvince('ZZ')).toEqual([]);
  });
  it('returns [] for code that has no curated list yet', () => {
    // CT (Catania) is in PROVINCE_CODES but not in PROVINCE_COMUNI here
    if (PROVINCE_CODES.has('CT') && !('CT' in PROVINCE_COMUNI)) {
      expect(getComuniForProvince('CT')).toEqual([]);
    }
  });
});

describe('parseComuniList', () => {
  it('splits and trims a comma-separated list', () => {
    expect(parseComuniList(' Belluno , Feltre,Sedico ,, ')).toEqual(['Belluno', 'Feltre', 'Sedico']);
  });
  it('returns [] on empty input', () => {
    expect(parseComuniList('')).toEqual([]);
  });
});
