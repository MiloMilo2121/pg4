import { describe, expect, it } from 'vitest';
import { FirecrawlProvider } from '../../src/providers/http/firecrawl';
import { BrightDataUnlockerProvider } from '../../src/providers/http/brightdata';
import { HunterProvider } from '../../src/providers/email/hunter';

describe('FirecrawlProvider', () => {
  const p = new FirecrawlProvider();
  it('declares http family, tier 2, roles, paid cost, default-off', () => {
    expect(p.family).toBe('http');
    expect(p.tier).toBe(2);
    expect(p.costPerCallEur).toBeGreaterThan(0);
    expect(p.roles).toEqual(['WEB_FETCH', 'WEB_UNBLOCK']);
    expect(p.available()).toBe(false);
  });
  it('extractHtml parses v2 data.html and rejects empties', () => {
    expect(FirecrawlProvider.extractHtml({ data: { html: '<html>x</html>' } })).toBe('<html>x</html>');
    expect(FirecrawlProvider.extractHtml({ data: { html: '' } })).toBeUndefined();
    expect(FirecrawlProvider.extractHtml({})).toBeUndefined();
    expect(FirecrawlProvider.extractHtml(null)).toBeUndefined();
  });
});

describe('BrightDataUnlockerProvider', () => {
  const p = new BrightDataUnlockerProvider();
  it('has the distinct id (no breaker keyspace collision with serp)', () => {
    expect(p.id).toBe('brightdata_unlocker');
    expect(p.family).toBe('http');
    expect(p.roles).toEqual(['WEB_FETCH', 'WEB_UNBLOCK']);
    expect(p.available()).toBe(false); // needs ENABLED + token + zone
  });
});

describe('HunterProvider', () => {
  const p = new HunterProvider();
  it('is the email family with per-op cost metas', () => {
    expect(p.family).toBe('email');
    expect(p.available()).toBe(false);
    expect(p.meta('find').costPerCallEur).toBe(0.04);
    expect(p.meta('verify').costPerCallEur).toBe(0.02);
    expect(p.meta('domain').costPerCallEur).toBe(0.04);
    // meta is a CostedMeta usable by router.invoke (cost-safe path)
    expect(p.meta('find').id).toBe('hunter');
    expect(p.meta('find').available()).toBe(false);
  });
  it('parseFinder / parseVerifier / parseDomainSearch', () => {
    expect(HunterProvider.parseFinder({ data: { email: 'a@b.it', score: 92 } })).toEqual({ email: 'a@b.it', score: 92 });
    expect(HunterProvider.parseVerifier({ data: { status: 'valid', score: 99 } })).toEqual({ status: 'valid', score: 99 });
    const emails = HunterProvider.parseDomainSearch({ data: { emails: [{ value: 'x@y.it', type: 'personal', position: 'CEO' }, { nope: 1 }] } });
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ value: 'x@y.it', type: 'personal', position: 'CEO' });
    expect(HunterProvider.parseDomainSearch({})).toEqual([]);
  });
});
