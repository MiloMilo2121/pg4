import { describe, it, expect } from 'vitest';
import {
  normalizeRevenueAmount,
  parseRevenueYear,
  parseItalianRevenueText,
  formatRevenueDisplay,
} from '../../src/enrichment/financial/revenue_parser';

describe('normalizeRevenueAmount', () => {
  it('parses Italian thousands-grouped amounts', () => {
    expect(normalizeRevenueAmount('€ 1.500.000')).toBe(1_500_000);
    expect(normalizeRevenueAmount('40.503.424.402')).toBe(40_503_424_402);
    expect(normalizeRevenueAmount('200.000')).toBe(200_000);
  });
  it('parses Italian decimals with magnitude suffix', () => {
    expect(normalizeRevenueAmount('1,5 mln')).toBe(1_500_000);
    expect(normalizeRevenueAmount('1,2 Mld')).toBe(1_200_000_000);
    expect(normalizeRevenueAmount('200 mila')).toBe(200_000);
  });
  it('parses English-style decimals and compact suffixes', () => {
    expect(normalizeRevenueAmount('1.5M')).toBe(1_500_000);
    expect(normalizeRevenueAmount('500k')).toBe(500_000);
  });
  it('ignores trailing noise words', () => {
    expect(normalizeRevenueAmount('1.500.000 euro')).toBe(1_500_000);
  });
  it('returns undefined for nullish / non-numeric', () => {
    expect(normalizeRevenueAmount(undefined)).toBeUndefined();
    expect(normalizeRevenueAmount('')).toBeUndefined();
    expect(normalizeRevenueAmount('n/a')).toBeUndefined();
  });
});

describe('parseRevenueYear', () => {
  it('prefers a year adjacent to a financial keyword', () => {
    expect(parseRevenueYear('Fatturato 2023: € 1.000.000')).toBe('2023');
    expect(parseRevenueYear('bilancio (2022) depositato')).toBe('2022');
  });
  it('falls back to the most recent plausible year', () => {
    expect(parseRevenueYear('fondata nel 1998, dati riferiti al 2021')).toBe('2021');
  });
  it('returns undefined when no year present', () => {
    expect(parseRevenueYear('nessun dato')).toBeUndefined();
    expect(parseRevenueYear(undefined)).toBeUndefined();
  });
});

describe('parseItalianRevenueText', () => {
  it('extracts amount + year from a labeled sentence', () => {
    const r = parseItalianRevenueText('Fatturato: € 1.500.000 (2022)');
    expect(r.amount).toBe(1_500_000);
    expect(r.year).toBe('2022');
    expect(r.raw).toBeDefined();
  });
  it('handles "ricavi" with a magnitude suffix', () => {
    const r = parseItalianRevenueText('I ricavi 2023 ammontano a 2,3 mln di euro');
    expect(r.amount).toBe(2_300_000);
    expect(r.year).toBe('2023');
  });
  it('handles "volume d\'affari"', () => {
    const r = parseItalianRevenueText("Volume d'affari: 800.000");
    expect(r.amount).toBe(800_000);
  });
  it('returns {} when no revenue present', () => {
    expect(parseItalianRevenueText('azienda di servizi a Milano')).toEqual({});
    expect(parseItalianRevenueText(undefined)).toEqual({});
  });
});

describe('formatRevenueDisplay', () => {
  it('formats with Italian grouping', () => {
    expect(formatRevenueDisplay(1_500_000)).toBe('€ 1.500.000');
  });
  it('returns undefined for undefined', () => {
    expect(formatRevenueDisplay(undefined)).toBeUndefined();
  });
});
