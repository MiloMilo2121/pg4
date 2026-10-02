import { describe, it, expect, vi, afterEach } from 'vitest';
import { runEnrichmentPipeline } from '../../src/enrichment/enrichment_pipeline';
import { ApifyBilanciStage } from '../../src/enrichment/stages/apify_bilanci_stage';
import { ApifyMapsStage } from '../../src/enrichment/stages/apify_maps_stage';
import { ApifyRegistroStage } from '../../src/enrichment/stages/apify_registro_stage';
import { PerplexityResolveStage } from '../../src/enrichment/stages/perplexity_resolve_stage';
import { InputWebsiteStage } from '../../src/enrichment/stages/input_website_stage';
import { RdapBoostStage } from '../../src/enrichment/stages/rdap_stage';
import { SerpStage } from '../../src/enrichment/stages/serp_stage';
import { verifyCandidates } from '../../src/enrichment/website/verify_candidates';
import { RdapValidator } from '../../src/discovery/website/rdap_validator';
import { normalizeLead } from '../../src/discovery/input_normalizer';
import { ProviderRouter } from '../../src/providers/provider_router';
import type { RouteOptions } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import { CircuitBreaker } from '../../src/runtime/circuit_breaker';
import { createPerLeadContext, createRun } from '../../src/runtime/run_context';
import type { Stage, StageRunOptions } from '../../src/types/enrichment';
import type { StageOutcome } from '../../src/types/output';
import { ReasonCode } from '../../src/types/output';
import type { HttpFetchResult, HttpProvider, SerpProvider } from '../../src/types/providers';
import type { Lead } from '../../src/types/lead';

// Every host is dead: no unit test reaches the network.
const deadDns = async () => Promise.reject(new Error('ENOTFOUND'));
const lead = (): Lead => ({ company_name: 'Hung Srl', city: 'Padova', province: 'PD' });

/** A stage that never settles unless the signal it is given aborts. */
function hungStage(name: string, honorSignal: boolean): Stage & { seen: AbortSignal[]; calls: number } {
  const seen: AbortSignal[] = [];
  const stage = {
    name,
    seen,
    calls: 0,
    run(_ctx: unknown, _lead: unknown, _n: unknown, opts?: StageRunOptions): Promise<StageOutcome> {
      stage.calls++;
      if (opts?.signal) seen.push(opts.signal);
      return new Promise<StageOutcome>((_resolve, reject) => {
        if (honorSignal) opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason));
      });
    },
  };
  return stage;
}

function quickStage(name: string, outcome: Partial<StageOutcome> = {}, delayMs = 0, timeoutMs?: number): Stage & { calls: number } {
  const stage = {
    name,
    timeoutMs,
    calls: 0,
    async run(): Promise<StageOutcome> {
      stage.calls++;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { stage: name, status: 'not_found', duration_ms: delayMs, ...outcome };
    },
  };
  return stage;
}

function pipelineInput(extra: Record<string, unknown> = {}, abortSignal?: AbortSignal) {
  const run = createRun({ abortSignal });
  const router = new ProviderRouter([], [], [], new CostLedger());
  return { run, perLead: createPerLeadContext(run), router, lead: lead(), dnsResolver: deadDns, ...extra };
}

describe('perStageTimeoutMs is enforced by the enrichment pipeline', () => {
  it('turns a hung ladder stage into a timeout outcome and keeps going', async () => {
    const rdap = hungStage('rdap', false);
    const t0 = Date.now();
    const res = await runEnrichmentPipeline(pipelineInput({ rdapStage: rdap, perStageTimeoutMs: 40 }));
    expect(Date.now() - t0).toBeLessThan(5_000);
    const o = res.stage_outcomes.rdap;
    expect(o.status).toBe('error');
    expect(o.reason_code).toBe(ReasonCode.ERROR_TIMEOUT_FETCH);
    expect(o.detail).toBe('stage_timeout_after_40ms');
    // the passes after the ladder still ran
    expect(res.stage_outcomes.financial).toBeDefined();
    expect(res.lead.status).toBe('NOT_FOUND');
  });

  it('hands the stage a signal that aborts with a TimeoutError at the deadline', async () => {
    const rdap = hungStage('rdap', true);
    const res = await runEnrichmentPipeline(pipelineInput({ rdapStage: rdap, perStageTimeoutMs: 30 }));
    expect(rdap.seen).toHaveLength(1);
    expect(rdap.seen[0].aborted).toBe(true);
    expect((rdap.seen[0].reason as Error).name).toBe('TimeoutError');
    expect(res.stage_outcomes.rdap.reason_code).toBe(ReasonCode.ERROR_TIMEOUT_FETCH);
  });

  it('keeps the outcome of a stage that finishes within its budget', async () => {
    const rdap = quickStage('rdap', { detail: 'fast' }, 5);
    const res = await runEnrichmentPipeline(pipelineInput({ rdapStage: rdap, perStageTimeoutMs: 1_000 }));
    expect(res.stage_outcomes.rdap).toMatchObject({ status: 'not_found', detail: 'fast' });
  });

  it('times out a hung later pass and still runs the one after it', async () => {
    const maps = hungStage('apify_maps', false);
    const bilanci = quickStage('apify_bilanci', { detail: 'ran' });
    const res = await runEnrichmentPipeline(
      pipelineInput({
        apifyMapsStage: maps as unknown as ApifyMapsStage,
        apifyBilanciStage: bilanci as unknown as ApifyBilanciStage,
        perStageTimeoutMs: 30,
      }),
    );
    expect(res.stage_outcomes.apify_maps).toMatchObject({ status: 'error', reason_code: ReasonCode.ERROR_TIMEOUT_FETCH });
    expect(res.stage_outcomes.apify_bilanci).toMatchObject({ detail: 'ran' });
  });

  it("gives a stage that declares its own budget that budget instead of the default", async () => {
    const slowPaid = quickStage('apify_maps', { status: 'success', detail: 'slow_but_legit' }, 60, 1_000);
    const res = await runEnrichmentPipeline(pipelineInput({ apifyMapsStage: slowPaid as unknown as ApifyMapsStage, perStageTimeoutMs: 10 }));
    expect(res.stage_outcomes.apify_maps).toMatchObject({ status: 'success', detail: 'slow_but_legit' });
  });

  it('does not start any stage once the run signal has aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const rdap = quickStage('rdap');
    const res = await runEnrichmentPipeline(pipelineInput({ rdapStage: rdap, perStageTimeoutMs: 1_000 }, ac.signal));
    expect(rdap.calls).toBe(0);
    expect(res.stage_outcomes.rdap).toMatchObject({ status: 'skipped', detail: 'run_aborted' });
  });

  it('the paid stages declare a budget longer than their own 60 s provider timeout', () => {
    const router = new ProviderRouter([], [], [], new CostLedger());
    for (const s of [new ApifyMapsStage(router), new ApifyBilanciStage(router), new ApifyRegistroStage(router), new PerplexityResolveStage(router)]) {
      expect(s.timeoutMs).toBeGreaterThan(60_000);
    }
  });
});

describe('stages pass the stage signal down to their I/O', () => {
  afterEach(() => vi.restoreAllMocks());

  class SpyRouter extends ProviderRouter {
    readonly fetchSignals: Array<AbortSignal | undefined> = [];
    readonly searchSignals: Array<AbortSignal | undefined> = [];
    constructor() {
      super([], [], [], new CostLedger());
    }
    override async fetch(_url: string, opts: RouteOptions & { timeoutMs?: number } = {}): Promise<HttpFetchResult> {
      this.fetchSignals.push(opts.signal);
      return { provider: 'none', status: 0, html: undefined, error: 'dead', duration_ms: 0, cost_eur: 0 };
    }
    override async search(_q: string, opts: RouteOptions = {}) {
      this.searchSignals.push(opts.signal);
      return { provider: 'none', results: [] };
    }
  }

  const ctxFor = () => createPerLeadContext(createRun());

  it('InputWebsiteStage → router.fetch', async () => {
    const router = new SpyRouter();
    const signal = new AbortController().signal;
    const l: Lead = { company_name: 'Acme Srl', city: 'Padova', website: 'https://acme-test.it' };
    await new InputWebsiteStage(router).run(ctxFor(), l, normalizeLead(l), { signal });
    expect(router.fetchSignals.length).toBeGreaterThan(0);
    expect(router.fetchSignals.every((s) => s === signal)).toBe(true);
  });

  it('SerpStage → router.search', async () => {
    const router = new SpyRouter();
    const signal = new AbortController().signal;
    const l = lead();
    await new SerpStage(router).run(ctxFor(), l, normalizeLead(l), { signal });
    expect(router.searchSignals).toEqual([signal]);
  });

  it('RdapBoostStage → RdapValidator', async () => {
    const spy = vi.spyOn(RdapValidator, 'checkDomainOwnership').mockResolvedValue({ confidence: 0, evidence: 'none', detail: '' } as Awaited<ReturnType<typeof RdapValidator.checkDomainOwnership>>);
    const signal = new AbortController().signal;
    const l: Lead = { company_name: 'Acme Srl', website: 'https://acme-test.it' };
    await new RdapBoostStage().run(ctxFor(), l, normalizeLead(l), { signal });
    expect(spy).toHaveBeenCalledWith(expect.any(String), expect.anything(), { signal });
  });
});

describe('verifyCandidates honours an aborted signal', () => {
  it('fetches nothing, reports timedOut, and accepts no candidate once the signal has aborted', async () => {
    const router = new (class extends ProviderRouter {
      calls = 0;
      constructor() {
        super([], [], [], new CostLedger());
      }
      override async fetch(): Promise<HttpFetchResult> {
        this.calls++;
        return { provider: 'x', status: 200, html: '<html>P.IVA 01654010345</html>', duration_ms: 0, cost_eur: 0 };
      }
    })();
    const ac = new AbortController();
    ac.abort();
    const l: Lead = { company_name: 'Acme Srl', vat_code: '01654010345' };
    const cache = new Map<string, HttpFetchResult>();
    const v = await verifyCandidates(router, ['https://acme-test.it'], normalizeLead(l), l, { signal: ac.signal, corroborateWithRdap: false, retryDelaysMs: [], fetchCache: cache });
    expect(router.calls).toBe(0);
    expect(v.matched).toBe(false);
    expect(v.timedOut).toBe(true);
    expect(l.official_website).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe('ProviderRouter and an aborted signal', () => {
  class CountingSerp implements SerpProvider {
    family = 'serp' as const;
    calls = 0;
    constructor(public id: string, public tier: number, public costPerCallEur: number) {}
    available() {
      return true;
    }
    async search() {
      this.calls++;
      return [];
    }
  }

  it('does not call any provider (free or paid) once the signal has aborted', async () => {
    const free = new CountingSerp('free', 0, 0);
    const paid = new CountingSerp('paid', 2, 0.01);
    const router = new ProviderRouter([free, paid], [], [], new CostLedger());
    const ac = new AbortController();
    ac.abort();
    const out = await router.search('q', { signal: ac.signal, paidEnabled: true });
    expect(out.results).toEqual([]);
    expect(free.calls + paid.calls).toBe(0);
    const invoked = await router.invoke({ id: 'p', family: 'apify', tier: 2, costPerCallEur: 0.01, available: () => true } as never, async () => ({ ok: true, value: 1 }), { signal: ac.signal, paidEnabled: true });
    expect(invoked).toBeNull();
  });

  it.each([
    ['throws', async (ac: AbortController): Promise<HttpFetchResult> => {
      ac.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    }],
    ['returns status 0', async (ac: AbortController): Promise<HttpFetchResult> => {
      ac.abort();
      return { provider: 'slow_http', status: 0, html: undefined, error: 'This operation was aborted', duration_ms: 1, cost_eur: 0 };
    }],
  ])('does not count a fetch cut short by our own deadline against the breaker (provider %s)', async (_label, behave) => {
    const ac = new AbortController();
    const http: HttpProvider = { id: 'slow_http', family: 'http', tier: 0, costPerCallEur: 0, available: () => true, fetch: () => behave(ac) };
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const router = new ProviderRouter([], [http], [], new CostLedger(), breaker);
    await router.fetch('https://x.it', { signal: ac.signal });
    expect(breaker.allow('slow_http')).toBe(true);
  });

  it('still counts a genuine provider failure against the breaker', async () => {
    const http: HttpProvider = {
      id: 'broken_http',
      family: 'http',
      tier: 0,
      costPerCallEur: 0,
      available: () => true,
      fetch: async () => {
        throw new Error('ECONNRESET');
      },
    };
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const router = new ProviderRouter([], [http], [], new CostLedger(), breaker);
    await router.fetch('https://x.it', { signal: new AbortController().signal });
    expect(breaker.allow('broken_http')).toBe(false);
  });
});
