import { describe, expect, it } from 'vitest';
import { ROLE_REGISTRY, cascadeForRole, rolesForProvider } from '../../src/providers/role_registry';
import { resolveRole } from '../../src/providers/role_resolver';

describe('role registry invariants', () => {
  it('every role has at least one step', () => {
    for (const e of ROLE_REGISTRY) expect(e.steps.length, e.role).toBeGreaterThan(0);
  });

  it('free steps cost 0 and are not paid; paid steps cost > 0 and are paid', () => {
    for (const e of ROLE_REGISTRY) {
      for (const s of e.steps) {
        if (s.paid) expect(s.costEur, `${e.role}/${s.providerId}`).toBeGreaterThan(0);
        else expect(s.costEur, `${e.role}/${s.providerId}`).toBe(0);
      }
    }
  });

  it('forbidden scrapers are never present', () => {
    const ids = ROLE_REGISTRY.flatMap((e) => e.steps.map((s) => s.providerId));
    for (const forbidden of ['google_maps_scrape', 'linkedin_scrape', 'facebook_scrape', 'instagram_scrape']) {
      expect(ids).not.toContain(forbidden);
    }
  });

  it('brightdata is split into distinct ids (no breaker keyspace collision)', () => {
    const ids = new Set(ROLE_REGISTRY.flatMap((e) => e.steps.map((s) => s.providerId)));
    expect(ids.has('brightdata_serp')).toBe(true);
    expect(ids.has('brightdata_unlocker')).toBe(true);
    expect(ids.has('brightdata')).toBe(false);
  });

  it('multi-role providers are exploited', () => {
    expect(rolesForProvider('hunter')).toEqual(expect.arrayContaining(['EMAIL_FIND', 'EMAIL_VERIFY', 'B2B_CONTACT', 'DECISION_MAKER']));
    expect(rolesForProvider('openai').length).toBeGreaterThanOrEqual(3);
  });
});

describe('resolveRole — the cost-safe compiler', () => {
  it('AC1/AC2: free-only run (no paidEnabled) yields ONLY free providers for SEARCH_WEB', () => {
    const r = resolveRole('SEARCH_WEB', { paidEnabled: false });
    expect(r.providerIds).toEqual(['bing_html', 'ddg_lite']);
    expect(r.routeOptions.paidEnabled).toBe(false);
  });

  it('paid run adds the paid SERP tier', () => {
    const r = resolveRole('SEARCH_WEB', { paidEnabled: true });
    expect(r.providerIds).toEqual(expect.arrayContaining(['bing_html', 'serper', 'tavily', 'exa', 'brightdata_serp']));
    expect(r.routeOptions.paidEnabled).toBe(true);
  });

  it('AC5: italian_real_estate excludes ddg_lite + serper from SEARCH_WEB', () => {
    const r = resolveRole('SEARCH_WEB', { paidEnabled: true, categoryProfile: 'italian_real_estate' });
    expect(r.providerIds).not.toContain('ddg_lite');
    expect(r.providerIds).not.toContain('serper');
    expect(r.providerIds).toContain('bing_html');
  });

  it('addendum R6: LLM_CHEAP on a free-only run has NO usable provider (LLM is paid)', () => {
    expect(resolveRole('LLM_CHEAP', { paidEnabled: false }).providerIds).toEqual([]);
    expect(resolveRole('LLM_CHEAP', { paidEnabled: true }).providerIds.length).toBeGreaterThan(0);
  });

  it('AC6: openapi paid deep tier fires ONLY when isTopCompany && onRequest', () => {
    const base = { paidEnabled: true };
    expect(resolveRole('OFFICIAL_COMPANY_DATA', base).providerIds).not.toContain('openapi_advanced');
    expect(resolveRole('OFFICIAL_COMPANY_DATA', { ...base, isTopCompany: true }).providerIds).not.toContain('openapi_advanced');
    const full = resolveRole('OFFICIAL_COMPANY_DATA', { ...base, isTopCompany: true, onRequest: true });
    expect(full.providerIds).toContain('openapi_advanced');
    // free official steps are always present regardless of paid
    expect(resolveRole('OFFICIAL_COMPANY_DATA', { paidEnabled: false }).providerIds).toEqual(expect.arrayContaining(['vies', 'fatturatoitalia']));
  });

  it('REVIEWS_REPUTATION only activates for hospitality category', () => {
    expect(resolveRole('REVIEWS_REPUTATION', { paidEnabled: true }).providerIds).toEqual([]);
    expect(resolveRole('REVIEWS_REPUTATION', { paidEnabled: true, categoryProfile: 'hospitality' }).providerIds).toContain('google_places');
  });

  it('CAPTCHA_SOLVE requires the explicit operator gate', () => {
    expect(resolveRole('CAPTCHA_SOLVE', { paidEnabled: true }).providerIds).toEqual([]);
    expect(resolveRole('CAPTCHA_SOLVE', { paidEnabled: true, explicitGateAllowed: true }).providerIds).toContain('2captcha');
  });

  it('per-lead budget drops steps that cost more than the remaining budget', () => {
    const r = resolveRole('EMAIL_FIND', { paidEnabled: true, remainingLeadBudgetEur: 0.01 });
    expect(r.providerIds).toContain('website_body'); // free always survives
    expect(r.providerIds).not.toContain('hunter'); // 0.04 > 0.01
  });

  it('disabled steps (snov, pattern_guess) never resolve', () => {
    const ids = resolveRole('EMAIL_FIND', { paidEnabled: true }).providerIds;
    expect(ids).not.toContain('snov');
    expect(ids).not.toContain('email_pattern_guess');
    expect(ids).toEqual(['website_body', 'hunter']);
  });

  it('cascadeForRole returns ordered free-before-paid', () => {
    const steps = cascadeForRole('SEARCH_WEB');
    const firstPaidIdx = steps.findIndex((s) => s.paid);
    const lastFreeIdx = steps.map((s) => s.paid).lastIndexOf(false);
    expect(lastFreeIdx).toBeLessThan(firstPaidIdx);
  });
});
