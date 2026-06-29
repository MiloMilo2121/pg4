/**
 * R14 — SerpStage category routing (integration with the real ProviderRouter).
 *
 * Stub SERP providers all return [] so the free pass ends empty (no verify, no
 * network). We assert WHICH providers the router actually called, proving the
 * category policy reaches the router via excludeProviderIds.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { SerpStage } from '../../src/enrichment/stages/serp_stage';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import { CircuitBreaker } from '../../src/runtime/circuit_breaker';
import { createRun, createPerLeadContext } from '../../src/runtime/run_context';
import { resetEnvCache } from '../../src/config/env';
import { ReasonCode as RC } from '../../src/types/output';
import type { Lead } from '../../src/types/lead';
import type { NormalizedLead } from '../../src/types/discovery';
import type { SerpProvider, SerpResult } from '../../src/types/providers';

class StubSerp implements SerpProvider {
  callCount = 0;
  constructor(readonly id: string, readonly tier: number) {}
  readonly family = 'serp' as const;
  readonly costPerCallEur = 0;
  available() {
    return true;
  }
  async search(): Promise<SerpResult[]> {
    this.callCount++;
    return []; // empty → free pass yields nothing, no verify path
  }
}

// Gate-0: dns_mx + crtsh were deleted from the catalog. The remaining free
// SERP set is ddg_lite (gated off for real-estate) + bing_html.
function freeStubs() {
  return {
    ddg_lite: new StubSerp('ddg_lite', 1),
    bing_html: new StubSerp('bing_html', 1),
  };
}

function makeLead(category?: string): { lead: Lead; normalized: NormalizedLead } {
  const lead = { company_name: 'Rossi Casa', category, city: 'Padova' } as Lead;
  const normalized: NormalizedLead = {
    company_name: 'Rossi Casa',
    company_name_variants: [],
    city: 'Padova',
    quality_score: 0.5,
    raw: lead,
  };
  return { lead, normalized };
}

afterEach(() => {
  delete process.env.SERP_EXPANDED_FREE_ENABLED;
  resetEnvCache();
});

describe('SerpStage — R14 category routing', () => {
  it('real-estate: does NOT call ddg_lite, DOES call bing_html', async () => {
    const s = freeStubs();
    const breaker = new CircuitBreaker();
    const router = new ProviderRouter([s.ddg_lite, s.bing_html], [], [], new CostLedger(), breaker);
    const ctx = createPerLeadContext(createRun());
    const { lead, normalized } = makeLead('agenzie immobiliari');

    const out = await new SerpStage(router).run(ctx, lead, normalized);

    expect(s.ddg_lite.callCount).toBe(0);
    expect(s.bing_html.callCount).toBe(1);
    // empty bing → clean not-found, NOT a breaker failure
    expect(out.status).toBe('not_found');
    expect(out.reason_code).toBe(RC.SERP_EMPTY_ALL_PROVIDERS);
    expect(breaker.allow('bing_html')).toBe(true);
  });

  it('generic category: calls all free providers (default behavior preserved)', async () => {
    const s = freeStubs();
    const router = new ProviderRouter([s.ddg_lite, s.bing_html], [], [], new CostLedger());
    const ctx = createPerLeadContext(createRun());
    const { lead, normalized } = makeLead('ristorante');

    await new SerpStage(router).run(ctx, lead, normalized);

    // all return [], so the router exhausts every candidate
    expect(s.ddg_lite.callCount).toBe(1);
    expect(s.bing_html.callCount).toBe(1);
  });

  it('expanded-free override: real-estate calls all free providers again', async () => {
    process.env.SERP_EXPANDED_FREE_ENABLED = 'true';
    resetEnvCache();
    const s = freeStubs();
    const router = new ProviderRouter([s.ddg_lite, s.bing_html], [], [], new CostLedger());
    const ctx = createPerLeadContext(createRun());
    const { lead, normalized } = makeLead('agenzie immobiliari');

    await new SerpStage(router).run(ctx, lead, normalized);

    expect(s.ddg_lite.callCount).toBe(1);
    expect(s.bing_html.callCount).toBe(1);
  });
});
