import { describe, expect, it } from 'vitest';
import { stripDiacritics } from '../../src/util/text';

describe('stripDiacritics', () => {
  it('strips Italian diacritics', () => {
    expect(stripDiacritics('città')).toBe('citta');
    expect(stripDiacritics('È un lunedì')).toBe('E un lunedi');
    expect(stripDiacritics('idraulico già’assolto')).toBe('idraulico gia’assolto');
  });

  it('leaves ASCII untouched', () => {
    expect(stripDiacritics('Padova 35100')).toBe('Padova 35100');
    expect(stripDiacritics('')).toBe('');
  });

  it('leaves letters without decomposition untouched', () => {
    // ß and ø have no NFD decomposition — they survive, as in every call site
    // this helper replaces (all 13 did plain NFD + combining-mark strip).
    expect(stripDiacritics('Straße')).toBe('Straße');
    expect(stripDiacritics('ø')).toBe('ø');
  });

  it('handles precomposed vs decomposed input identically', () => {
    expect(stripDiacritics('é')).toBe(stripDiacritics('é'));
  });
});
