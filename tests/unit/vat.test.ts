import { describe, it, expect } from 'vitest';
import {
  normalizeVatCode,
  isItalianVatCode,
  validateItalianVatChecksum,
  extractVatCodesFromText,
} from '../../src/enrichment/financial/vat';

// Real, checksum-valid Italian P.IVA values used as fixtures.
const VALID_A = '01654010345'; // checksum OK
const VALID_B = '00159560366'; // checksum OK
const INVALID_CHECKSUM = '01654010346'; // last digit broken

describe('normalizeVatCode', () => {
  it('strips IT prefix, spaces and punctuation', () => {
    expect(normalizeVatCode('IT 01654010345')).toBe('01654010345');
    expect(normalizeVatCode('P.IVA: 0165.4010.345')).toBe('01654010345');
    expect(normalizeVatCode('it01654010345')).toBe('01654010345');
  });
  it('returns empty string for nullish/empty', () => {
    expect(normalizeVatCode(undefined)).toBe('');
    expect(normalizeVatCode(null)).toBe('');
    expect(normalizeVatCode('   ')).toBe('');
  });
  it('does not strip digits that follow a leading non-IT letter pair', () => {
    // only a literal leading "IT" is removed
    expect(normalizeVatCode('AB01654010345')).toBe('01654010345');
  });
});

describe('isItalianVatCode', () => {
  it('accepts exactly 11 digits (format only)', () => {
    expect(isItalianVatCode('01654010345')).toBe(true);
    expect(isItalianVatCode('IT 01654010345')).toBe(true);
  });
  it('rejects wrong length', () => {
    expect(isItalianVatCode('0165401034')).toBe(false); // 10
    expect(isItalianVatCode('016540103450')).toBe(false); // 12
    expect(isItalianVatCode('')).toBe(false);
  });
});

describe('validateItalianVatChecksum', () => {
  it('accepts valid check digits', () => {
    expect(validateItalianVatChecksum(VALID_A)).toBe(true);
    expect(validateItalianVatChecksum(VALID_B)).toBe(true);
    expect(validateItalianVatChecksum('IT ' + VALID_A)).toBe(true);
  });
  it('rejects a broken check digit', () => {
    expect(validateItalianVatChecksum(INVALID_CHECKSUM)).toBe(false);
  });
  it('rejects non-11-digit input', () => {
    expect(validateItalianVatChecksum('123')).toBe(false);
    expect(validateItalianVatChecksum('abcdefghijk')).toBe(false);
    expect(validateItalianVatChecksum(undefined)).toBe(false);
  });
});

describe('extractVatCodesFromText', () => {
  it('finds a labeled P.IVA', () => {
    expect(extractVatCodesFromText(`Partita IVA: ${VALID_A} sede legale Parma`)).toEqual([VALID_A]);
  });
  it('finds an IT-prefixed VAT', () => {
    expect(extractVatCodesFromText(`VAT IT${VALID_A} EU`)).toEqual([VALID_A]);
  });
  it('finds a standalone valid VAT but rejects checksum-invalid 11-digit runs', () => {
    const text = `qualcosa ${INVALID_CHECKSUM} e poi ${VALID_B}`;
    expect(extractVatCodesFromText(text)).toEqual([VALID_B]);
  });
  it('dedupes and preserves order of first appearance', () => {
    const text = `${VALID_A} ... ${VALID_B} ... P.IVA ${VALID_A}`;
    expect(extractVatCodesFromText(text)).toEqual([VALID_A, VALID_B]);
  });
  it('returns [] for empty/nullish', () => {
    expect(extractVatCodesFromText('')).toEqual([]);
    expect(extractVatCodesFromText(undefined)).toEqual([]);
    expect(extractVatCodesFromText('no numbers here')).toEqual([]);
  });
});
