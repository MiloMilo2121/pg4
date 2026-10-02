import { describe, expect, it } from 'vitest';
import { OpenapiClient, mapAdvanced } from '../../src/providers/openapi_it/openapi_client';

/**
 * Openapi client — base plumbing. NO network here: available() is a pure env read,
 * mapAdvanced/unwrap are pure. The RESPONSE field paths are from the published docs and
 * are PENDING verification against the first real call — so this is a STRUCTURAL test of
 * the mapping wiring, NOT a real-data golden (that ships only after a live response).
 */

describe('OpenapiClient — disabled-by-default gate', () => {
  it('available() is false without OPENAPI_ENABLED + key (paid, off by default)', () => {
    // test env sets neither → schema defaults OPENAPI_ENABLED=false
    expect(new OpenapiClient().available()).toBe(false);
  });
});

describe('mapAdvanced — documented-shape mapping (structural; per-VAT paths PENDING)', () => {
  it('maps identity + address.province + firmographics and keeps raw', () => {
    const json = {
      data: {
        vatCode: '09999990287',
        taxCode: '09999990287',
        companyName: 'AGENZIA IMMOBILIARE ESEMPIO CASE S.R.L.',
        ateco: '68.31',
        address: { registeredOffice: { town: 'Padova', province: 'PD', zipCode: '35100' } },
        activityStatus: 'ATTIVA',
        turnover: 51619,
        employees: '1',
        legalRepresentative: 'Mario Rossi',
      },
    };
    const c = mapAdvanced(json);
    expect(c?.vatCode).toBe('09999990287');
    expect(c?.companyName).toBe('AGENZIA IMMOBILIARE ESEMPIO CASE S.R.L.');
    expect(c?.address?.province).toBe('PD'); // enables the province cross-check
    expect(c?.address?.town).toBe('Padova');
    expect(c?.revenue).toBe(51619);
    expect(c?.employees).toBe('1');
    expect(c?.legalRep).toBe('Mario Rossi');
    expect(c?.raw).toBe(json); // raw kept so the first real call can finalise paths
  });

  it('unwraps a direct (non-{data}) record and tolerates junk', () => {
    expect(mapAdvanced({ vatCode: '09999990287', companyName: 'X SRL' })?.vatCode).toBe('09999990287');
    expect(mapAdvanced(null)).toBeUndefined();
    expect(mapAdvanced('nope')).toBeUndefined();
  });
});
