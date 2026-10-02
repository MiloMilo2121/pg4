/**
 * role_registry.ts — the SINGLE SOURCE OF TRUTH for the provider role cascades.
 *
 * A functional ROLE (SEARCH_WEB, OFFICIAL_COMPANY_DATA, LLM_JUDGE, …) maps to an
 * ORDERED cascade of steps: free (tier 0/1) first → cheap-paid → premium. Each step
 * carries its activation condition. The RoleResolver compiles (role, ctx) → RouteOptions
 * using this table; the ProviderRouter then re-asserts every gate independently.
 *
 * Source: docs/provider_cascade_architecture.md + ADDENDUM v1.1.
 * Addendum corrections applied here: Perplexity is LLM-only (not SEARCH_WEB);
 * zhipu/kimi/deepseek are paid-gated (no assumed-free LLM); brightdata is split into
 * distinct ids brightdata_serp / brightdata_unlocker; PEC has no free API step.
 */
import type { ProviderRole } from '../types/providers';
import { CALL_COST_EUR, HUNTER_OP_COST_EUR } from './pricing';

/** How the resolver dispatches a role: which router verb (or non-router invoke). */
export type RoleVerb = 'search' | 'fetch' | 'complete' | 'invoke';

export interface RoleStep {
  /** Registered provider id (matches catalog + breaker/rate keyspace). */
  providerId: string;
  tier: number;
  /** €/call estimate (USD→EUR ≈ 0.92), authoritative from integration specs. */
  costEur: number;
  /** Requires ctx.paidEnabled === true (the load-bearing paid-gate). */
  paid: boolean;
  /** Human-readable activation note. */
  condition: string;
  /** Only active for these category profiles (e.g. hospitality → reviews). */
  categoryOnly?: string[];
  /** Excluded for these category profiles (e.g. real-estate low-yield SERP). */
  categoryExclude?: string[];
  /** Openapi paid tiers: fire only when isTopCompany(lead) && onRequest. */
  onRequestTopOnly?: boolean;
  /** Gated side-services (captcha/residential) — explicit operator flag only. */
  explicitGate?: boolean;
  /** Currently disabled (kept for documentation of WHY). */
  disabled?: boolean;
}

export interface RoleEntry {
  role: ProviderRole;
  verb: RoleVerb;
  phase: 'research' | 'enrich' | 'judgment';
  steps: RoleStep[];
  note?: string;
}

const free = (providerId: string, tier: number, condition: string, extra: Partial<RoleStep> = {}): RoleStep => ({
  providerId, tier, costEur: 0, paid: false, condition, ...extra,
});
const paid = (providerId: string, tier: number, costEur: number, condition: string, extra: Partial<RoleStep> = {}): RoleStep => ({
  providerId, tier, costEur, paid: true, condition, ...extra,
});

export const ROLE_REGISTRY: RoleEntry[] = [
  {
    role: 'SEARCH_WEB', verb: 'search', phase: 'research',
    steps: [
      free('bing_html', 1, 'always (free, no-key)'),
      free('ddg_lite', 1, 'free EXCEPT italian_real_estate (R14) unless SERP_EXPANDED_FREE_ENABLED', { categoryExclude: ['italian_real_estate'] }),
      // Serper was once excluded for real-estate as "low-yield", but a
      // 2026-07-20 live re-test found serper returns the agency's OWN site
      // ~50% of the time on
      // no-site immobiliari leads (bing_html returns 0 — directories only); the
      // existing directory/preverify guard cleans the rest. Re-enabled: paid SERP
      // is the highest-ROI lever on the 48% no-website gap.
      paid('serper', 2, CALL_COST_EUR.serper, 'paid SERP; re-enabled for real-estate (2026-07-20 re-test: ~50% own-site hit)'),
      paid('tavily', 2, CALL_COST_EUR.tavily, 'richer snippets / raw content for judgment discovery'),
      paid('exa', 2, CALL_COST_EUR.exa, 'semantic/editorial precision for third-party A-signals'),
      paid('brightdata_serp', 2, CALL_COST_EUR.brightdata, 'last-resort SERP when free blocked'),
    ],
  },
  {
    role: 'WEB_FETCH', verb: 'fetch', phase: 'research',
    steps: [
      free('direct_fetch', 0, 'always; breaker tuned loose'),
      paid('firecrawl', 2, CALL_COST_EUR.firecrawl, 'only after direct_fetch returns block/empty'),
      paid('brightdata_unlocker', 2, CALL_COST_EUR.brightdata, 'tough targets; compliance review'),
    ],
  },
  {
    role: 'WEB_UNBLOCK', verb: 'fetch', phase: 'research',
    steps: [
      paid('firecrawl', 2, CALL_COST_EUR.firecrawl, 'direct_fetch failed (block/JS render)'),
      paid('brightdata_unlocker', 2, CALL_COST_EUR.brightdata, 'firecrawl failed OR residential needed'),
      free('oracle_crawl4ai', 2, 'self-hosted sidecar if ORACLE_CRAWL4AI_URL set'),
    ],
    note: 'paid-only escalation subset of WEB_FETCH',
  },
  {
    role: 'LLM_JUDGE', verb: 'complete', phase: 'judgment',
    steps: [
      paid('anthropic', 2, CALL_COST_EUR.anthropic, 'DEFAULT judge (two-axis verdict synthesis)'),
      paid('openrouter', 2, CALL_COST_EUR.openrouter, 'routes to Claude/other (no new secret)'),
      paid('openai', 2, CALL_COST_EUR.openai, 'fallback judge when anthropic + openrouter down'),
    ],
  },
  {
    role: 'LLM_REASON', verb: 'complete', phase: 'enrich',
    steps: [
      paid('openrouter', 2, CALL_COST_EUR.openrouter, 'multi-model gateway'),
      paid('openai', 2, CALL_COST_EUR.openai, 'general reasoning/extraction'),
      paid('deepseek', 2, CALL_COST_EUR.deepseek, 'cost-optimized'),
      paid('perplexity', 2, CALL_COST_EUR.perplexity, 'grounded reasoning/answer (addendum R6: LLM role, not SEARCH)'),
      paid('anthropic', 2, CALL_COST_EUR.anthropic, 'premium reasoning'),
    ],
  },
  {
    role: 'LLM_CHEAP', verb: 'complete', phase: 'enrich',
    steps: [
      // Addendum R6: NO assumed-free LLM. All paid-gated; on a free-only run LLM_CHEAP returns null.
      paid('zhipu_glm', 2, CALL_COST_EUR.zhipu_glm, 'cheapest extraction (verify free-tier before relying)'),
      paid('deepseek', 2, CALL_COST_EUR.deepseek, 'cheap reasoning'),
      paid('kimi', 2, CALL_COST_EUR.kimi, 'long-context cheap'),
      paid('openai', 2, CALL_COST_EUR.openai, 'reliable cheap fallback (gpt-4o-mini class)'),
    ],
  },
  {
    role: 'OFFICIAL_COMPANY_DATA', verb: 'invoke', phase: 'enrich',
    steps: [
      free('vies', 1, 'checksum-valid VAT present; OFFICIAL_DATA_VIES_ENABLED'),
      free('fatturatoitalia', 1, 'resolved VAT; entity-guard isWrongEntity; OFFICIAL_DATA_FATTURATOITALIA_ENABLED'),
      paid('openapi_search', 2, CALL_COST_EUR.openapi_search, 'IT-search dryRun coverage sizing; critic: ~€0.01/req beyond free quota (free-tier unverified)'),
      paid('openapi_advanced', 2, CALL_COST_EUR.openapi_advanced, 'IT-advanced firmographics; isTopCompany && on-request; per-lead ceiling €0.13', { onRequestTopOnly: true }),
    ],
  },
  {
    role: 'EMAIL_FIND', verb: 'invoke', phase: 'enrich',
    steps: [
      free('website_body', 0, 'deepened body extraction (homepage + contact/about)'),
      free('email_pattern_guess', 1, 'DISABLED until a real verifier exists (precision risk)', { disabled: true }),
      paid('hunter', 2, HUNTER_OP_COST_EUR.find, 'body produced nothing; within per-field ceiling'),
      paid('snov', 2, CALL_COST_EUR.snov, 'deferred (addendum R6: Hunter covers this)', { disabled: true }),
    ],
  },
  {
    role: 'EMAIL_VERIFY', verb: 'invoke', phase: 'enrich',
    steps: [
      paid('hunter', 2, HUNTER_OP_COST_EUR.verify, 'an email exists to verify (no free fallback — addendum R8)'),
      paid('snov', 2, CALL_COST_EUR.snov, 'deferred', { disabled: true }),
    ],
  },
  {
    role: 'B2B_CONTACT', verb: 'invoke', phase: 'enrich',
    steps: [
      paid('hunter', 2, HUNTER_OP_COST_EUR.find, 'decision-maker roles requested'),
      paid('openapi_advanced', 2, CALL_COST_EUR.openapi_advanced, 'legal rep / shareholders; isTopCompany', { onRequestTopOnly: true }),
      paid('snov', 2, CALL_COST_EUR.snov, 'deferred', { disabled: true }),
    ],
  },
  {
    role: 'DECISION_MAKER', verb: 'invoke', phase: 'enrich',
    steps: [
      free('website_body', 0, 'minority "Legale Rappresentante/Titolare" catch'),
      paid('openapi_advanced', 2, CALL_COST_EUR.openapi_advanced, 'legal rep field; isTopCompany', { onRequestTopOnly: true }),
      paid('hunter', 2, HUNTER_OP_COST_EUR.find, 'people-finder; per-field ceiling'),
    ],
  },
  {
    role: 'REVIEWS_REPUTATION', verb: 'invoke', phase: 'judgment',
    steps: [
      paid('google_places', 2, CALL_COST_EUR.google_places, 'hospitality/ristorazione routing (P3); New API FieldMask SKU', { categoryOnly: ['hospitality', 'ristorazione'] }),
    ],
    note: 'no free fallback (addendum R8); §17 firewall treats absence as unknown, never negative',
  },
  {
    role: 'ADS_SIGNAL', verb: 'invoke', phase: 'judgment',
    steps: [
      free('meta_adlib', 2, 'token-gated free; target country in EU/DSA scope'),
    ],
  },
  {
    role: 'SOCIAL_DETECT', verb: 'invoke', phase: 'enrich',
    steps: [free('website_body', 0, 'footer extraction; NO social-API scraping (forbidden)')],
  },
  {
    role: 'NEWS_AWARDS', verb: 'search', phase: 'judgment',
    steps: [
      free('bing_html', 1, 'free SERP for §2.7 premi/stampa queries'),
      paid('serper', 2, CALL_COST_EUR.serper, 'richer dated news'),
      paid('tavily', 2, CALL_COST_EUR.tavily, 'topic=news'),
    ],
  },
  {
    role: 'TENDER_CONTRACTS', verb: 'invoke', phase: 'judgment',
    steps: [free('anac_ted', 0, 'open data; not yet wired (P1)', { disabled: true })],
  },
  {
    role: 'CERTIFICATIONS', verb: 'invoke', phase: 'judgment',
    steps: [free('accredia', 0, 'public registry; not yet wired (P1)', { disabled: true })],
  },
  {
    role: 'CAPTCHA_SOLVE', verb: 'invoke', phase: 'research',
    steps: [paid('2captcha', 2, 0.0028, 'EXPLICIT operator flag; NEVER official/government sources', { explicitGate: true })],
  },
  {
    role: 'RESIDENTIAL_IP', verb: 'invoke', phase: 'research',
    steps: [paid('residential_proxy', 2, 0.001, 'EXPLICIT flag + compliance sign-off', { explicitGate: true, disabled: true })],
  },
  {
    role: 'EMBEDDINGS', verb: 'invoke', phase: 'enrich',
    steps: [paid('openai', 2, CALL_COST_EUR.openai, 'vector embeddings for ICP similarity/dedup (future)')],
  },
];

const BY_ROLE = new Map<ProviderRole, RoleEntry>(ROLE_REGISTRY.map((e) => [e.role, e]));

/** The ordered cascade steps for a role (empty if the role is unknown). */
export function cascadeForRole(role: ProviderRole): RoleStep[] {
  return BY_ROLE.get(role)?.steps ?? [];
}

/** The full entry (verb + phase + steps) for a role. */
export function roleEntry(role: ProviderRole): RoleEntry | undefined {
  return BY_ROLE.get(role);
}

/** All roles a given provider id participates in (across the registry). */
export function rolesForProvider(providerId: string): ProviderRole[] {
  return ROLE_REGISTRY.filter((e) => e.steps.some((s) => s.providerId === providerId)).map((e) => e.role);
}
