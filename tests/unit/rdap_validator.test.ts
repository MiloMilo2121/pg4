import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { CircuitBreaker } from '../../src/runtime/circuit_breaker';
import { RateLimiter } from '../../src/runtime/rate_limiter';
import { EndpointGuard, publicRegistryGuard } from '../../src/runtime/endpoint_guard';
import fs from 'fs';
import path from 'path';
import { RdapValidator } from '../../src/discovery/website/rdap_validator';
import { normalizeLead } from '../../src/discovery/input_normalizer';

const fixt = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8'));

describe('RdapValidator.score', () => {
  it('returns 0.9 piva_in_payload when P.IVA appears in JSON', () => {
    const payload = fixt('rdap_acme_piva.json');
    const lead = normalizeLead({ company_name: 'Acme Italia SRL', vat_code: '12345678901' });
    const r = RdapValidator.score(payload, lead);
    expect(r.evidence).toBe('piva_in_payload');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('returns 0.4 name_in_vcard for strong vCard fn match', () => {
    const payload = fixt('rdap_acme_piva.json');
    // Same fixture but pretend we don't know the P.IVA — score the name only.
    const lead = normalizeLead({ company_name: 'Acme Italia SRL' });
    const r = RdapValidator.score(payload, lead);
    expect(r.evidence).toBe('name_in_vcard');
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it('returns 0 for unrelated registrant payload', () => {
    const payload = fixt('rdap_unrelated.json');
    const lead = normalizeLead({ company_name: 'Acme Italia SRL', vat_code: '99999999999' });
    const r = RdapValidator.score(payload, lead);
    expect(r.evidence).toBe('none');
    expect(r.confidence).toBe(0);
  });

  it('returns 0 for null/empty payload', () => {
    const lead = normalizeLead({ company_name: 'Acme' });
    expect(RdapValidator.score(null, lead).confidence).toBe(0);
    expect(RdapValidator.score({}, lead).confidence).toBe(0);
  });

  it('does not match on tokens shorter than 3 chars', () => {
    const payload = { entities: [{ vcardArray: ['vcard', [['fn', {}, 'text', 'x y z']]] }] };
    const lead = normalizeLead({ company_name: 'A B C' });
    expect(RdapValidator.score(payload, lead).confidence).toBe(0);
  });
});

describe('RdapValidator.checkDomainOwnership — shared rate limit and circuit breaker', () => {
  class SpyLimiter extends RateLimiter {
    readonly acquired: string[] = [];
    override async acquire(key: string): Promise<void> {
      this.acquired.push(key);
    }
  }

  let agent: MockAgent;
  let previous: Dispatcher;
  let now: number;
  let rate: SpyLimiter;
  let guard: EndpointGuard;
  const lead = normalizeLead({ company_name: 'Acme Italia SRL', vat_code: '12345678901' });

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    now = 1_000;
    rate = new SpyLimiter();
    guard = new EndpointGuard(new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 120_000 }, { now: () => now }), rate);
  });
  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(previous);
  });

  const nicIt = () => agent.get('https://rdap.nic.it');

  it('takes a token from the registry key before every request', async () => {
    nicIt().intercept({ path: '/domain/acme.it', method: 'GET' }).reply(200, fixt('rdap_acme_piva.json'));
    agent.get('https://rdap.org').intercept({ path: '/domain/acme.com', method: 'GET' }).reply(404, '');
    await RdapValidator.checkDomainOwnership('acme.it', lead, { guard });
    await RdapValidator.checkDomainOwnership('acme.com', lead, { guard });
    expect(rate.acquired).toEqual(['rdap.nic.it', 'rdap.org']);
  });

  it('opens after 5 server failures and stops calling the registry; half-opens after the cool-down', async () => {
    nicIt().intercept({ path: /\/domain\//, method: 'GET' }).reply(503, '').times(5);
    for (let i = 0; i < 5; i++) {
      expect((await RdapValidator.checkDomainOwnership(`acme${i}.it`, lead, { guard })).detail).toBe('http_503');
    }
    // Open: no request leaves (disableNetConnect would surface one as error_…).
    expect(await RdapValidator.checkDomainOwnership('acme5.it', lead, { guard })).toEqual({ confidence: 0, evidence: 'none', detail: 'rdap_circuit_open' });
    expect(rate.acquired).toHaveLength(5);

    now += 120_000;
    nicIt().intercept({ path: '/domain/acme.it', method: 'GET' }).reply(200, fixt('rdap_acme_piva.json'));
    expect((await RdapValidator.checkDomainOwnership('acme.it', lead, { guard })).evidence).toBe('piva_in_payload');
    agent.assertNoPendingInterceptors();
  });

  it('counts transport errors (the ENOTFOUND storm) toward the breaker', async () => {
    nicIt().intercept({ path: /\/domain\//, method: 'GET' }).replyWithError(new Error('getaddrinfo ENOTFOUND rdap.nic.it')).times(5);
    for (let i = 0; i < 5; i++) await RdapValidator.checkDomainOwnership(`acme${i}.it`, lead, { guard });
    expect((await RdapValidator.checkDomainOwnership('acme5.it', lead, { guard })).detail).toBe('rdap_circuit_open');
  });

  it('a 404 is the registry answering, not failing: it never opens the breaker', async () => {
    nicIt().intercept({ path: /\/domain\//, method: 'GET' }).reply(404, '').times(7);
    for (let i = 0; i < 7; i++) {
      expect((await RdapValidator.checkDomainOwnership(`nope${i}.it`, lead, { guard })).detail).toBe('http_404');
    }
    agent.assertNoPendingInterceptors();
  });

  it('does not count the caller aborting (lead deadline) against the registry', async () => {
    nicIt().intercept({ path: /\/domain\//, method: 'GET' }).reply(200, fixt('rdap_acme_piva.json')).delay(1_000).times(6);
    for (let i = 0; i < 6; i++) {
      const r = await RdapValidator.checkDomainOwnership(`acme${i}.it`, lead, { guard, signal: AbortSignal.abort() });
      expect(r.detail).toMatch(/^error_/);
    }
    expect(rate.acquired).toHaveLength(6); // never opened: every call still went out
  });

  it('keeps the two registries apart: rdap.org down does not block rdap.nic.it', async () => {
    agent.get('https://rdap.org').intercept({ path: /\/domain\//, method: 'GET' }).reply(502, '').times(5);
    for (let i = 0; i < 5; i++) await RdapValidator.checkDomainOwnership(`acme${i}.com`, lead, { guard });
    nicIt().intercept({ path: '/domain/acme.it', method: 'GET' }).reply(200, fixt('rdap_acme_piva.json'));
    expect((await RdapValidator.checkDomainOwnership('acme.it', lead, { guard })).evidence).toBe('piva_in_payload');
    expect((await RdapValidator.checkDomainOwnership('acme9.com', lead, { guard })).detail).toBe('rdap_circuit_open');
  });

  it('goes through the process-wide guard when none is injected', async () => {
    const admit = vi.spyOn(publicRegistryGuard, 'admit').mockResolvedValue(false);
    try {
      expect((await RdapValidator.checkDomainOwnership('acme.it', lead)).detail).toBe('rdap_circuit_open');
      expect(admit).toHaveBeenCalledWith('rdap.nic.it');
    } finally {
      admit.mockRestore();
    }
  });
});

describe('RdapValidator.checkDomainOwnership — queries the registrable domain', () => {
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(previous);
  });

  it.each([
    ['a subdomain', 'https://shop.acme.it/prodotti', 'rdap.nic.it', '/domain/acme.it'],
    ['www', 'www.acme.it', 'rdap.nic.it', '/domain/acme.it'],
    ['a province suffix', 'https://www.acme.pd.it', 'rdap.nic.it', '/domain/acme.pd.it'],
    ['a second-level ccTLD', 'shop.acme.co.uk', 'rdap.org', '/domain/acme.co.uk'],
  ])('for %s (%s) asks %s%s', async (_label, input, host, path) => {
    agent.get(`https://${host}`).intercept({ path, method: 'GET' }).reply(200, fixt('rdap_acme_piva.json'), {
      headers: { 'content-type': 'application/rdap+json' },
    });
    const lead = normalizeLead({ company_name: 'Acme Italia SRL', vat_code: '12345678901' });
    const r = await RdapValidator.checkDomainOwnership(input, lead);
    expect(r.evidence).toBe('piva_in_payload');
    agent.assertNoPendingInterceptors();
  });

  it('skips a hosting tenant: the platform registrant says nothing about the firm', async () => {
    const lead = normalizeLead({ company_name: 'Studio Foo' });
    const r = await RdapValidator.checkDomainOwnership('https://studiofoo.altervista.org', lead);
    expect(r).toEqual({ confidence: 0, evidence: 'none', detail: 'no_registry_domain' });
  });
});
