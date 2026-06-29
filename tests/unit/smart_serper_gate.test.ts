import { describe, it, expect } from 'vitest';
import { evaluateSerperGate } from '../../src/discovery/website/smart_serper_gate';
import type { Lead } from '../../src/types/lead';
import type { NormalizedLead } from '../../src/types/discovery';

/**
 * R4 — SmartSerperGate 0-network unit tests.
 *
 * The gate is pure: input is a normalized lead + lead, output is a
 * deterministic decision. We test:
 *   - DENY when the lead has no deterministic signal beyond the name
 *   - DENY when the brand reduces to a COMMON_BARE_STEM
 *   - DENY when the name is empty / stop-words-only
 *   - ALLOW when at least one signal exists (vat / phone / email_domain
 *     / pg_url / address+locality)
 *   - the `recommendedQueries` list is filtered to STRONG vectors only
 *   - signal probe trusts both `normalized` and `lead` (defensive)
 */

function makeNorm(p: Partial<NormalizedLead>): NormalizedLead {
  return {
    company_name: p.company_name ?? '',
    company_name_variants: p.company_name_variants ?? [],
    quality_score: p.quality_score ?? 0,
    raw: p.raw ?? ({} as Lead),
    ...p,
  };
}

function makeLead(p: Partial<Lead> = {}): Lead {
  return { company_name: p.company_name ?? 'Foo', ...p };
}

describe('evaluateSerperGate — DENY paths', () => {
  it('denies when the lead has only a company name', () => {
    const norm = makeNorm({ company_name: 'Foo S.r.l.' });
    const r = evaluateSerperGate(norm, makeLead());
    expect(r.allow).toBe(false);
    expect(r.reasons.join(' ')).toContain('deny:no_signal_beyond_name');
    expect(r.signals).toEqual([]);
    expect(r.recommendedQueries).toEqual([]);
  });

  it('denies when the brand is a COMMON_BARE_STEM, even with strong signals', () => {
    const norm = makeNorm({
      company_name: 'Bloom S.r.l.',
      city: 'Padova',
      vat_code: '01234567890',
      phone: '+39 049 1234567',
    });
    const r = evaluateSerperGate(norm, makeLead({ vat_code: '01234567890' }));
    expect(r.allow).toBe(false);
    expect(r.reasons[0]).toContain('deny:common_bare_stem');
    expect(r.recommendedQueries).toEqual([]);
  });

  it('denies when the name reduces to legal-form abbreviations only', () => {
    const norm = makeNorm({
      company_name: 'S.r.l.',
      city: 'Padova',
      vat_code: '01234567890',
    });
    const r = evaluateSerperGate(norm, makeLead());
    expect(r.allow).toBe(false);
    // R2 returns [] for stop-words-only → gate veto fires
    expect(r.reasons.join(' ')).toContain('deny:name_is_stopwords_only');
  });
});

describe('evaluateSerperGate — ALLOW paths', () => {
  it('allows when vat_code is present (P.IVA-only lead)', () => {
    const norm = makeNorm({
      company_name: 'Foo Immobiliare',
      city: 'Padova',
      vat_code: '01234567890',
    });
    const r = evaluateSerperGate(norm, makeLead());
    expect(r.allow).toBe(true);
    expect(r.signals).toContain('vat');
    expect(r.recommendedQueries.length).toBeGreaterThan(0);
    // P.IVA variant must be the highest-priority recommendation
    expect(r.recommendedQueries[0].vector).toBe('piva');
  });

  it('allows when phone is present', () => {
    const norm = makeNorm({
      company_name: 'Foo Immobiliare',
      city: 'Padova',
      phone: '+39 049 1234567',
    });
    const r = evaluateSerperGate(norm, makeLead());
    expect(r.allow).toBe(true);
    expect(r.signals).toContain('phone');
  });

  it('allows when email_domain is present', () => {
    const norm = makeNorm({
      company_name: 'Foo Immobiliare',
      email: 'info@foosrl.com',
      email_domain: 'foosrl.com',
    });
    const r = evaluateSerperGate(norm, makeLead());
    expect(r.allow).toBe(true);
    expect(r.signals).toContain('email_domain');
    // R2's email_domain variant should be in recommended set
    expect(r.recommendedQueries.some((q) => q.vector === 'email_domain')).toBe(true);
  });

  it('allows when pg_url is present (even with no other signal)', () => {
    const norm = makeNorm({ company_name: 'Foo Immobiliare', city: 'Padova' });
    const lead = makeLead({ pg_url: 'https://www.paginegialle.it/foo' });
    const r = evaluateSerperGate(norm, lead);
    expect(r.allow).toBe(true);
    expect(r.signals).toContain('pg_url');
  });

  it('allows when address-with-locality is present', () => {
    const norm = makeNorm({
      company_name: 'Foo Immobiliare',
      city: 'Padova',
      province: 'PD',
      address: 'Via Roma 1, 35100 Padova',
    });
    const r = evaluateSerperGate(norm, makeLead());
    expect(r.allow).toBe(true);
    expect(r.signals).toContain('address_with_locality');
  });

  it('denies when address is present but locality is missing', () => {
    const norm = makeNorm({
      company_name: 'Foo Immobiliare',
      address: 'Via Roma 1, 35100 Padova',
    });
    const r = evaluateSerperGate(norm, makeLead());
    expect(r.allow).toBe(false);
    expect(r.signals).not.toContain('address_with_locality');
  });
});

describe('evaluateSerperGate — recommendedQueries', () => {
  it('drops the weak `official` / `fallback_contact` vectors when stronger ones exist', () => {
    const norm = makeNorm({
      company_name: 'Foo Immobiliare',
      city: 'Padova',
      vat_code: '01234567890',
    });
    const r = evaluateSerperGate(norm, makeLead());
    expect(r.allow).toBe(true);
    for (const q of r.recommendedQueries) {
      expect(q.vector).not.toBe('official');
      expect(q.vector).not.toBe('fallback_contact');
    }
  });

  it('respects maxQueries cap', () => {
    const norm = makeNorm({
      company_name: 'Foo Immobiliare',
      city: 'Padova',
      vat_code: '01234567890',
      phone: '+39 049 1234567',
      email_domain: 'foosrl.com',
      address: 'Via Roma 1, 35100 Padova',
    });
    const r = evaluateSerperGate(norm, makeLead(), { maxQueries: 1 });
    expect(r.allow).toBe(true);
    expect(r.recommendedQueries).toHaveLength(1);
    expect(r.recommendedQueries[0].vector).toBe('piva');
  });

  it('reads signals from the lead when normalized is missing them (defensive)', () => {
    const norm = makeNorm({ company_name: 'Foo Immobiliare', city: 'Padova' });
    const lead = makeLead({ vat_code: '01234567890', phone: '+39 049 9999999' });
    const r = evaluateSerperGate(norm, lead);
    expect(r.allow).toBe(true);
    expect(r.signals).toEqual(expect.arrayContaining(['vat', 'phone']));
  });
});

describe('evaluateSerperGate — common-bare-stem nuance', () => {
  it('vetoes brands whose only distinctive token (after descriptor strip) is a bare stem', () => {
    // "Studio Master Immobiliare" — descriptors {studio, immobiliare}
    // strip out, leaving just `master`. That's a known FP stem
    // (audit D.4 — master.it is an electrical-materials manufacturer,
    // not the lead). The gate is consistent with PreVerifyGate's
    // `hasStrongBrandToken` requirement: a ≥4-char brand token NOT
    // in COMMON_BARE_STEMS. Without one, paid SERP is wasted.
    const norm = makeNorm({
      company_name: 'Studio Master Immobiliare',
      city: 'Padova',
      vat_code: '01234567890',
    });
    const r = evaluateSerperGate(norm, makeLead());
    expect(r.allow).toBe(false);
    expect(r.reasons[0]).toContain('master');
  });

  it('allows multi-token brands when both tokens are distinctive (no bare stem)', () => {
    // "Pierobon Estimo" — neither token is in the denylist, both ≥3
    // chars, no descriptor. Multi-token bare-stem rule does NOT fire.
    const norm = makeNorm({
      company_name: 'Pierobon Estimo Immobiliare',
      city: 'Padova',
      vat_code: '01234567890',
    });
    const r = evaluateSerperGate(norm, makeLead());
    expect(r.allow).toBe(true);
  });

  it('vetoes the single-token bare-stem case', () => {
    const norm = makeNorm({
      company_name: 'Master S.r.l.',
      city: 'Padova',
      vat_code: '01234567890',
    });
    const r = evaluateSerperGate(norm, makeLead());
    expect(r.allow).toBe(false);
    expect(r.reasons[0]).toContain('master');
  });
});
