import { describe, it, expect } from 'vitest';
import { computeLeadScore } from '../../src/enrichment/lead_score';
import type { Lead } from '../../src/types/lead';

const L = (over: Partial<Lead>): Partial<Lead> => over;

describe('computeLeadScore', () => {
  it('bounds: empty lead → 0; everything → ≤ 1', () => {
    expect(computeLeadScore({})).toBe(0);
    const full = computeLeadScore(
      L({
        email_inferred: 'a@b.it',
        email_status: 'deliverable',
        pec: 'a@pec.it',
        phone: '049 1',
        official_website: 'https://b.it',
        vat_code_final: '12345678903',
        revenue: '1000000',
        employees: '5',
        decision_maker_name: 'Mario Rossi',
        rating: '5',
        reviews_count: '200',
        instagram: 'x',
        facebook: 'y',
        linkedin: 'z',
        portal_listings_count: '100',
        portal_is_paid: 'true',
        portal_fiaip: 'true',
      }),
    );
    expect(full).toBeGreaterThan(0.95);
    expect(full).toBeLessThanOrEqual(1);
  });

  it('missing components contribute 0 — more data scores monotonically higher', () => {
    const phoneOnly = computeLeadScore(L({ phone: '049 1' }));
    expect(phoneOnly).toBeCloseTo(0.1, 5);
    const plusEmail = computeLeadScore(L({ phone: '049 1', email_inferred: 'a@b.it', email_status: 'deliverable' }));
    expect(plusEmail).toBeGreaterThan(phoneOnly);
  });

  it('email deliverability ordering: deliverable > unknown/absent-status > invalid', () => {
    const base = { phone: '049 1' };
    const d = computeLeadScore(L({ ...base, email_inferred: 'a@b.it', email_status: 'deliverable' }));
    const u = computeLeadScore(L({ ...base, email_inferred: 'a@b.it' }));
    const c = computeLeadScore(L({ ...base, email_inferred: 'a@b.it', email_status: 'catch_all' }));
    const i = computeLeadScore(L({ ...base, email_inferred: 'a@b.it', email_status: 'invalid' }));
    expect(d).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(u - 1e-9);
    expect(u).toBeGreaterThan(i);
  });

  it('an unverified `website` earns less than a verified official_website', () => {
    const unverified = computeLeadScore(L({ website: 'https://b.it' }));
    const verified = computeLeadScore(L({ official_website: 'https://b.it' }));
    expect(verified).toBeGreaterThan(unverified);
    expect(unverified).toBeGreaterThan(0);
  });

  it('reputation needs volume: 5★ with 0 reviews ≪ 5★ with 100 reviews; comma decimals parse', () => {
    const noReviews = computeLeadScore(L({ rating: '5' }));
    const many = computeLeadScore(L({ rating: '5', reviews_count: '100' }));
    expect(many).toBeGreaterThan(noReviews);
    expect(computeLeadScore(L({ rating: '4,8', reviews_count: '50' }))).toBeGreaterThan(0);
  });

  it('is deterministic and rounded to 3 decimals', () => {
    const lead = L({ phone: '1', email_inferred: 'a@b.it', rating: '4.2', reviews_count: '17' });
    const a = computeLeadScore(lead);
    expect(a).toBe(computeLeadScore(lead));
    expect(Math.round(a * 1000) / 1000).toBe(a);
  });
});
