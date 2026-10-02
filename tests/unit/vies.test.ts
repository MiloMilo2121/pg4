import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { checkVatViaVies, formatVatForVies, preValidateVat } from '../../src/enrichment/financial/vies';
import { CircuitBreaker } from '../../src/runtime/circuit_breaker';
import { RateLimiter } from '../../src/runtime/rate_limiter';
import { EndpointGuard, publicRegistryGuard } from '../../src/runtime/endpoint_guard';

// The pure surface (format + checksum gate) and the network boundary through
// undici's MockAgent. The live VIES call lives in tests/smoke/vies_smoke.test.ts
// (RUN_SMOKE=1).

const VALID_IT = '01654010345';

describe('formatVatForVies', () => {
  it('splits an IT-prefixed VAT', () => {
    expect(formatVatForVies('IT01654010345')).toEqual({ countryCode: 'IT', number: VALID_IT });
  });
  it('defaults to IT when no prefix present', () => {
    expect(formatVatForVies('01654010345')).toEqual({ countryCode: 'IT', number: VALID_IT });
  });
  it('keeps an explicit non-IT country code', () => {
    expect(formatVatForVies('DE123456789')).toEqual({ countryCode: 'DE', number: '123456789' });
  });
});

describe('preValidateVat', () => {
  it('passes a checksum-valid IT VAT without touching the network', () => {
    const r = preValidateVat(VALID_IT);
    expect(r).toMatchObject({ isValid: true, checked: false, source: 'checksum' });
  });
  it('fails a checksum-invalid IT VAT', () => {
    const r = preValidateVat('01654010346');
    expect(r.isValid).toBe(false);
    expect(r.source).toBe('checksum');
    expect(r.note).toBe('it_vat_checksum_failed');
  });
  it('fails a malformed IT VAT', () => {
    const r = preValidateVat('123');
    expect(r.isValid).toBe(false);
    expect(r.note).toBe('it_vat_format_invalid');
  });
  it('sanity-checks non-IT VATs by length only', () => {
    expect(preValidateVat('DE123456789').isValid).toBe(true);
    expect(preValidateVat('DE12').isValid).toBe(false);
  });
});

describe('checkVatViaVies — shared rate limit and circuit breaker', () => {
  class SpyLimiter extends RateLimiter {
    readonly acquired: string[] = [];
    override async acquire(key: string): Promise<void> {
      this.acquired.push(key);
    }
  }

  const ORIGIN = 'https://ec.europa.eu';
  const PATH = `/taxation_customs/vies/rest-api/ms/IT/vat/${VALID_IT}`;
  let agent: MockAgent;
  let previous: Dispatcher;
  let now: number;
  let rate: SpyLimiter;
  let guard: EndpointGuard;

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

  const vies = () => agent.get(ORIGIN).intercept({ path: PATH, method: 'GET' });
  const answer = (body: object) => vies().reply(200, body, { headers: { 'content-type': 'application/json' } });

  it('takes a VIES token before the request, and none for a checksum failure', async () => {
    answer({ isValid: true, userError: 'VALID', name: 'ESEMPIO SPA', address: 'VIA ROMA 1' });
    expect(await checkVatViaVies({ vatNumber: VALID_IT }, { guard })).toMatchObject({ isValid: true, checked: true, source: 'vies', name: 'ESEMPIO SPA' });
    expect(await checkVatViaVies({ vatNumber: '01654010346' }, { guard })).toMatchObject({ source: 'checksum' });
    expect(rate.acquired).toEqual(['vies']);
  });

  it('opens after 5 failures, answers provisionally without calling VIES, half-opens after the cool-down', async () => {
    vies().reply(503, '').times(5);
    for (let i = 0; i < 5; i++) {
      expect(await checkVatViaVies({ vatNumber: VALID_IT }, { guard })).toMatchObject({ provisional: true, note: 'vies_unavailable' });
    }
    expect(await checkVatViaVies({ vatNumber: VALID_IT }, { guard })).toEqual({
      isValid: true,
      checked: false,
      source: 'provisional',
      provisional: true,
      note: 'vies_circuit_open',
    });
    expect(rate.acquired).toHaveLength(5);

    now += 120_000;
    answer({ isValid: true, userError: 'VALID' });
    expect(await checkVatViaVies({ vatNumber: VALID_IT }, { guard })).toMatchObject({ checked: true, source: 'vies' });
    agent.assertNoPendingInterceptors();
  });

  it('reads a busy VIES (200 + MS_MAX_CONCURRENT_REQ) as unchecked, not invalid, and counts it', async () => {
    for (let i = 0; i < 5; i++) answer({ isValid: false, userError: 'MS_MAX_CONCURRENT_REQ' });
    for (let i = 0; i < 5; i++) {
      expect(await checkVatViaVies({ vatNumber: VALID_IT }, { guard })).toMatchObject({
        isValid: true,
        checked: false,
        provisional: true,
        note: 'vies_ms_max_concurrent_req',
      });
    }
    expect((await checkVatViaVies({ vatNumber: VALID_IT }, { guard })).note).toBe('vies_circuit_open');
  });

  it('reads a 429 as throttling (unchecked), not as VIES saying the VAT is invalid', async () => {
    vies().reply(429, '');
    expect(await checkVatViaVies({ vatNumber: VALID_IT }, { guard })).toMatchObject({ isValid: true, checked: false, provisional: true });
  });

  it('a VIES "invalid" is an answer, not a failure: it never opens the breaker', async () => {
    for (let i = 0; i < 7; i++) answer({ isValid: false, userError: 'INVALID' });
    for (let i = 0; i < 7; i++) {
      expect(await checkVatViaVies({ vatNumber: VALID_IT }, { guard })).toEqual({ isValid: false, checked: true, source: 'vies' });
    }
    agent.assertNoPendingInterceptors();
  });

  it('counts network errors toward the breaker', async () => {
    vies().replyWithError(new Error('getaddrinfo ENOTFOUND ec.europa.eu')).times(5);
    for (let i = 0; i < 5; i++) expect((await checkVatViaVies({ vatNumber: VALID_IT }, { guard })).note).toBe('vies_unreachable');
    expect((await checkVatViaVies({ vatNumber: VALID_IT }, { guard })).note).toBe('vies_circuit_open');
  });

  it('goes through the process-wide guard when none is injected', async () => {
    const admit = vi.spyOn(publicRegistryGuard, 'admit').mockResolvedValue(false);
    try {
      expect((await checkVatViaVies({ vatNumber: VALID_IT })).note).toBe('vies_circuit_open');
      expect(admit).toHaveBeenCalledWith('vies');
    } finally {
      admit.mockRestore();
    }
  });
});
