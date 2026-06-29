import { describe, it, expect } from 'vitest';
import { cleanMojibake, cleanMojibakeFields } from '../../src/discovery/text_cleanup';

describe('cleanMojibake', () => {
  it('returns input unchanged when no replacement char is present (zero-alloc happy path)', () => {
    const s = 'Piazza Libertà, 15';
    expect(cleanMojibake(s)).toBe(s);
  });

  it('strips a U+FFFD run produced by latin-1 mis-decoding', () => {
    // The Belluno canary actually produced this exact pattern.
    expect(cleanMojibake('Piazza Libert��, 15 - 32021 Agordo (BL)')).toBe(
      'Piazza Libert, 15 - 32021 Agordo (BL)'
    );
  });

  it('strips inverted-question-mark mojibake seen in live PG output', () => {
    expect(cleanMojibake('Piazza Libert¿¿, 15 - 32021 Agordo (BL)')).toBe(
      'Piazza Libert, 15 - 32021 Agordo (BL)'
    );
  });

  it('handles a single replacement char too', () => {
    expect(cleanMojibake('Caf� del Centro')).toBe('Caf del Centro');
  });

  it('preserves Italian apostrophes (Cortina d\'Ampezzo)', () => {
    expect(cleanMojibake("Cortina d'Ampezzo")).toBe("Cortina d'Ampezzo");
  });

  it('preserves valid Italian accented letters (à, è, ì, ò, ù)', () => {
    for (const s of ['Libertà', 'Forlì', 'Caffè San Marco', 'Sant\'Egidio', 'Più Casa']) {
      expect(cleanMojibake(s)).toBe(s);
    }
  });

  it('does not collapse double spaces that were already in the input', () => {
    // No replacement char → string is returned untouched on the happy path.
    expect(cleanMojibake('Two  spaces')).toBe('Two  spaces');
  });

  it('tightens whitespace + space-before-comma introduced by stripping', () => {
    expect(cleanMojibake('Piazza Libert� , 15')).toBe('Piazza Libert, 15');
    expect(cleanMojibake('Studio  �  Bianchi')).toBe('Studio Bianchi');
  });

  it('handles undefined / empty', () => {
    expect(cleanMojibake(undefined)).toBeUndefined();
    expect(cleanMojibake('')).toBe('');
  });
});

describe('cleanMojibakeFields', () => {
  it('cleans only the listed fields, leaves others untouched', () => {
    const r = {
      company_name: 'Studio Foo',
      city: 'Milano',
      address: 'Piazza Libert��, 15',
      website: 'https://www.foo.it/path?a=b',  // strings outside the field list — never touched
    };
    cleanMojibakeFields(r, ['company_name', 'city', 'address']);
    expect(r.address).toBe('Piazza Libert, 15');
    expect(r.company_name).toBe('Studio Foo');
    expect(r.city).toBe('Milano');
    expect(r.website).toBe('https://www.foo.it/path?a=b');
  });

  it('skips non-string values gracefully', () => {
    const r = { company_name: 'A', confidence: 0.5, employees_is_estimated: true };
    cleanMojibakeFields(r, ['company_name', 'confidence' as never, 'employees_is_estimated' as never]);
    expect(r.confidence).toBe(0.5);
    expect(r.employees_is_estimated).toBe(true);
  });
});
