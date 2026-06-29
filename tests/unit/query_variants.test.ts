import { describe, it, expect } from 'vitest';
import {
  buildCompanyQueries,
  sanitizeForQuery,
  EXCLUSION_DORKS,
} from '../../src/discovery/website/query_variants';
import type { NormalizedLead } from '../../src/types/discovery';

/**
 * R2 — `query_variants` 0-network unit tests.
 *
 * The module is pure: input is a `NormalizedLead`, output is an
 * ordered list of `QueryVariant`. We test:
 *   - sanitisation (quotes / specials / 200-char cap)
 *   - stop-word rule (name reduces to legal-form abbreviations)
 *   - vector ordering (P.IVA-first, fallbacks last)
 *   - vector skipping (missing fields don't emit useless variants)
 *   - exclusion-dork inclusion / opt-out
 *   - max-variants cap
 */

function makeLead(p: Partial<NormalizedLead>): NormalizedLead {
  return {
    company_name: p.company_name ?? '',
    company_name_variants: p.company_name_variants ?? [],
    quality_score: p.quality_score ?? 0,
    raw: p.raw ?? ({} as NormalizedLead['raw']),
    ...p,
  };
}

describe('sanitizeForQuery', () => {
  it('drops quote characters (curly + straight + guillemets)', () => {
    expect(sanitizeForQuery('"Foo"')).toBe('Foo');
    expect(sanitizeForQuery('“Foo”')).toBe('Foo');
    expect(sanitizeForQuery('«Foo»')).toBe('Foo');
    expect(sanitizeForQuery("'Foo'")).toBe('Foo');
  });

  it('replaces special chars with space', () => {
    expect(sanitizeForQuery('Foo (S.r.l.)')).toBe('Foo S.r.l.');
    expect(sanitizeForQuery('Foo & Bar')).toBe('Foo Bar');
    expect(sanitizeForQuery('Foo / Bar')).toBe('Foo Bar');
  });

  it('collapses whitespace', () => {
    expect(sanitizeForQuery('  Foo   Bar  ')).toBe('Foo Bar');
  });

  it('truncates to 200 chars', () => {
    const long = 'x'.repeat(250);
    expect(sanitizeForQuery(long).length).toBe(200);
  });

  it('handles empty / undefined', () => {
    expect(sanitizeForQuery('')).toBe('');
    expect(sanitizeForQuery(undefined)).toBe('');
  });
});

describe('buildCompanyQueries — stop-word rule', () => {
  it('returns [] when name is empty', () => {
    const lead = makeLead({ company_name: '' });
    expect(buildCompanyQueries(lead)).toEqual([]);
  });

  it('returns [] when name reduces to legal-form abbreviations only', () => {
    expect(buildCompanyQueries(makeLead({ company_name: 'S.r.l.' }))).toEqual([]);
    expect(buildCompanyQueries(makeLead({ company_name: 'srl' }))).toEqual([]);
    expect(buildCompanyQueries(makeLead({ company_name: 'sas snc' }))).toEqual([]);
    expect(buildCompanyQueries(makeLead({ company_name: 'di e' }))).toEqual([]);
  });

  it('emits variants when name has any non-stop-word token', () => {
    const r = buildCompanyQueries(makeLead({ company_name: 'Foo S.r.l.' }));
    expect(r.length).toBeGreaterThan(0);
  });
});

describe('buildCompanyQueries — vector ordering', () => {
  it('puts P.IVA variant first when vat_code is present', () => {
    const lead = makeLead({
      company_name: 'Foo S.r.l.',
      city: 'Padova',
      vat_code: '01234567890',
    });
    const r = buildCompanyQueries(lead);
    expect(r[0].vector).toBe('piva');
    expect(r[0].query).toContain('"01234567890"');
  });

  it('skips P.IVA variant when vat_code is shorter than 11 digits', () => {
    const lead = makeLead({
      company_name: 'Foo S.r.l.',
      city: 'Padova',
      vat_code: '12345',
    });
    const r = buildCompanyQueries(lead);
    expect(r.find((v) => v.vector === 'piva')).toBeUndefined();
  });

  it('puts email_domain second when present', () => {
    const lead = makeLead({
      company_name: 'Foo S.r.l.',
      email: 'info@foosrl.com',
      email_domain: 'foosrl.com',
    });
    const r = buildCompanyQueries(lead);
    const emailIdx = r.findIndex((v) => v.vector === 'email_domain');
    expect(emailIdx).toBeGreaterThanOrEqual(0);
    expect(r[emailIdx].query).toContain('site:foosrl.com');
    expect(r[emailIdx].query).toContain('"Foo S.r.l."');
  });

  it('derives email_domain from email when email_domain is missing', () => {
    const lead = makeLead({
      company_name: 'Foo',
      email: 'info@foosrl.com',
    });
    const r = buildCompanyQueries(lead);
    const v = r.find((x) => x.vector === 'email_domain');
    expect(v?.query).toContain('site:foosrl.com');
  });

  it('emits exact_name + contact + legal vectors with locality', () => {
    const lead = makeLead({
      company_name: 'Foo S.r.l.',
      city: 'Padova',
      province: 'PD',
    });
    const r = buildCompanyQueries(lead);
    const exact = r.find((v) => v.vector === 'exact_name');
    const contact = r.find((v) => v.vector === 'contact');
    const legal = r.find((v) => v.vector === 'legal');
    expect(exact?.query).toContain('"Foo S.r.l."');
    expect(exact?.query).toContain('"Padova"');
    expect(exact?.query).toContain('"PD"');
    expect(contact?.query).toContain('intitle:');
    expect(contact?.query).toContain('"contatti"');
    expect(legal?.query).toContain('"privacy policy"');
  });

  it('emits phone vector when phone has ≥8 digits (digits only, country code preserved)', () => {
    const lead = makeLead({
      company_name: 'Foo',
      phone: '+39 049 1234567',
    });
    const r = buildCompanyQueries(lead);
    const phone = r.find((v) => v.vector === 'phone');
    // Faithful to pg3 — strip non-digits, country code stays. Serper
    // / Bing tolerate extra-digit prefix; benchmark (R6) will tell us
    // whether dropping the country code lifts recall.
    expect(phone?.query).toContain('"390491234567"');
  });

  it('skips phone vector when phone has fewer than 8 digits', () => {
    const lead = makeLead({
      company_name: 'Foo',
      phone: '049 12',
    });
    const r = buildCompanyQueries(lead);
    expect(r.find((v) => v.vector === 'phone')).toBeUndefined();
  });

  it('emits address vector with only the street part (before comma)', () => {
    const lead = makeLead({
      company_name: 'Foo',
      city: 'Padova',
      address: 'Via Roma 1, 35100 Padova (PD)',
    });
    const r = buildCompanyQueries(lead);
    const addr = r.find((v) => v.vector === 'address');
    expect(addr?.query).toContain('"Via Roma 1"');
    expect(addr?.query).not.toContain('35100');
  });

  it('skips address vector when street is shorter than 6 chars', () => {
    const lead = makeLead({
      company_name: 'Foo',
      address: 'Via',
    });
    const r = buildCompanyQueries(lead);
    expect(r.find((v) => v.vector === 'address')).toBeUndefined();
  });

  it('always emits official + fallback_contact vectors as last priority', () => {
    const lead = makeLead({ company_name: 'Foo', city: 'Padova' });
    const r = buildCompanyQueries(lead);
    const official = r.find((v) => v.vector === 'official');
    const fb = r.find((v) => v.vector === 'fallback_contact');
    expect(official).toBeDefined();
    expect(fb).toBeDefined();
    expect(official!.priority).toBe(8);
    expect(fb!.priority).toBe(9);
    // these two are the LAST two slots (or the last two of the cap)
    const offIdx = r.indexOf(official!);
    const fbIdx = r.indexOf(fb!);
    expect(fbIdx).toBeGreaterThan(offIdx);
  });
});

describe('buildCompanyQueries — exclusions', () => {
  it('embeds the exclusion dork list in evidence-vector queries', () => {
    const lead = makeLead({
      company_name: 'Foo',
      city: 'Padova',
      vat_code: '01234567890',
    });
    const r = buildCompanyQueries(lead);
    for (const v of r) {
      if (v.vector === 'official' || v.vector === 'fallback_contact') continue;
      // every other variant should carry at least one -site: dork
      expect(v.query).toContain('-site:');
    }
  });

  it('omits exclusions when omitExclusions=true', () => {
    const lead = makeLead({ company_name: 'Foo', city: 'Padova' });
    const r = buildCompanyQueries(lead, { omitExclusions: true });
    for (const v of r) {
      expect(v.query).not.toContain('-site:');
    }
  });

  it('respects custom exclusionDorks override', () => {
    const lead = makeLead({ company_name: 'Foo', city: 'Padova' });
    const r = buildCompanyQueries(lead, { exclusionDorks: '-site:custom.example' });
    const withExcl = r.find((v) => v.vector === 'exact_name');
    expect(withExcl?.query).toContain('-site:custom.example');
    expect(withExcl?.query).not.toContain('-site:facebook.com');
  });

  it('EXCLUSION_DORKS contains the most-frequent FP offenders', () => {
    expect(EXCLUSION_DORKS).toContain('-site:paginegialle.it');
    expect(EXCLUSION_DORKS).toContain('-site:facebook.com');
    expect(EXCLUSION_DORKS).toContain('-site:atoka.io');
    expect(EXCLUSION_DORKS).toContain('-site:companyreports.it');
    expect(EXCLUSION_DORKS).toContain('-site:cercacasa.it');
  });
});

describe('buildCompanyQueries — caps and dedupe', () => {
  it('caps the total variants at maxVariants (default 10)', () => {
    const lead = makeLead({
      company_name: 'Foo S.r.l.',
      company_name_variants: ['Foo S.r.l.', 'Foo SRL', 'Foo'],
      city: 'Padova',
      province: 'PD',
      address: 'Via Roma 1, 35100 Padova',
      phone: '+39 049 1234567',
      email: 'info@foo.it',
      email_domain: 'foo.it',
      vat_code: '01234567890',
    });
    const r = buildCompanyQueries(lead);
    expect(r.length).toBeLessThanOrEqual(10);
  });

  it('respects a custom maxVariants override', () => {
    const lead = makeLead({
      company_name: 'Foo',
      city: 'Padova',
      vat_code: '01234567890',
    });
    const r = buildCompanyQueries(lead, { maxVariants: 3 });
    expect(r.length).toBe(3);
    expect(r[0].vector).toBe('piva');
  });

  it('deduplicates identical generated queries', () => {
    // Same name across all variant slots → identical exact_name /
    // contact / legal queries should collapse.
    const lead = makeLead({
      company_name: 'Foo',
      company_name_variants: ['Foo', 'Foo', 'Foo'],
      city: 'Padova',
    });
    const r = buildCompanyQueries(lead);
    const queries = r.map((v) => v.query);
    expect(new Set(queries).size).toBe(queries.length);
  });

  it('truncates each variant to ≤200 chars', () => {
    const lead = makeLead({
      company_name: 'Foo',
      city: 'A really really really long city name that exceeds normal expectations '.repeat(3),
    });
    const r = buildCompanyQueries(lead);
    for (const v of r) {
      expect(v.query.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('buildCompanyQueries — locality fallback', () => {
  it('omits locality dorks when neither city nor province is present', () => {
    const lead = makeLead({ company_name: 'Foo' });
    const r = buildCompanyQueries(lead);
    const exact = r.find((v) => v.vector === 'exact_name');
    expect(exact?.query).not.toContain('"Padova"');
  });

  it('uses province alone when city is missing', () => {
    const lead = makeLead({ company_name: 'Foo', province: 'PD' });
    const r = buildCompanyQueries(lead);
    const exact = r.find((v) => v.vector === 'exact_name');
    expect(exact?.query).toContain('"PD"');
  });
});
