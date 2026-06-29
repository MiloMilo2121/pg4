import { describe, it, expect } from 'vitest';
import { formatVatForVies, preValidateVat } from '../../src/enrichment/financial/vies';

// These tests exercise ONLY the pure surface (format + checksum gate).
// The live VIES call lives in tests/smoke/vies_smoke.test.ts (RUN_SMOKE=1).

const VALID_IT = '01654010345';

describe('formatVatForVies', () => {
  it('splits an IT-prefixed VAT', () => {
    expect(formatVatForVies('IT01654010345')).toEqual({ countryCode: 'IT', number: VALID_IT });
  });
  it('defaults to IT when no prefix present', () => {
    expect(formatVatForVies('01654010345')).toEqual({ countryCode: 'IT', number: VALID_IT });
  });
  it('keeps an explicit non-IT country code', () => {
    expect(formatVatForVies('DE123456789')).toEqual({ countryCode: 'DE', number: '123456789' });
  });
});

describe('preValidateVat', () => {
  it('passes a checksum-valid IT VAT without touching the network', () => {
    const r = preValidateVat(VALID_IT);
    expect(r).toMatchObject({ isValid: true, checked: false, source: 'checksum' });
  });
  it('fails a checksum-invalid IT VAT', () => {
    const r = preValidateVat('01654010346');
    expect(r.isValid).toBe(false);
    expect(r.source).toBe('checksum');
    expect(r.note).toBe('it_vat_checksum_failed');
  });
  it('fails a malformed IT VAT', () => {
    const r = preValidateVat('123');
    expect(r.isValid).toBe(false);
    expect(r.note).toBe('it_vat_format_invalid');
  });
  it('sanity-checks non-IT VATs by length only', () => {
    expect(preValidateVat('DE123456789').isValid).toBe(true);
    expect(preValidateVat('DE12').isValid).toBe(false);
  });
});
