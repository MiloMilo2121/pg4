import { describe, it, expect } from 'vitest';
import { ProviderBlockError, classifyHttpFailure } from '../../src/types/providers';
import { BingHtmlProvider } from '../../src/providers/serp/bing_html';
import { DdgLiteProvider } from '../../src/providers/serp/ddg_lite';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { SerpProvider, SerpResult } from '../../src/types/providers';

describe('classifyHttpFailure', () => {
  it('maps 429 to rate_limit', () => {
    expect(classifyHttpFailure({ status: 429 })).toBe('rate_limit');
    expect(classifyHttpFailure({ error: 'HTTP 429 too many requests' })).toBe('rate_limit');
  });
  it('maps 5xx + status 0 + network msgs to transport', () => {
    for (const s of [0, 502, 503, 504]) expect(classifyHttpFailure({ status: s })).toBe('transport');
    expect(classifyHttpFailure({ error: 'getaddrinfo ENOTFOUND example.it' })).toBe('transport');
    expect(classifyHttpFailure({ error: 'fetch failed' })).toBe('transport');
  });
  it('maps timeout', () => {
    expect(classifyHttpFailure({ error: 'Request timeout' })).toBe('timeout');
    expect(classifyHttpFailure({ error: 'ETIMEDOUT' })).toBe('timeout');
  });
  it('falls back to other', () => {
    expect(classifyHttpFailure({ error: 'something weird' })).toBe('other');
  });
});

describe('Bing/DDG looksBlocked detection', () => {
  it('Bing detects captcha-container / "verify you are a human"', () => {
    expect(BingHtmlProvider.looksBlocked('<html><body>Please verify you are a human <div class="captcha-container"></div></body></html>')).toBe(true);
    expect(BingHtmlProvider.looksBlocked('<html><body>regular results</body></html>')).toBe(false);
  });

  it('DDG detects "Bots use DuckDuckGo too" anomaly page', () => {
    expect(DdgLiteProvider.looksBlocked('<html><body>If bots use DuckDuckGo too...</body></html>')).toBe(true);
    expect(DdgLiteProvider.looksBlocked('<html><body>Anomaly detected</body></html>')).toBe(true);
    expect(DdgLiteProvider.looksBlocked('<html><body>Normal results</body></html>')).toBe(false);
  });
});

describe('ProviderBlockError construction', () => {
  it('carries the providerId so the router can attribute it', () => {
    const e = new ProviderBlockError('bing_html');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ProviderBlockError');
    expect(e.providerId).toBe('bing_html');
  });
});

describe('ProviderRouter records `blocked` kind on ProviderBlockError', () => {
  class BlockingSerp implements SerpProvider {
    id = 'block_serp';
    family = 'serp' as const;
    tier = 0;
    costPerCallEur = 0;
    available() { return true; }
    async search(): Promise<SerpResult[]> {
      throw new ProviderBlockError(this.id);
    }
  }
  it('ledger entry kind is "blocked"', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([new BlockingSerp()], [], [], ledger);
    await router.search('q');
    const by = ledger.getByProvider();
    expect(by.block_serp.by_kind.blocked).toBe(1);
  });
});

describe('ProviderRouter: SERP empty result is NOT a punitive failure', () => {
  class EmptySerp implements SerpProvider {
    id = 'empty_serp';
    family = 'serp' as const;
    tier = 0;
    costPerCallEur = 0;
    available() { return true; }
    async search(): Promise<SerpResult[]> {
      return [];
    }
  }
  it('records kind="empty" + does NOT trip the breaker even after many empties', async () => {
    const ledger = new CostLedger();
    const router = new ProviderRouter([new EmptySerp()], [], [], ledger);
    router.configureBreaker('empty_serp', { failureThreshold: 2, windowMs: 60_000, cooldownMs: 60_000 });
    for (let i = 0; i < 20; i++) await router.search('q');
    const by = ledger.getByProvider();
    expect(by.empty_serp.by_kind.empty).toBe(20);
    // Breaker should still be closed (allow=true)
    expect(router.describeBreaker().every((s) => s.state !== 'open')).toBe(true);
  });
});
