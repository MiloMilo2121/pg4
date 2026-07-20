import { describe, expect, it } from 'vitest';
import { fingerprintFor, DEFAULT_USER_AGENT, USER_AGENTS } from '../../src/runtime/fingerprint';

describe('fingerprint', () => {
  it('exposes a non-empty pool of realistic (non-bot) browser UAs', () => {
    expect(USER_AGENTS.length).toBeGreaterThanOrEqual(3);
    for (const ua of USER_AGENTS) {
      expect(ua).toMatch(/Mozilla\/5\.0/); // real browser shape
      expect(ua).not.toMatch(/pg4|github|bot/i); // never a declared bot
    }
  });

  it('is DETERMINISTIC per seed (fixture-safe): same host → same identity', () => {
    const a = fingerprintFor('studiorossi.it');
    const b = fingerprintFor('studiorossi.it');
    expect(a.userAgent).toBe(b.userAgent);
    expect(a.headers).toEqual(b.headers);
  });

  it('distributes different hosts across the pool (not all identical)', () => {
    const seeds = ['a.it', 'b.it', 'c.it', 'd.it', 'e.it', 'f.it', 'g.it', 'h.it'];
    const uas = new Set(seeds.map((s) => fingerprintFor(s).userAgent));
    expect(uas.size).toBeGreaterThan(1);
  });

  it('no seed → the pool head (DEFAULT_USER_AGENT)', () => {
    expect(fingerprintFor().userAgent).toBe(DEFAULT_USER_AGENT);
  });

  it('emits coherent headers: UA matches the user-agent header, it-IT language', () => {
    const fp = fingerprintFor('example.com');
    expect(fp.headers['user-agent']).toBe(fp.userAgent);
    expect(fp.headers['accept-language']).toMatch(/^it-IT/);
    expect(fp.headers['sec-fetch-mode']).toBe('navigate');
  });

  it('sends sec-ch-ua ONLY for Chromium UAs (Firefox omits client hints)', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      const fp = fingerprintFor(seed);
      const isChrome = fp.userAgent.includes('Chrome');
      if (isChrome) {
        expect(fp.headers['sec-ch-ua']).toBeDefined();
        expect(fp.headers['sec-ch-ua-platform']).toBeDefined();
      } else {
        expect(fp.headers['sec-ch-ua']).toBeUndefined();
      }
    }
  });
});
