import { z } from 'zod';
import { DEFAULTS } from './defaults';
import { DEFAULT_MODELS } from './models';

// Node 24 loads .env natively (Fase 5.3): dotenv is gone. loadEnvFile writes
// nothing to stdout by construction, so the MCP JSON-RPC channel stays clean.
// Skipped under vitest/CI (hermetic tests: process.env is the only source)
// and when no .env file exists (every key is optional — providers just stay off).
try {
  if (!process.env.VITEST && !process.env.CI) process.loadEnvFile();
} catch {
  /* no .env file — defaults apply, nothing is required */
}

/**
 * Robust env-boolean parser. `z.coerce.boolean()` is WRONG for env vars because
 * JS `Boolean("false") === true` (and `Boolean("0") === true`) — so an explicit
 * `FLAG=false` in .env would ENABLE the flag (a real footgun, incl. paid gates).
 * This treats ONLY true/1/yes/on (case-insensitive) as true; everything else
 * (false/0/no/off/empty) as false; absent → the provided default.
 */
function envBool(def: boolean) {
  return z.preprocess((v) => {
    if (v === undefined) return def;
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }, z.boolean());
}

/**
 * Environment schema. All keys optional except NODE_ENV.
 * Missing API keys do NOT fail validation — they cause the corresponding
 * provider to be silently dropped from the registry at runtime.
 */
/** Exported for the .env.example ↔ schema sync test (Fase 5.3). */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['pretty', 'json']).optional(),

  // Pipeline tuning
  CONCURRENCY: z.coerce.number().int().positive().optional(),
  COST_CEILING_EUR_PER_LEAD: z.coerce.number().nonnegative().optional(),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

  // Free SERP routing. The low-yield free provider `ddg_lite` is
  // SKIPPED for the `italian_real_estate` category profile.
  // Measured over 1,492 leads: the free SERP tier produced 0 final-website
  // conversions; all 536 websites came from input/guess methods + direct_fetch.
  // Set true to force the full free SERP set even for that profile (debug or
  // other-vertical evaluation). See src/providers/provider_policy.ts.
  SERP_EXPANDED_FREE_ENABLED: envBool(false),

  // SERP providers
  SERPER_ENABLED: envBool(false),
  SERPER_API_KEY: z.string().optional(),
  EXA_ENABLED: envBool(false),
  EXA_API_KEY: z.string().optional(),
  TAVILY_ENABLED: envBool(false),
  TAVILY_API_KEY: z.string().optional(),
  PERPLEXITY_ENABLED: envBool(false),
  PERPLEXITY_API_KEY: z.string().optional(),
  PERPLEXITY_BASE_URL: z.url().default('https://api.perplexity.ai'),
  PERPLEXITY_MODEL: z.string().default(DEFAULT_MODELS.perplexity),

  // HTTP fallbacks (WEB_FETCH / WEB_UNBLOCK roles)
  BRIGHTDATA_ENABLED: envBool(false),
  BRIGHTDATA_API_KEY: z.string().optional(), // legacy single-key (kept for back-compat)
  BRIGHTDATA_API_TOKEN: z.string().optional(), // token auth
  BRIGHTDATA_WEB_UNLOCKER_ZONE: z.string().optional(), // zone for WEB_UNBLOCK
  FIRECRAWL_ENABLED: envBool(false),
  FIRECRAWL_API_KEY: z.string().optional(),
  FIRECRAWL_BASE_URL: z.url().default('https://api.firecrawl.dev'),
  ORACLE_CRAWL4AI_URL: z.url().optional(),

  // LLM providers
  OPENAI_ENABLED: envBool(false),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default(DEFAULTS.llm.defaultModel),
  OPENROUTER_ENABLED: envBool(false),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default(DEFAULTS.llm.openrouterModel),
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  DEEPSEEK_ENABLED: envBool(false),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_MODEL: z.string().default(DEFAULT_MODELS.deepseek),
  DEEPSEEK_BASE_URL: z.url().default('https://api.deepseek.com'),
  // Zhipu GLM (Z.AI) — LLM_CHEAP. OpenAI-compatible. PAID (no assumed free tier — see addendum R6).
  ZHIPU_ENABLED: envBool(false),
  ZHIPU_API_KEY: z.string().optional(),
  ZHIPU_MODEL: z.string().default(DEFAULT_MODELS.zhipu),
  ZHIPU_BASE_URL: z.url().default('https://api.z.ai/api/paas/v4'),
  // Kimi (Moonshot) — LLM_CHEAP / long-context. OpenAI-compatible. Key recovered as KIMI_API_KEY.
  KIMI_ENABLED: envBool(false),
  KIMI_API_KEY: z.string().optional(),
  KIMI_MODEL: z.string().default(DEFAULT_MODELS.kimi),
  KIMI_BASE_URL: z.url().default('https://api.moonshot.ai/v1'),
  // Anthropic — default judge LLM for the judgment layer (L4/L5). PAID,
  // disabled by default like every other paid provider (paid-gate OFF).
  ANTHROPIC_ENABLED: envBool(false),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default(DEFAULTS.llm.anthropicModel),

  // Email inference + MX/SMTP handshake (EMAIL_FIND). FREE (DNS + SMTP RCPT, no
  // mail sent). An inferred email is personal data, so the master flag is
  // OFF by default — turning it on is the operator's explicit, documented choice.
  // When ON, the SMTP RCPT handshake runs by default (the whole point: verify
  // before asserting); set EMAIL_SMTP_PROBE_ENABLED=false to force MX-only mode
  // (no outbound :25) on a host where port 25 is blocked or to avoid RCPT probes.
  EMAIL_INFERENCE_MX_ENABLED: envBool(false),
  EMAIL_SMTP_PROBE_ENABLED: envBool(true),
  EMAIL_SMTP_HELO_NAME: z.string().default('verifier.local'),
  EMAIL_SMTP_MAIL_FROM: z.string().default('verify@verifier.local'),
  EMAIL_INFERENCE_MAX_PROBES_PER_DOMAIN: z.coerce.number().int().positive().default(3),

  // Free-gold DEEPENED extraction (FREE — direct_fetch only, no paid API). When
  // ON, after the homepage/verified-body free-gold pass the pipeline ALSO mines
  // every lead's official_website multipage (homepage + /contatti + /chi-siamo) —
  // recovering email/social/PEC/VAT that a single-page match, or a semantic-only
  // (body-less) match, otherwise loses. €0 in the free profile; composes with the
  // paid render fallback (Firecrawl/BrightData) when the paid gate is on.
  DEEP_PAGES_ENABLED: envBool(false),

  // Input-website NAME-MATCH recovery (FREE — no fetch). The content verify only
  // accepts a site when the PAGE carries the lead's P.IVA/phone or a semantic
  // body match; it IGNORES the domain. So a real agency site whose body is
  // JS-rendered, drops the connection, or lacks a P.IVA (the lead has none to
  // match) is thrown away even when the domain literally spells the company —
  // `immobiliareziero.it` for "Immobiliare Ziero" (measured: ~12% of leads,
  // ~76% domain↔name). When ON, after content-verify fails the input website is
  // accepted iff a DISTINCTIVE name token (len≥4, non-generic) is embedded in the
  // registrable domain, at a modest confidence + INPUT_DOMAIN_NAME_MATCH method.
  // Default OFF: it asserts a website without a live-body confirmation, so it is
  // the operator's explicit choice; precision rests on the distinctive-token gate.
  INPUT_WEBSITE_NAME_MATCH_ENABLED: envBool(false),

  // Enrichment extras — email find/verify + B2B contact
  HUNTER_ENABLED: envBool(false),
  HUNTER_API_KEY: z.string().optional(),

  // Official Italian company-data sources (OFFICIAL_COMPANY_DATA role). Free sources default ON.
  // MASTER switch for running the guarded per-field official-data cascades
  // (VAT/VIES, PEC, revenue/employees via fatturatoitalia) on the CLI enrich
  // path. Default OFF so a plain enrich run stays offline + €0; the per-source
  // flags below still gate each lookup once this is on.
  OFFICIAL_DATA_ENRICH_ENABLED: envBool(false),
  OFFICIAL_DATA_VIES_ENABLED: envBool(true),
  OFFICIAL_DATA_FATTURATOITALIA_ENABLED: envBool(true),

  // Judgment-layer sources (all disabled by default; presence-before-depth).
  // Google Places API — official source for Maps/GBP/reviews/hours.
  GOOGLE_PLACES_ENABLED: envBool(false),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  // Ad transparency libraries (Meta Ad Library / Google Ads Transparency).
  ADLIB_ENABLED: envBool(false),
  ADLIB_API_KEY: z.string().optional(),

  // Openapi.com — official Italian company registry (InfoCamere reseller). PAID,
  // disabled by default. Used ONLY for top companies on explicit request (the
  // activation layer — see docs/openapi_layer_rules.md). The free IT-search tier
  // (≤100/day) still requires the key + enabled. Base URL switches prod/sandbox.
  OPENAPI_ENABLED: envBool(false),
  OPENAPI_API_KEY: z.string().optional(),
  OPENAPI_BASE_URL: z.url().default('https://company.openapi.com'),

  // Apify — external actor marketplace. PAID, OFF by default. Per-actor flags gate
  // each actor: maps = GREEN (public business data); contact/facebook = YELLOW;
  // instagram/tiktok = RED (higher ToS risk, conscious opt-in) — see provider_status.md.
  APIFY_ENABLED: envBool(false),
  APIFY_API_KEY: z.string().optional(),
  APIFY_MAPS_ENABLED: envBool(false),
  APIFY_CONTACT_ENABLED: envBool(false),
  APIFY_INSTAGRAM_ENABLED: envBool(false),
  APIFY_FACEBOOK_ENABLED: envBool(false),
  APIFY_TIKTOK_ENABLED: envBool(false),
  APIFY_REGISTRO_ENABLED: envBool(false),
  // Marketplace actors each get an id override (APIFY_*_ACTOR_ID) so they
  // survive marketplace drift without a code change.
  // email_verify has NO default id: the operator picks the
  // verifier actor at probe time, so its ACTOR_ID is required to enable it.
  APIFY_PORTAL_IMMOBILIARE_ENABLED: envBool(false),
  APIFY_PORTAL_IMMOBILIARE_ACTOR_ID: z.string().optional(),
  APIFY_PORTAL_IMMOBILIARE_ADS_ENABLED: envBool(false),
  APIFY_PORTAL_IMMOBILIARE_ADS_ACTOR_ID: z.string().optional(),
  APIFY_PORTAL_WIKICASA_ENABLED: envBool(false),
  APIFY_PORTAL_WIKICASA_ACTOR_ID: z.string().optional(),
  APIFY_BILANCI_ENABLED: envBool(false),
  APIFY_BILANCI_ACTOR_ID: z.string().optional(),
  APIFY_EMAIL_VERIFY_ENABLED: envBool(false),
  APIFY_EMAIL_VERIFY_ACTOR_ID: z.string().optional(),

  // Perplexity entity-resolution (last-resort discovery) — reuses the wired
  // Perplexity LLM. OFF by default; gated by the paid budget like every paid call.
  PERPLEXITY_RESOLVE_ENABLED: envBool(false),

  // Default-cap paid escalation: flip paid ON by default at a SMALL per-lead cap
  // (the router's hard run-ceiling + per-lead budget still enforce it). Default OFF
  // in code (offline-first / €0 suite); set true in .env to auto-escalate.
  PAID_DEFAULT_ON: envBool(false),
  DEFAULT_PAID_CAP_EUR_PER_LEAD: z.coerce.number().nonnegative().default(0.015),

  // Browser
  PLAYWRIGHT_HEADLESS: envBool(true),

  // Tests
  RUN_SMOKE: envBool(false),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Thrown when `process.env` fails validation; the message lists every bad variable. */
export class EnvConfigError extends Error {
  constructor(readonly issues: ReadonlyArray<{ variable: string; problem: string }>) {
    super(`Invalid environment configuration (check .env):\n${issues.map((i) => `  - ${i.variable}: ${i.problem}`).join('\n')}`);
    this.name = 'EnvConfigError';
  }
}

export function getEnv(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new EnvConfigError(parsed.error.issues.map((i) => ({ variable: i.path.join('.') || '(root)', problem: i.message })));
    }
    cached = parsed.data;
  }
  return cached;
}

/**
 * Test-only seam: clears the memoized env so a test can mutate
 * `process.env` and observe the new value on the next `getEnv()`.
 * Never call this in production code paths.
 */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * The paid-provider candidate table. Data-driven so enabling ANY implemented paid
 * provider satisfies `--enable-paid`. Each entry names the enable flag + the secret
 * that makes it usable. Keep in sync with the role registry / catalog.
 *
 * Only providers with an implementation under src/providers belong here. Snov and
 * 2Captcha have env vars but no client: listing them let `--enable-paid` pass on
 * their keys alone while every call stayed free.
 */
function paidProviderCandidates(): Array<{ name: string; enabled: boolean; key?: string; keyVar: string; enableVar: string }> {
  const env = getEnv();
  return [
    { name: 'serper', enabled: env.SERPER_ENABLED, key: env.SERPER_API_KEY, keyVar: 'SERPER_API_KEY', enableVar: 'SERPER_ENABLED' },
    { name: 'exa', enabled: env.EXA_ENABLED, key: env.EXA_API_KEY, keyVar: 'EXA_API_KEY', enableVar: 'EXA_ENABLED' },
    { name: 'tavily', enabled: env.TAVILY_ENABLED, key: env.TAVILY_API_KEY, keyVar: 'TAVILY_API_KEY', enableVar: 'TAVILY_ENABLED' },
    { name: 'perplexity', enabled: env.PERPLEXITY_ENABLED, key: env.PERPLEXITY_API_KEY, keyVar: 'PERPLEXITY_API_KEY', enableVar: 'PERPLEXITY_ENABLED' },
    { name: 'brightdata', enabled: env.BRIGHTDATA_ENABLED, key: env.BRIGHTDATA_API_TOKEN ?? env.BRIGHTDATA_API_KEY, keyVar: 'BRIGHTDATA_API_TOKEN', enableVar: 'BRIGHTDATA_ENABLED' },
    { name: 'firecrawl', enabled: env.FIRECRAWL_ENABLED, key: env.FIRECRAWL_API_KEY, keyVar: 'FIRECRAWL_API_KEY', enableVar: 'FIRECRAWL_ENABLED' },
    { name: 'openai', enabled: env.OPENAI_ENABLED, key: env.OPENAI_API_KEY, keyVar: 'OPENAI_API_KEY', enableVar: 'OPENAI_ENABLED' },
    { name: 'openrouter', enabled: env.OPENROUTER_ENABLED, key: env.OPENROUTER_API_KEY, keyVar: 'OPENROUTER_API_KEY', enableVar: 'OPENROUTER_ENABLED' },
    { name: 'deepseek', enabled: env.DEEPSEEK_ENABLED, key: env.DEEPSEEK_API_KEY, keyVar: 'DEEPSEEK_API_KEY', enableVar: 'DEEPSEEK_ENABLED' },
    { name: 'zhipu', enabled: env.ZHIPU_ENABLED, key: env.ZHIPU_API_KEY, keyVar: 'ZHIPU_API_KEY', enableVar: 'ZHIPU_ENABLED' },
    { name: 'kimi', enabled: env.KIMI_ENABLED, key: env.KIMI_API_KEY, keyVar: 'KIMI_API_KEY', enableVar: 'KIMI_ENABLED' },
    { name: 'anthropic', enabled: env.ANTHROPIC_ENABLED, key: env.ANTHROPIC_API_KEY, keyVar: 'ANTHROPIC_API_KEY', enableVar: 'ANTHROPIC_ENABLED' },
    { name: 'hunter', enabled: env.HUNTER_ENABLED, key: env.HUNTER_API_KEY, keyVar: 'HUNTER_API_KEY', enableVar: 'HUNTER_ENABLED' },
    { name: 'google_places', enabled: env.GOOGLE_PLACES_ENABLED, key: env.GOOGLE_PLACES_API_KEY, keyVar: 'GOOGLE_PLACES_API_KEY', enableVar: 'GOOGLE_PLACES_ENABLED' },
    { name: 'openapi', enabled: env.OPENAPI_ENABLED, key: env.OPENAPI_API_KEY, keyVar: 'OPENAPI_API_KEY', enableVar: 'OPENAPI_ENABLED' },
    { name: 'apify', enabled: env.APIFY_ENABLED, key: env.APIFY_API_KEY, keyVar: 'APIFY_API_KEY', enableVar: 'APIFY_ENABLED' },
  ];
}

/**
 * Fail fast with an actionable message when the operator asked
 * for paid providers but none is actually usable. Without this, a missing
 * SERPER_API_KEY silently dropped the provider from the registry and the
 * "paid" run completed free-only with no signal.
 */
export function assertPaidSecrets(): void {
  const paidCandidates = paidProviderCandidates();
  const usable = paidCandidates.filter((p) => p.enabled && p.key && p.key.length > 0);
  if (usable.length > 0) return;

  const enabledButKeyless = paidCandidates.filter((p) => p.enabled && (!p.key || p.key.length === 0));
  if (enabledButKeyless.length > 0) {
    const names = enabledButKeyless.map((p) => `${p.name} (${p.enableVar}=true but ${p.keyVar} is empty)`).join(', ');
    throw new Error(
      `--enable-paid was passed but no paid provider has a usable API key: ${names}. ` +
        `Set the missing key in .env, or drop --enable-paid to run free-only.`
    );
  }
  throw new Error(
    `--enable-paid was passed but no paid provider is enabled in the environment. ` +
      `Set e.g. SERPER_ENABLED=true and SERPER_API_KEY=<key> in .env, or drop --enable-paid to run free-only.`
  );
}

/** Resolved runtime config — env merged onto DEFAULTS. */
export function getConfig() {
  const env = getEnv();
  return {
    env,
    pipeline: {
      concurrency: env.CONCURRENCY ?? DEFAULTS.pipeline.concurrency,
      costCeilingEurPerLead: env.COST_CEILING_EUR_PER_LEAD ?? DEFAULTS.pipeline.costCeilingEurPerLead,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS ?? DEFAULTS.pipeline.requestTimeoutMs,
      perStageTimeoutMs: DEFAULTS.pipeline.perStageTimeoutMs,
    },
    scraper: DEFAULTS.scraper,
    cache: DEFAULTS.cache,
    http: DEFAULTS.http,
    llm: DEFAULTS.llm,
    scoring: DEFAULTS.scoring,
  } as const;
}

export type ResolvedConfig = ReturnType<typeof getConfig>;
