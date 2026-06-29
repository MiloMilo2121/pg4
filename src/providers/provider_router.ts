import type { AnyProvider, HttpProvider, LLMProvider, SerpProvider } from '../types/providers';
import { ProviderBlockError, classifyHttpFailure } from '../types/providers';
import type { CostLedger } from '../runtime/cost_ledger';
import { CircuitBreaker } from '../runtime/circuit_breaker';
import type { RateLimiter } from '../runtime/rate_limiter';
import { logger } from '../runtime/logger';

export interface RouteOptions {
  /** Cap the maximum tier to use (e.g. 1 = free + cheap only). */
  maxTier?: number;
  /** Cap how many providers to try in this call. */
  maxProviders?: number;
  signal?: AbortSignal;
  /**
   * Caller-supplied context attached to every CostLedger entry produced
   * by this call. Typical keys: `lead_id`, `run_id`, `stage`. Useful
   * for per-lead cost reconstruction in post-mortem JSONL analysis.
   */
  meta?: Record<string, string | number | boolean>;
  /**
   * Phase D.2: when true, the router does not record this attempt to
   * the circuit breaker. The cost ledger still records the call (so
   * cost accounting stays accurate) and breaker filtering still
   * applies (a tripped breaker still blocks the call). Used by
   * `verify_candidates` to retry a transport-flapped candidate
   * without double-counting toward the breaker threshold — the first
   * attempt already counted, the retry should not push the breaker
   * over the trip line just because the same network blip happened
   * twice.
   */
  bypassBreakerRecord?: boolean;
  /**
   * Phase G — paid-call gate. When `false` (default), providers with
   * `costPerCallEur > 0` are filtered out — even if they're
   * registered, available, and within the tier cap. Callers must
   * explicitly opt in to paid calls AND respect remaining budgets.
   */
  paidEnabled?: boolean;
  /**
   * Phase G — per-lead remaining budget (EUR). Providers whose
   * `costPerCallEur` exceeds this value are filtered out. The caller
   * is responsible for tracking the remaining budget per lead and
   * passing it on each call. `undefined` means "no per-lead cap"
   * (legacy behaviour for free-only callers).
   */
  remainingLeadBudgetEur?: number;
  /**
   * Phase G — restrict this call to a specific list of provider ids.
   * When set, only providers whose `id` is in the list are
   * considered. Used by SerpStage to run a paid second pass that
   * targets ONLY the paid providers.
   */
  includeProviderIds?: ReadonlyArray<string>;
  /**
   * R14 — denylist. Providers whose `id` is in this list are excluded
   * from this call, keeping everything else. Symmetric to
   * `includeProviderIds` but additive-by-default: used by SerpStage to
   * skip low-yield free providers for a category profile without having
   * to enumerate the full keep-list. Applied after `includeProviderIds`.
   */
  excludeProviderIds?: ReadonlyArray<string>;
  /**
   * Phase G fix — when true, FREE providers (`costPerCallEur === 0`)
   * are filtered OUT. Used by the SerpStage paid second pass: the
   * free pass already ran every free provider; the paid pass should
   * target ONLY paid providers, otherwise the router returns on the
   * first free provider that produces results (bing_html in PD has
   * a 1.0 success rate) and Serper never gets called.
   */
  paidOnly?: boolean;
  /**
   * Phase G hotfix — run-level cost ceiling (EUR). When set, the
   * router compares `ledger.getTotal() + provider.costPerCallEur`
   * against this cap and filters paid providers out when the next
   * call would exceed it. Without this enforcement (the original
   * `--run-cost-ceiling-eur` was threaded through context but never
   * gated at the router), p90 first-attempt blew past a €0.10 cap
   * to €0.229 before being killed manually.
   */
  runCostCeilingEur?: number;
}

/**
 * Cost-tiered provider selector. Iterates ascending by tier and skips
 * unavailable providers (missing key / disabled by feature flag / circuit
 * breaker open).
 *
 * The router is family-aware: SERP / HTTP / LLM each have their own ordered
 * registry; callers ask the router to "search/fetch/complete" and it returns
 * the first non-empty success.
 *
 * Circuit breaker (Phase 3.7) trips a provider after N consecutive failures
 * within a window — protects against crt.sh 5xx storms, Bing Cloudflare-
 * Turnstile loops, RDAP outages.
 */
export class ProviderRouter {
  private readonly breaker: CircuitBreaker;
  /**
   * Phase G.1 — atomic budget reservation counter. Concurrent paid
   * calls must not both pass the run-cap filter when only one would
   * fit, so we reserve cost at filter time and release after the
   * call settles. JS is single-threaded, so increment + check on
   * the sync filter path is genuinely atomic; the only race window
   * is multiple awaits overlapping AFTER the filter, which the
   * counter closes.
   */
  private reservedEur = 0;
  /**
   * Phase A.5 — one-shot run-ceiling listener. Fired the FIRST time a
   * paid provider is dropped because the run cost ceiling would be
   * exceeded. Before this, hitting the cap was a silent `continue` —
   * the operator only discovered the run degraded to free-only by
   * reading per-provider counts in the ledger after the fact.
   */
  private onRunCeilingHit?: (info: { ledgerTotalEur: number; ceilingEur: number }) => void;
  private runCeilingFired = false;

  constructor(
    private readonly serps: SerpProvider[],
    private readonly https: HttpProvider[],
    private readonly llms: LLMProvider[],
    private readonly ledger: CostLedger,
    breaker?: CircuitBreaker,
    /**
     * Phase F finding — per-provider token bucket. The RateLimiter had
     * existed on the Run since Phase 1 but acquire() had ZERO call
     * sites: a lead set with no input websites degenerated the enrich
     * stage into a raw SERP burst (~3.7 req/s to Bing in the Phase F
     * smoke vs ~0.27 req/s in validated R12), and Bing soft-blocked
     * with 185/185 empty responses — a silent failure. Unconfigured
     * keys remain unlimited, so behavior is unchanged for providers
     * without an explicit rate.
     */
    private readonly rate?: RateLimiter
  ) {
    this.breaker = breaker ?? new CircuitBreaker();
  }

  async search(query: string, opts: RouteOptions = {}) {
    const candidates = this.filter(this.serps, opts);
    for (const p of candidates) {
      // Phase F — space out calls per provider (no-op for unconfigured keys).
      if (this.rate) await this.rate.acquire(p.id);
      // Phase G.1 — atomic budget reservation. The sync filter check
      // already passed, but a concurrent caller may have reserved
      // since. Re-check sync right before reserving so we never
      // overshoot under concurrency.
      if (p.costPerCallEur > 0 && opts.runCostCeilingEur !== undefined) {
        if (this.ledger.getTotal() + this.reservedEur + p.costPerCallEur > opts.runCostCeilingEur) {
          continue; // budget no longer fits — skip this provider
        }
      }
      const reserved = p.costPerCallEur > 0 && opts.runCostCeilingEur !== undefined;
      if (reserved) this.reservedEur += p.costPerCallEur;
      try {
        const results = await p.search(query, { signal: opts.signal });
        // Empty result is NOT a failure — pg3 audit found 16K+ SERP_EMPTY
        // entries logged as ERROR per batch. Free SERP returns empty
        // frequently for small Italian businesses; we treat empty as a
        // clean miss for both the breaker AND the ledger's success
        // accounting (kind='empty').
        const ok = results.length > 0;
        this.ledger.record(p.id, p.family, p.costPerCallEur, ok, {
          kind: ok ? 'success' : 'empty',
          meta: opts.meta,
        });
        this.breaker.recordSuccess(p.id);
        if (ok) return { provider: p.id, results };
      } catch (err) {
        const kind: import('../types/providers').FailureKind = err instanceof ProviderBlockError ? 'blocked' : classifyThrown(err);
        this.ledger.record(p.id, p.family, p.costPerCallEur, false, { kind, meta: opts.meta });
        this.breaker.recordFailure(p.id, kind);
        logger.warn({ provider: p.id, kind, err: (err as Error).message }, '[Router] serp provider failed');
      } finally {
        if (reserved) this.reservedEur -= p.costPerCallEur;
      }
    }
    return { provider: 'none', results: [] };
  }

  async fetch(url: string, opts: RouteOptions & { timeoutMs?: number } = {}) {
    const candidates = this.filter(this.https, opts);
    const bypassBreaker = opts.bypassBreakerRecord === true;
    let lastError: string | undefined;
    for (const p of candidates) {
      if (p.costPerCallEur > 0 && opts.runCostCeilingEur !== undefined) {
        if (this.ledger.getTotal() + this.reservedEur + p.costPerCallEur > opts.runCostCeilingEur) continue;
      }
      const reserved = p.costPerCallEur > 0 && opts.runCostCeilingEur !== undefined;
      if (reserved) this.reservedEur += p.costPerCallEur;
      try {
        const res = await p.fetch(url, { timeoutMs: opts.timeoutMs, signal: opts.signal });
        const ok = res.status >= 200 && res.status < 400 && !!res.html;
        if (ok) {
          this.ledger.record(p.id, p.family, res.cost_eur || p.costPerCallEur, true, { kind: 'success', meta: opts.meta });
          if (!bypassBreaker) this.breaker.recordSuccess(p.id);
          return { ...res, provider: p.id };
        }
        // 404 / 403 on a SINGLE URL is a per-target outcome, not a
        // provider-wide failure. Only network-level breakage trips the
        // breaker.
        const transportLike = res.status === 0 || res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429;
        const kind: import('../types/providers').FailureKind = transportLike
          ? classifyHttpFailure({ status: res.status, error: res.error })
          : 'other';
        this.ledger.record(p.id, p.family, res.cost_eur || p.costPerCallEur, false, { kind, meta: opts.meta });
        if (transportLike && !bypassBreaker) this.breaker.recordFailure(p.id, kind);
        lastError = res.error;
      } catch (err) {
        const kind = classifyThrown(err);
        this.ledger.record(p.id, p.family, p.costPerCallEur, false, { kind, meta: opts.meta });
        if (!bypassBreaker) this.breaker.recordFailure(p.id, kind);
        lastError = (err as Error).message;
      } finally {
        if (reserved) this.reservedEur -= p.costPerCallEur;
      }
    }
    return { provider: 'none', status: 0, html: undefined, error: lastError, duration_ms: 0, cost_eur: 0 };
  }

  async complete(req: Parameters<LLMProvider['complete']>[0], opts: RouteOptions = {}) {
    const candidates = this.filter(this.llms, opts);
    for (const p of candidates) {
      if (p.costPerCallEur > 0 && opts.runCostCeilingEur !== undefined) {
        if (this.ledger.getTotal() + this.reservedEur + p.costPerCallEur > opts.runCostCeilingEur) continue;
      }
      const reserved = p.costPerCallEur > 0 && opts.runCostCeilingEur !== undefined;
      if (reserved) this.reservedEur += p.costPerCallEur;
      try {
        const res = await p.complete(req, { signal: opts.signal });
        this.ledger.record(p.id, p.family, res.cost_eur || p.costPerCallEur, true, { kind: 'success', meta: opts.meta });
        this.breaker.recordSuccess(p.id);
        return res;
      } catch (err) {
        const kind = classifyThrown(err);
        this.ledger.record(p.id, p.family, p.costPerCallEur, false, { kind, meta: opts.meta });
        this.breaker.recordFailure(p.id, kind);
        logger.warn({ provider: p.id, kind, err: (err as Error).message }, '[Router] llm provider failed');
      } finally {
        if (reserved) this.reservedEur -= p.costPerCallEur;
      }
    }
    return null;
  }

  /**
   * Addendum R1 — family-agnostic cost-gated execution. The router's gates
   * (paid-gate, per-lead budget, run-ceiling reservation, circuit-breaker,
   * ledger) historically lived ONLY in `filter()`, which only covers the
   * three method-families (serp/http/llm). Email/official/reviews/ads/captcha
   * providers are NOT those families, so without this they would spend money
   * WITHOUT any of those gates — the exact class of bug that once blew a €0.10
   * ceiling to €0.229. `invoke` runs the SAME gate pipeline around an arbitrary
   * provider call so there is EXACTLY ONE place money can be spent, for every
   * family.
   *
   * Returns the call's value on success, or `null` when the provider is gated
   * out (unavailable / breaker open / tier cap / paid-gate / over budget /
   * over run-ceiling) or the call fails. The caller treats `null` as "this
   * cascade step did not produce" and moves to the next step.
   */
  async invoke<T>(
    meta: import('../types/providers').CostedMeta,
    call: (signal?: AbortSignal) => Promise<{ ok: boolean; value: T; cost_eur?: number } | null>,
    opts: RouteOptions = {}
  ): Promise<T | null> {
    // ---- gate pipeline (mirrors filter(), applied to a single provider) ----
    if (!meta.available()) return null;
    if (!this.breaker.allow(meta.id)) return null;
    if (opts.maxTier !== undefined && meta.tier > opts.maxTier) return null;
    const paidEnabled = opts.paidEnabled === true;
    if (meta.costPerCallEur > 0 && !paidEnabled) return null;
    if (meta.costPerCallEur > 0 && opts.remainingLeadBudgetEur !== undefined && meta.costPerCallEur > opts.remainingLeadBudgetEur) {
      return null;
    }
    if (opts.includeProviderIds && !opts.includeProviderIds.includes(meta.id)) return null;
    if (opts.excludeProviderIds && opts.excludeProviderIds.includes(meta.id)) return null;
    if (opts.paidOnly && meta.costPerCallEur === 0) return null;

    // ---- run-ceiling atomic reservation (same protocol as search/fetch/complete) ----
    const ceilingGated = meta.costPerCallEur > 0 && opts.runCostCeilingEur !== undefined;
    if (ceilingGated) {
      if (this.ledger.getTotal() + this.reservedEur + meta.costPerCallEur > (opts.runCostCeilingEur as number)) {
        this.fireRunCeiling(opts.runCostCeilingEur as number);
        return null;
      }
      this.reservedEur += meta.costPerCallEur;
    }

    // ---- per-provider rate limit (no-op for unconfigured keys) ----
    if (this.rate) await this.rate.acquire(meta.id);

    try {
      const res = await call(opts.signal);
      const ok = res !== null && res.ok;
      this.ledger.record(meta.id, meta.family, res?.cost_eur ?? meta.costPerCallEur, ok, {
        kind: ok ? 'success' : 'empty',
        meta: opts.meta,
      });
      this.breaker.recordSuccess(meta.id);
      return ok ? (res as { value: T }).value : null;
    } catch (err) {
      const kind: import('../types/providers').FailureKind = err instanceof ProviderBlockError ? 'blocked' : classifyThrown(err);
      this.ledger.record(meta.id, meta.family, meta.costPerCallEur, false, { kind, meta: opts.meta });
      this.breaker.recordFailure(meta.id, kind);
      logger.warn({ provider: meta.id, kind, err: (err as Error).message }, '[Router] invoke provider failed');
      return null;
    } finally {
      if (ceilingGated) this.reservedEur -= meta.costPerCallEur;
    }
  }

  /**
   * Phase A.5 — register the run-ceiling listener (latched: fires once
   * per router lifetime). Call sites stay untouched; the CLI wires the
   * notifier here.
   */
  setRunCeilingListener(fn: (info: { ledgerTotalEur: number; ceilingEur: number }) => void): void {
    this.onRunCeilingHit = fn;
  }

  private fireRunCeiling(ceilingEur: number): void {
    if (this.runCeilingFired) return;
    this.runCeilingFired = true;
    const info = { ledgerTotalEur: this.ledger.getTotal(), ceilingEur };
    logger.warn(info, '[Router] run cost ceiling reached — paid providers disabled for the rest of the run');
    this.onRunCeilingHit?.(info);
  }

  /** Allow the catalog to tune circuit-breaker thresholds per provider. */
  configureBreaker(providerId: string, cfg: Parameters<CircuitBreaker['configure']>[1]): void {
    this.breaker.configure(providerId, cfg);
  }

  /** Diagnostic snapshot of the breaker (used by boot logging). */
  describeBreaker() {
    return this.breaker.snapshot();
  }

  /** Diagnostic: list capability surface (for boot-time logging). */
  describe() {
    const fmt = (p: AnyProvider) => `${p.id}@T${p.tier}${p.available() ? '' : '(disabled)'}`;
    return {
      serp: this.serps.map(fmt),
      http: this.https.map(fmt),
      llm: this.llms.map(fmt),
    };
  }

  private filter<T extends AnyProvider>(arr: T[], opts: RouteOptions): T[] {
    const paidEnabled = opts.paidEnabled === true;
    return arr
      .filter((p) => p.available())
      .filter((p) => this.breaker.allow(p.id))
      .filter((p) => opts.maxTier === undefined || p.tier <= opts.maxTier)
      // Phase G — paid gate. Default-deny: any provider with
      // costPerCallEur > 0 is excluded unless `paidEnabled === true`.
      // This is the load-bearing safety: a run with cost ceiling 0
      // never accidentally hits a paid provider just because tier
      // limits drift or someone forgets to set maxTier.
      .filter((p) => p.costPerCallEur === 0 || paidEnabled)
      // Phase G — per-lead budget gate. Filter out paid providers
      // whose single-call cost would exceed the remaining lead budget.
      .filter((p) => {
        if (p.costPerCallEur === 0) return true;
        if (opts.remainingLeadBudgetEur === undefined) return true;
        return p.costPerCallEur <= opts.remainingLeadBudgetEur;
      })
      // Phase G fix — paid-only second-pass mode. Filters out free
      // providers so the SerpStage paid pass actually reaches the
      // paid SERP. Without this, the free providers (bing_html etc.)
      // satisfy the loop first and Serper is never called.
      .filter((p) => !opts.paidOnly || p.costPerCallEur > 0)
      // Phase G hotfix — run-level cap enforcement. If the ledger
      // total + reserved + this call's cost would exceed the cap,
      // drop the paid provider. Includes `reservedEur` so concurrent
      // pipelines can't both pass when only one would fit.
      // p90 first-attempt blew past a €0.10 cap to €0.229; this
      // closes the race window.
      .filter((p) => {
        if (p.costPerCallEur === 0) return true;
        if (opts.runCostCeilingEur === undefined) return true;
        const fits = this.ledger.getTotal() + this.reservedEur + p.costPerCallEur <= opts.runCostCeilingEur;
        if (!fits) this.fireRunCeiling(opts.runCostCeilingEur);
        return fits;
      })
      // Phase G — explicit allowlist when caller targets specific ids.
      .filter((p) => !opts.includeProviderIds || opts.includeProviderIds.includes(p.id))
      // R14 — explicit denylist (category routing skips low-yield providers).
      .filter((p) => !opts.excludeProviderIds || !opts.excludeProviderIds.includes(p.id))
      // Primary order: tier ascending (free-first). Tiebreak: when the caller
      // supplied an ordered `includeProviderIds` (the RoleResolver compiles the
      // per-role cascade order into it), honour THAT order within a tier — so
      // LLM_CHEAP can try zhipu→deepseek while LLM_JUDGE tries anthropic→openai,
      // even though both are tier 2. Without this the catalog array order would
      // win and every role would share one fallback order.
      .sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        const order = opts.includeProviderIds;
        if (!order) return 0;
        return order.indexOf(a.id) - order.indexOf(b.id);
      })
      .slice(0, opts.maxProviders ?? Number.MAX_SAFE_INTEGER);
  }
}

/** Map a thrown value to the canonical FailureKind used by the breaker + ledger. */
function classifyThrown(err: unknown): import('../types/providers').FailureKind {
  if (err instanceof ProviderBlockError) return 'blocked';
  const msg = `${(err as Error)?.message ?? err}`.toLowerCase();
  if (msg.includes('timeout') || msg.includes('etimedout')) return 'timeout';
  if (msg.includes('429') || msg.includes('rate')) return 'rate_limit';
  if (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('socket') ||
    msg.includes('fetch failed') ||
    msg.includes('network')
  ) {
    return 'transport';
  }
  return 'other';
}
