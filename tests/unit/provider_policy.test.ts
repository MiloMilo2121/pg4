/**
 * R14 — free SERP routing policy + router denylist.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSerpProfile,
  resolveFreeSerpRoute,
  LOW_YIELD_REAL_ESTATE_SERP,
} from '../../src/providers/provider_policy';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import type { SerpProvider, SerpResult } from '../../src/types/providers';

describe('resolveSerpProfile', () => {
  it.each([
    'agenzie immobiliari',
    'agenzia immobiliare',
    'consulenza immobiliare',
    'compravendita immobiliare',
    'mediatore immobiliare',
    'AGENZIE IMMOBILIARI', // case-insensitive
  ])('maps "%s" → italian_real_estate', (cat) => {
    expect(resolveSerpProfile(cat)).toBe('italian_real_estate');
  });

  it.each(['ristorante', 'idraulico', 'studio dentistico', '', undefined])(
    'maps "%s" → default',
    (cat) => {
      expect(resolveSerpProfile(cat as string | undefined)).toBe('default');
    },
  );
});

describe('resolveFreeSerpRoute', () => {
  it('real-estate (no expanded) gates off the low-yield ddg_lite', () => {
    // Gate-0: dns_mx + crtsh were deleted from the catalog; only ddg_lite
    // remains to gate on the real-estate profile.
    const r = resolveFreeSerpRoute('agenzie immobiliari', false);
    expect(r.profile).toBe('italian_real_estate');
    expect([...r.excludeProviderIds].sort()).toEqual(['ddg_lite']);
  });

  it('real-estate with expandedFree excludes nothing (full free set)', () => {
    const r = resolveFreeSerpRoute('agenzia immobiliare', true);
    expect(r.profile).toBe('italian_real_estate');
    expect(r.excludeProviderIds).toEqual([]);
  });

  it('unknown category excludes nothing (default behavior preserved)', () => {
    const r = resolveFreeSerpRoute('ristorante', false);
    expect(r.profile).toBe('default');
    expect(r.excludeProviderIds).toEqual([]);
  });

  it('never excludes bing_html or the paid serper', () => {
    const r = resolveFreeSerpRoute('agenzie immobiliari', false);
    expect(r.excludeProviderIds).not.toContain('bing_html');
    expect(r.excludeProviderIds).not.toContain('serper');
    expect(LOW_YIELD_REAL_ESTATE_SERP).not.toContain('bing_html');
  });
});

// ---- router-level denylist ----

class FakeSerp implements SerpProvider {
  callCount = 0;
  constructor(readonly id: string, readonly tier: number) {}
  readonly family = 'serp' as const;
  readonly costPerCallEur = 0;
  available() {
    return true;
  }
  async search(): Promise<SerpResult[]> {
    this.callCount++;
    return [{ title: this.id, url: `https://${this.id}.example`, snippet: '', rank: 1, source_provider: this.id }];
  }
}

describe('ProviderRouter — excludeProviderIds (R14)', () => {
  // Generic exclusion mechanism (still used to gate ddg_lite on the
  // real-estate profile). Uses neutral free-SERP stub ids — not the deleted
  // dns_mx/crtsh — so the test exercises the mechanism, not gone providers.
  it('skips excluded providers, runs the rest', async () => {
    const free0 = new FakeSerp('ddg_lite', 0);
    const free0b = new FakeSerp('free_x', 0);
    const bing = new FakeSerp('bing_html', 1);
    const router = new ProviderRouter([free0, free0b, bing], [], [], new CostLedger());

    const out = await router.search('q', { maxTier: 1, excludeProviderIds: ['ddg_lite', 'free_x'] });

    expect(free0.callCount).toBe(0);
    expect(free0b.callCount).toBe(0);
    // bing (tier 1) is the first non-excluded candidate and returns a result.
    expect(out.provider).toBe('bing_html');
    expect(bing.callCount).toBe(1);
  });

  it('no exclusions → first candidate by tier wins (unchanged behavior)', async () => {
    const free0 = new FakeSerp('ddg_lite', 0);
    const bing = new FakeSerp('bing_html', 1);
    const router = new ProviderRouter([free0, bing], [], [], new CostLedger());

    const out = await router.search('q', { maxTier: 1 });

    expect(free0.callCount).toBe(1); // tier 0 tried first, returns a result
    expect(out.provider).toBe('ddg_lite');
    expect(bing.callCount).toBe(0); // router returns on first success
  });
});
