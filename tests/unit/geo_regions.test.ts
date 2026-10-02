import { describe, it, expect } from 'vitest';
import { PROVINCE_CODES } from '../../src/geo/italy_geo';
import {
  NORD_REGIONS,
  NORD_ITALIA_PROVINCES,
  isNordProvince,
  regionForProvince,
  macroForProvince,
} from '../../src/geo/regions';

describe('geo_regions (Nord Italia)', () => {
  it('mappa 8 regioni e 47 province', () => {
    expect(NORD_REGIONS).toHaveLength(8);
    expect(NORD_ITALIA_PROVINCES.size).toBe(47);
  });

  it('ogni sigla del Nord esiste in PROVINCE_CODES', () => {
    for (const p of NORD_ITALIA_PROVINCES) expect(PROVINCE_CODES.has(p)).toBe(true);
  });

  it('classifica le province (case-insensitive)', () => {
    expect(isNordProvince('mi')).toBe(true);
    expect(regionForProvince('PD')).toBe('Veneto');
    expect(macroForProvince('PD')).toBe('Nord-Est');
    expect(macroForProvince('MI')).toBe('Nord-Ovest');
  });

  it('esclude province non-Nord', () => {
    expect(isNordProvince('RM')).toBe(false);
    expect(isNordProvince('NA')).toBe(false);
    expect(regionForProvince('RM')).toBeUndefined();
  });

  it('nessuna provincia in due regioni', () => {
    const all = NORD_REGIONS.flatMap((r) => r.provinces);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('provinceForComune (lookup comune → sigla)', async () => {
  const { provinceForComune } = await import('../../src/geo/comune_lookup.js');

  it('risolve i capoluoghi e i comuni minori (case/accent-insensitive)', () => {
    expect(provinceForComune('Padova')).toBe('PD');
    expect(provinceForComune('padova')).toBe('PD');
    expect(provinceForComune("Cortina d'Ampezzo")).toBe('BL');
    expect(provinceForComune('Forlì')).toBe('FC');
  });

  it('risolve le forme bilingui altoatesine (metà singola)', () => {
    expect(provinceForComune('Bolzano')).toBe('BZ');
    expect(provinceForComune('Bozen')).toBe('BZ');
  });

  it('sconosciuti e ambigui → undefined (mai indovinare)', () => {
    expect(provinceForComune('Roma')).toBeUndefined(); // fuori Nord
    expect(provinceForComune('ComuneInventato')).toBeUndefined();
    expect(provinceForComune('')).toBeUndefined();
    expect(provinceForComune(undefined)).toBeUndefined();
  });
});
