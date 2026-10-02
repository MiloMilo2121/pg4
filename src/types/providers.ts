/**
 * Provider interfaces. Every provider declares its family, tier, and cost.
 * The router selects ascending by tier, gated by feature flags + key presence.
 */

/**
 * Router method-families (the three method-registries: search/fetch/complete) PLUS
 * the non-router families that are cost-gated via `ProviderRouter.invoke`.
 * Widening this is ledger/breaker tagging only — it does NOT add router method-registries.
 */
export type ProviderFamily = 'serp' | 'http' | 'llm' | 'email' | 'official' | 'reviews' | 'ads' | 'captcha' | 'apify';

/**
 * Functional ROLE a provider can fill (orthogonal to family). A provider may have
 * MANY roles. The RoleRegistry maps each role to its ordered free→paid cascade.
 * Source of truth: docs/provider_cascade_architecture.md.
 */
export type ProviderRole =
  | 'SEARCH_WEB'
  | 'WEB_FETCH'
  | 'WEB_UNBLOCK'
  | 'LLM_JUDGE'
  | 'LLM_REASON'
  | 'LLM_CHEAP'
  | 'OFFICIAL_COMPANY_DATA'
  | 'EMAIL_FIND'
  | 'EMAIL_VERIFY'
  | 'B2B_CONTACT'
  | 'DECISION_MAKER'
  | 'REVIEWS_REPUTATION'
  | 'ADS_SIGNAL'
  | 'SOCIAL_DETECT'
  | 'TECH_SIGNAL'
  | 'TENDER_CONTRACTS'
  | 'CERTIFICATIONS'
  | 'FAIR_PRESENCE'
  | 'NEWS_AWARDS'
  | 'PDF_EXTRACT'
  | 'CAPTCHA_SOLVE'
  | 'RESIDENTIAL_IP'
  | 'EMBEDDINGS';

/**
 * Minimal cost-gated provider descriptor for `ProviderRouter.invoke`.
 * Any non-router provider (email/official/reviews/ads/captcha) passes one of these so
 * the SAME paid-gate / budget / run-ceiling / breaker / ledger pipeline applies to it.
 */
export interface CostedMeta {
  readonly id: string;
  readonly family: ProviderFamily;
  readonly tier: number;
  readonly costPerCallEur: number;
  available(): boolean;
  readonly roles?: ReadonlyArray<ProviderRole>;
}

export interface SerpResult {
  title: string;
  url: string;
  snippet: string;
  rank: number;
  source_provider: string;
}

export interface HttpFetchResult {
  status: number;
  html?: string;
  finalUrl?: string;
  duration_ms: number;
  cost_eur: number;
  provider: string;
  error?: string;
}

export interface LLMCompletionRequest {
  system?: string;
  prompt: string;
  json_schema?: unknown;
  max_tokens?: number;
  temperature?: number;
}

export interface LLMCompletionResult {
  content: string;
  cost_eur: number;
  model: string;
  provider: string;
}

/** Base provider — every provider implements this. */
interface Provider {
  readonly id: string;
  readonly family: ProviderFamily;
  readonly tier: number;
  readonly costPerCallEur: number;
  /** Returns true if API key + feature flag are both set. */
  available(): boolean;
  /** Functional roles this provider can fill (optional; defaults to []). */
  readonly roles?: ReadonlyArray<ProviderRole>;
}

export interface SerpProvider extends Provider {
  family: 'serp';
  search(query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<SerpResult[]>;
}

export interface HttpProvider extends Provider {
  family: 'http';
  fetch(url: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HttpFetchResult>;
}

export interface LLMProvider extends Provider {
  family: 'llm';
  complete(req: LLMCompletionRequest, opts?: { signal?: AbortSignal }): Promise<LLMCompletionResult>;
}

export type AnyProvider = SerpProvider | HttpProvider | LLMProvider;

/**
 * Tagged error for "the provider's response was a Cloudflare/captcha
 * block page", as opposed to "the provider returned a legitimate empty
 * result set". The router uses this to drive the circuit breaker
 * aggressively (block hits cost more than empty misses).
 */
export class ProviderBlockError extends Error {
  readonly providerId: string;
  constructor(providerId: string, message = 'provider returned a block page') {
    super(message);
    this.name = 'ProviderBlockError';
    this.providerId = providerId;
  }
}

/**
 * What a FAILED paid call actually spent, when the thrown error knows it
 * (e.g. an Apify run that was started, billed, then could not be downloaded;
 * or a start rejected before anything ran → 0). `undefined` means "unknown":
 * the router then records the worst-case reservation, never €0.
 */
export function errorCostEur(err: unknown): number | undefined {
  const c = (err as { cost_eur?: unknown } | null | undefined)?.cost_eur;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : undefined;
}

/** Classified failure kind used by router → ledger + breaker. */
export type FailureKind = 'blocked' | 'rate_limit' | 'transport' | 'timeout' | 'other';

export function classifyHttpFailure(opts: { status?: number; error?: string }): FailureKind {
  const msg = (opts.error ?? '').toLowerCase();
  if (opts.status === 429 || /rate.?limit|429/.test(msg)) return 'rate_limit';
  if (msg.includes('timeout') || msg.includes('etimedout')) return 'timeout';
  if (
    opts.status === 0 ||
    opts.status === 502 ||
    opts.status === 503 ||
    opts.status === 504 ||
    /econnreset|econnrefused|enotfound|socket|fetch failed/.test(msg)
  ) {
    return 'transport';
  }
  return 'other';
}
