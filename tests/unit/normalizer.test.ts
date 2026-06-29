import { describe, it, expect } from 'vitest';
import { normalizeLead } from '../../src/discovery/input_normalizer';

describe('normalizeLead', () => {
  it('cleans whitespace and quotes from company_name', () => {
    const out = normalizeLead({ company_name: '  Mario  «Rossi»   SRL  ' });
    expect(out.company_name).toBe('Mario Rossi SRL');
  });

  it('extracts province from "City (BS)" pattern', () => {
    const out = normalizeLead({ company_name: 'Acme', city: 'Caino (BS)' });
    expect(out.city).toBe('Caino');
    expect(out.province).toBe('BS');
  });

  it('extracts province from name suffix and strips it', () => {
    const out = normalizeLead({ company_name: 'Caino (BS) Coiffeur', city: '' });
    expect(out.company_name).toBe('Caino (BS) Coiffeur'); // first regex consumes only when city pattern
    // Re-test: pure name pattern
    const o2 = normalizeLead({ company_name: 'Acme - MI', city: '' });
    expect(o2.province).toBe('MI');
    expect(o2.company_name).toBe('Acme');
  });

  it('produces legal-suffix variants', () => {
    const out = normalizeLead({ company_name: 'Mario Rossi SRL' });
    expect(out.company_name_variants).toContain('Mario Rossi');
    expect(out.company_name_variants).toContain('Mario Rossi SRL');
  });

  it('rejects 10-digit VAT, accepts 11-digit', () => {
    expect(normalizeLead({ company_name: 'A', vat_code: '1234567890' }).vat_code).toBeUndefined();
    expect(normalizeLead({ company_name: 'A', vat_code: 'IT12345678901' }).vat_code).toBe('12345678901');
  });

  it('strips public email domains', () => {
    const out = normalizeLead({ company_name: 'A', email: 'foo@gmail.com' });
    expect(out.email).toBe('foo@gmail.com');
    expect(out.email_domain).toBeUndefined();
  });

  it('keeps business email domains', () => {
    const out = normalizeLead({ company_name: 'A', email: 'sales@example.com' });
    expect(out.email_domain).toBe('example.com');
  });

  it('drops PEC-like domains from email_domain', () => {
    const out = normalizeLead({ company_name: 'A', email: 'foo@pec.example.it' });
    expect(out.email_domain).toBeUndefined();
  });

  it('normalizes Italian phone with +39 prefix', () => {
    const r = normalizeLead({ company_name: 'A', phone: '02 1234567' });
    expect(r.phone?.startsWith('+39')).toBe(true);
    expect(r.phone?.replace(/\D/g, '')).toBe('39021234567');
  });

  it('handles 0039 prefix', () => {
    expect(normalizeLead({ company_name: 'A', phone: '00390212345' }).phone?.startsWith('+39')).toBe(true);
  });

  it('returns quality_score >= 0.85 for fully-populated lead', () => {
    const out = normalizeLead({
      company_name: 'Acme SRL',
      city: 'Milano',
      province: 'MI',
      phone: '02 1234567',
      website: 'https://acme.it',
      vat_code: '12345678901',
    });
    expect(out.quality_score).toBeGreaterThanOrEqual(0.85);
  });

  it('returns quality_score < 0.3 for name-only lead', () => {
    const out = normalizeLead({ company_name: 'Solo Nome' });
    expect(out.quality_score).toBeLessThan(0.3);
  });

  it('normalizes website URL to https + lowercase host + no trailing slash', () => {
    const out = normalizeLead({ company_name: 'A', website: 'WWW.Example.IT/path/' });
    expect(out.website).toBe('https://www.example.it/path');
  });
});
