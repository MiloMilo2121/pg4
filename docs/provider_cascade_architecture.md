# Provider Cascade Architecture — pg4 Lead Engine

> Spec version 1.0 · target: `pg4/` · author: architect pass · status: blueprint (implement-from)
>
> Scope: RESEARCH + ENRICHMENT phases. Raw direct-fetch scraping is already solved (`direct_fetch` tier-0) and is NOT redesigned here — it is reused as the `WEB_FETCH` tier-0 step.

## 0. Design goals & non-goals

**Goals**
- One **role-based** layer on top of the existing `ProviderRouter`. A *role* is a functional capability (e.g. `SEARCH_WEB`, `OFFICIAL_COMPANY_DATA`, `LLM_JUDGE`). A *provider* fulfils one or MORE roles.
- Each role has an **ordered cascade**: free providers first → cheap-paid → premium, each step carrying an **activation condition**.
- **EXTEND, do not rewrite** the router. All cost/tier/breaker/budget gates stay exactly where they are (`provider_router.ts:283-326`). The role layer compiles a role+condition request down into the existing `RouteOptions` (`includeProviderIds`, `maxTier`, `paidEnabled`, `remainingLeadBudgetEur`, `runCostCeilingEur`, `excludeProviderIds`).
- **Default-deny on paid**: a run is €0 unless it opts in (`--enable-paid` → `paidEnabled:true`). The router paid-gate (`provider_router.ts:294`) remains the load-bearing safety.

**Non-goals**
- No replacement of `direct_fetch`, `CircuitBreaker`, `RateLimiter`, `CostLedger`, or the per-field `EnrichmentStep` runner. They are wiring targets, not rewrites.
- No activation of forbidden sources (`google-maps-scrape`, `linkedin-scrape`, `facebook-instagram-scrape`). These are encoded as `FORBIDDEN` and never registered.
- `crtsh` and `dns_mx` stay removed (Gate-0: 0 successes in 12,728 calls each).

## 1. The role layer (how it sits on the router)

Today, three families exist (`serp` | `http` | `llm`) and a caller picks a *method* (`search`/`fetch`/`complete`). The role layer adds a **fourth-axis classification** that is orthogonal to family: a `ProviderRole` enum. Each provider gets a static `roles: ProviderRole[]` field. A **RoleRegistry** (data) maps each role to its ordered cascade of `{providerId, tier, costEur, condition}`.

A new thin module, the **RoleResolver** (`src/providers/role_resolver.ts`), is the only new orchestration. It does NOT call providers — it COMPILES a `(role, ctx)` request into `RouteOptions` and delegates to `router.search/fetch/complete`, OR (for non-router roles like official-data and reviews) into the harvest/field-cascade adapters. The router's cascade then does the actual tier-ordered selection + gating. This keeps ALL gate logic in one place.

```
caller ── resolveRole(role, ctx) ──► RoleResolver
                                         │  (reads RoleRegistry → eligible providerIds
                                         │   after evaluating each step's `condition`)
                                         ▼
                          RouteOptions { includeProviderIds, maxTier,
                                         paidEnabled, remainingLeadBudgetEur,
                                         runCostCeilingEur, excludeProviderIds, meta }
                                         │
                                         ▼
                         router.search / router.fetch / router.complete
                                         │  (existing filter pipeline: availability →
                                         │   breaker → tier → paid-gate → budget →
                                         │   ceiling → include/exclude → sort → slice)
                                         ▼
                                   first non-empty success
```

The role layer NEVER bypasses a router gate. `includeProviderIds` is the join key: the resolver computes the cascade-eligible id list (post-condition) and hands it to the router, which still applies availability/breaker/budget on top. Belt and suspenders.

## 2. Role taxonomy

| Role | Phase | Family/Path | Description | Default cost |
|------|-------|-------------|-------------|--------------|
| `SEARCH_WEB` | Research (L2/L3) | serp (router.search) | Discover company sites + third-party signals via SERP | €0 free-first |
| `WEB_FETCH` | Research/Enrich | http (router.fetch) | Fetch + verify discovered pages, body extraction | €0 |
| `WEB_UNBLOCK` | Research/Enrich | http (router.fetch) | Bypass blocks when direct_fetch fails | paid only |
| `LLM_JUDGE` | Judgment (L4/L5) | llm (router.complete) | Two-axis target verdict synthesis. Default Anthropic | paid only |
| `LLM_REASON` | Enrich/Judgment | llm (router.complete) | General reasoning/extraction/entity recognition | paid only |
| `LLM_CHEAP` | Enrich | llm (router.complete) | Cost-optimized light reasoning / pre-filters | paid only |
| `OFFICIAL_COMPANY_DATA` | Enrich | harvest+field | VAT validation, fatturato, employees, PEC, registry firmographics | €0 free-first |
| `EMAIL_FIND` | Enrich | field cascade | Discover company emails (body → finder API) | €0 free-first |
| `EMAIL_VERIFY` | Enrich | field cascade | SMTP/deliverability validation | paid only |
| `B2B_CONTACT` | Enrich | field cascade | Decision-maker contact w/ role + seniority | paid only |
| `DECISION_MAKER` | Enrich | field cascade | Identify legal rep / founder / board | €0 minority + paid |
| `REVIEWS_REPUTATION` | Judgment (A+B) | harvest (Places) | Reviews/rating (A) + GBP presence (B) | paid only |
| `ADS_SIGNAL` | Judgment (B) | harvest (AdLib) | Active-advertiser detection | free (token-gated) |
| `SOCIAL_DETECT` | Enrich | field tier-0 | Social links from footer (no social API) | €0 |
| `TECH_SIGNAL` | Enrich | tier-0 | Tech stack from HTML (future radar) | €0 |
| `TENDER_CONTRACTS` | Judgment (A) | harvest (ANAC/TED) | Public-tender wins, qualified supplier | €0 (open data) |
| `CERTIFICATIONS` | Judgment (A) | harvest (Accredia) | ISO/professional certs | €0 |
| `FAIR_PRESENCE` | Judgment (A) | harvest | Trade-fair attendee rosters | €0 mixed-ToS |
| `NEWS_AWARDS` | Judgment (A) | serp (router.search) | Prizes/press/awards via free SERP | €0 |
| `PDF_EXTRACT` | Enrich | tier-0/1 | Structured data from PDF catalogs/rosters | €0 |
| `CAPTCHA_SOLVE` | Research (gated) | side-service | Solve CAPTCHA; explicit gate only | paid only |
| `RESIDENTIAL_IP` | Research (gated) | side-service | Residential-IP routing; compliance gate | paid only |
| `EMBEDDINGS` | Enrich (future) | llm-aux | Vector embeddings for ICP similarity/dedup | paid only |

## 3. Per-role cascade tables (ordered provider · tier · €cost · activation condition)

Costs are €/call estimates (USD→EUR ≈ 0.92; pricing from integration specs). "Condition" is the predicate evaluated by the RoleResolver *before* the provider is added to `includeProviderIds`. The router then re-applies its own gates.

### SEARCH_WEB
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `bing_html` | 1 | 0 | always (free, no-key); rate 0.5 req/s |
| 2 | `ddg_lite` | 1 | 0 | always EXCEPT `italian_real_estate` profile (R14 denylist) unless `SERP_EXPANDED_FREE_ENABLED` |
| 3 | `serper` | 2 | 0.001 | `paidEnabled && SERPER_ENABLED && key`; blocked for `italian_real_estate` (R14 low-yield); fits remaining budget |
| 4 | `tavily` | 2 | 0.0074 (basic) | `paidEnabled && TAVILY_ENABLED && key`; used when richer snippets/raw content needed (judgment discovery) |
| 5 | `exa` | 2 | 0.0064 (10 res) | `paidEnabled && EXA_ENABLED && key`; semantic/editorial precision for third-party A-signals |
| 6 | `perplexity` | 2 | ~0.012+search-fee | `paidEnabled && PERPLEXITY_ENABLED && key`; grounded-answer fallback (also LLM_REASON); **NOT yet in catalog** |
| 7 | `brightdata` (SERP zone) | 2 | 0.00138 | `paidEnabled && BRIGHTDATA_ENABLED && BRIGHTDATA_SERP_ZONE`; last-resort SERP when blocked |

### WEB_FETCH
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `direct_fetch` | 0 | 0 | always; breaker tuned loose (15/60/30) |
| 2 | `firecrawl` | 2 | 0.0046 (1 cr) | `paidEnabled && FIRECRAWL_ENABLED && key`; only after direct_fetch returns block/empty |
| 3 | `brightdata` (unlocker zone) | 2 | 0.00138 | `paidEnabled && BRIGHTDATA_ENABLED && BRIGHTDATA_WEB_UNLOCKER_ZONE`; tough targets; compliance review |

### WEB_UNBLOCK (subset of WEB_FETCH, paid-only escalation)
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `firecrawl` | 2 | 0.0046 | `paidEnabled && FIRECRAWL_ENABLED`; direct_fetch failed (block/JS) |
| 2 | `brightdata` (unlocker) | 2 | 0.00138 | `paidEnabled && BRIGHTDATA_ENABLED`; firecrawl failed OR residential needed |
| 3 | `oracle_crawl4ai` | 2 | ~0 (self-host) | `ORACLE_CRAWL4AI_URL` set; sidecar reachable; high port-effort |

### LLM_JUDGE
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `anthropic` | 2 | 0.02 | `paidEnabled && ANTHROPIC_ENABLED && key` (DEFAULT judge, model `claude-opus-4-8`) |
| 2 | `openrouter` | 2 | 0.02 | `paidEnabled && OPENROUTER_ENABLED && key`; routes to Claude/other (no new secret) |
| 3 | `openai` | 2 | ~0.01 | `paidEnabled && OPENAI_ENABLED && key`; fallback judge when Anthropic + OpenRouter down |

### LLM_REASON
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `openrouter` | 2 | varies | `paidEnabled && OPENROUTER_ENABLED`; multi-model gateway |
| 2 | `openai` | 2 | ~0.01 | `paidEnabled && OPENAI_ENABLED`; Responses API |
| 3 | `deepseek` | 2 | ~0.002 | `paidEnabled && DEEPSEEK_ENABLED`; cost-optimized; **not yet in catalog** |
| 4 | `perplexity` | 2 | ~0.012 | `paidEnabled && PERPLEXITY_ENABLED`; grounded reasoning; **not yet in catalog** |
| 5 | `anthropic` | 2 | 0.02 | `paidEnabled && ANTHROPIC_ENABLED`; premium reasoning |

### LLM_CHEAP
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `zhipu_glm` (GLM-4.7-Flash) | 2 | 0 (free model) | `ZHIPU_ENABLED && key`; cheapest extraction; **not yet in catalog** |
| 2 | `deepseek` (v4-flash) | 2 | ~0.0006 | `paidEnabled && DEEPSEEK_ENABLED`; cheap reasoning |
| 3 | `kimi` (k2.5) | 2 | ~0.001 | `paidEnabled && KIMI_ENABLED`; long-context; **not yet in catalog** |
| 4 | `openai` (gpt-4o-mini) | 2 | ~0.002 | `paidEnabled && OPENAI_ENABLED`; reliable cheap fallback |

### OFFICIAL_COMPANY_DATA
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `vies` | 1 | 0 | `OFFICIAL_DATA_VIES_ENABLED` (default true); checksum-valid VAT present; field `vat.vies_confirmed` |
| 2 | `fatturatoitalia` | 1 | 0 | `OFFICIAL_DATA_FATTURATOITALIA_ENABLED` (default true); resolved VAT; entity-guard (`isWrongEntity`) |
| 3 | `openapi` (IT-search dryRun) | 2 | 0 (≤100/day free) | `OPENAPI_ENABLED && key`; ATECO+province coverage sizing only (count, no records) |
| 4 | `openapi` (IT-advanced/IT-pec) | 2 | 0.10 / 0.03 | `paidEnabled && OPENAPI_ENABLED && isTopCompany(lead) && on-request`; per-lead ceiling €0.13; **activation layer pending** |

### EMAIL_FIND
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `website_body` (`email.body_same_domain`) | 0 | 0 | always; deepened extraction (homepage+contact/about) |
| 2 | `email.pattern_guess` | 1 | 0 | **disabled** until a real verifier exists (precision risk) |
| 3 | `hunter` (email-finder/domain-search) | 2 | ~0.04 (1 cr) | `paidEnabled && HUNTER_ENABLED && key`; body produced nothing; within per-field ceiling €0.05 |
| 4 | `snov` (emails-by-domain-by-name) | 2 | ~0.036 (1 cr) | `paidEnabled && SNOV_ENABLED && OAuth creds`; **not yet in catalog** |

### EMAIL_VERIFY
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `hunter` (email-verifier) | 2 | ~0.02 (0.5 cr) | `paidEnabled && HUNTER_ENABLED`; an email exists to verify |
| 2 | `snov` (email-verification) | 2 | ~0.036 | `paidEnabled && SNOV_ENABLED`; **not yet in catalog** |

### B2B_CONTACT
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `hunter` (domain-search + roles) | 2 | ~0.04 | `paidEnabled && HUNTER_ENABLED`; decision-maker roles requested |
| 2 | `snov` (prospects + profile) | 2 | ~0.036 | `paidEnabled && SNOV_ENABLED`; **not yet in catalog** |
| 3 | `openapi` (IT-advanced shareholders) | 2 | 0.10 | `paidEnabled && OPENAPI_ENABLED && isTopCompany`; legal rep / shareholders |

### DECISION_MAKER
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `website_body` (`decision_maker.body_chisiamo`) | 0 | 0 | always; minority "Legale Rappresentante/Titolare" catch |
| 2 | `openapi` (IT-advanced) | 2 | 0.10 | `paidEnabled && OPENAPI_ENABLED && isTopCompany`; legal rep field |
| 3 | `hunter`/`snov` (people-finder) | 2 | ~0.04 | `paidEnabled` + finder enabled; per-field ceiling €0.15 |

### REVIEWS_REPUTATION
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `google_places` (Text Search New + Place Details Atmosphere) | 2 | ~0.037 (search) + 0.023 (details) | `paidEnabled && GOOGLE_PLACES_ENABLED && key`; hospitality/ristorazione category routing (P3); FieldMask drives SKU |

### ADS_SIGNAL
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `meta_adlib` (ads_archive) | 2(free-cost) | 0 (token-gated) | `ADLIB_ENABLED && META_AD_LIBRARY_TOKEN`; target country in EU/DSA scope; identity-confirmed app |

### SOCIAL_DETECT
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `website_body` (`instagram/facebook/linkedin.body_footer`) | 0 | 0 | always; footer extraction; NO social-API scraping (forbidden) |

### TENDER_CONTRACTS
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `anac_ted` | 0 | 0 | `ANAC_TED_ENABLED`; open data; **not yet wired (P1)** |

### CERTIFICATIONS
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `accredia` | 0 | 0 | `ACCREDIA_ENABLED`; public registry; **not yet wired (P1)** |

### NEWS_AWARDS
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `bing_html` | 1 | 0 | always (free SERP for §2.7 premi/stampa queries) |
| 2 | `serper` (news endpoint) | 2 | 0.001 | `paidEnabled && SERPER_ENABLED`; richer dated news |
| 3 | `tavily` (topic=news) | 2 | 0.0074 | `paidEnabled && TAVILY_ENABLED` |

### CAPTCHA_SOLVE / RESIDENTIAL_IP (gated, never auto)
| # | Provider | Tier | €/call | Activation condition |
|---|----------|------|--------|----------------------|
| 1 | `2captcha` | 2 | ~0.0009–0.0028 | `TWOCAPTCHA_ENABLED` + EXPLICIT operator flag; NEVER for official/government sources |
| 1 | `residential_proxy` | 2 | per-GB | EXPLICIT operator flag + compliance sign-off; **not yet in env** |

## 4. Multi-role map (provider → roles)

| Provider | Roles |
|----------|-------|
| `bing_html` | SEARCH_WEB, NEWS_AWARDS, WEB_FETCH(html) |
| `ddg_lite` | SEARCH_WEB |
| `serper` | SEARCH_WEB, NEWS_AWARDS |
| `tavily` | SEARCH_WEB, NEWS_AWARDS |
| `exa` | SEARCH_WEB |
| `perplexity` | SEARCH_WEB, LLM_REASON |
| `direct_fetch` | WEB_FETCH |
| `firecrawl` | WEB_FETCH, WEB_UNBLOCK |
| `brightdata` | WEB_FETCH, WEB_UNBLOCK, SEARCH_WEB(serp-zone) |
| `oracle_crawl4ai` | WEB_UNBLOCK |
| `anthropic` | LLM_JUDGE, LLM_REASON |
| `openrouter` | LLM_JUDGE, LLM_REASON |
| `openai` | LLM_JUDGE, LLM_REASON, LLM_CHEAP, EMBEDDINGS |
| `deepseek` | LLM_REASON, LLM_CHEAP |
| `zhipu_glm` | LLM_CHEAP |
| `kimi` | LLM_CHEAP, LLM_REASON(long-context) |
| `vies` | OFFICIAL_COMPANY_DATA |
| `fatturatoitalia` | OFFICIAL_COMPANY_DATA |
| `openapi` | OFFICIAL_COMPANY_DATA, DECISION_MAKER, B2B_CONTACT |
| `hunter` | EMAIL_FIND, EMAIL_VERIFY, B2B_CONTACT, DECISION_MAKER |
| `snov` | EMAIL_FIND, EMAIL_VERIFY, B2B_CONTACT |
| `google_places` | REVIEWS_REPUTATION |
| `meta_adlib` | ADS_SIGNAL |
| `website_body` | EMAIL_FIND, SOCIAL_DETECT, DECISION_MAKER, TECH_SIGNAL, PDF_EXTRACT |
| `2captcha` | CAPTCHA_SOLVE |
| `anac_ted` | TENDER_CONTRACTS |
| `accredia` | CERTIFICATIONS |

## 5. Provider → env-var → adapter table

| Provider | Enable flag | Secret(s) | Base URL / model env | Adapter file | Auth |
|----------|-------------|-----------|----------------------|--------------|------|
| `bing_html` | (always) | — | — | `serp/bing_html.ts` (exists) | none |
| `ddg_lite` | (always) | — | — | `serp/ddg_lite.ts` (exists) | none |
| `serper` | `SERPER_ENABLED` | `SERPER_API_KEY` | `https://google.serper.dev` | `serp/serper.ts` (exists) | `X-API-KEY` header |
| `tavily` | `TAVILY_ENABLED` | `TAVILY_API_KEY` | `https://api.tavily.com` | `serp/tavily.ts` (exists) | `Authorization: Bearer tvly-…` |
| `exa` | `EXA_ENABLED` | `EXA_API_KEY` | `https://api.exa.ai` | `serp/exa.ts` (exists) | `x-api-key` header |
| `perplexity` | `PERPLEXITY_ENABLED` | `PERPLEXITY_API_KEY` | `https://api.perplexity.ai` | `serp/perplexity.ts` (NEW) + `llm/perplexity.ts` (NEW) | `Authorization: Bearer` |
| `direct_fetch` | (always) | — | — | `http/direct_fetch.ts` (exists) | none |
| `firecrawl` | `FIRECRAWL_ENABLED` | `FIRECRAWL_API_KEY` | `https://api.firecrawl.dev/v2` | `http/firecrawl.ts` (NEW) | `Authorization: Bearer fc-…` |
| `brightdata` | `BRIGHTDATA_ENABLED` | `BRIGHTDATA_API_TOKEN` | `https://api.brightdata.com` + `BRIGHTDATA_WEB_UNLOCKER_ZONE`, `BRIGHTDATA_SERP_ZONE` | `http/brightdata.ts` (NEW) | `Authorization: Bearer`; `zone` in body |
| `oracle_crawl4ai` | (url presence) | — | `ORACLE_CRAWL4AI_URL` | `http/oracle_crawl4ai.ts` (NEW) | sidecar |
| `anthropic` | `ANTHROPIC_ENABLED` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` + `ANTHROPIC_MODEL` | `llm/anthropic.ts` (exists) | `x-api-key` + `anthropic-version` |
| `openrouter` | `OPENROUTER_ENABLED` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` + `OPENROUTER_MODEL` | `llm/openrouter.ts` (exists) | `Authorization: Bearer` |
| `openai` | `OPENAI_ENABLED` | `OPENAI_API_KEY` | `https://api.openai.com/v1` + `OPENAI_MODEL` | `llm/openai.ts` (NEW) | `Authorization: Bearer` |
| `deepseek` | `DEEPSEEK_ENABLED` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` + `DEEPSEEK_MODEL` (deepseek-v4-flash) | `llm/deepseek.ts` (NEW) | `Authorization: Bearer` |
| `zhipu_glm` | `ZHIPU_ENABLED` | `ZHIPU_API_KEY` | `https://api.z.ai/api/paas/v4` + `ZHIPU_MODEL` (glm-4.7-flash) | `llm/zhipu_glm.ts` (NEW) | `Authorization: Bearer` |
| `kimi` | `KIMI_ENABLED` | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` + `KIMI_MODEL` (kimi-k2.5) | `llm/kimi.ts` (NEW) | `Authorization: Bearer` |
| `vies` | `OFFICIAL_DATA_VIES_ENABLED` (default true) | — | EU VIES | `enrichment/financial/vies.ts` (exists) | none |
| `fatturatoitalia` | `OFFICIAL_DATA_FATTURATOITALIA_ENABLED` (default true) | — | fatturatoitalia.it | `enrichment/financial/fatturato_italia_fetch.ts` (exists) | none |
| `openapi` | `OPENAPI_ENABLED` | `OPENAPI_API_KEY` | `OPENAPI_BASE_URL` (default `https://company.openapi.com`) | `providers/openapi/openapi_client.ts` (exists) | `Authorization: Bearer` |
| `hunter` | `HUNTER_ENABLED` | `HUNTER_API_KEY` | `https://api.hunter.io/v2` | `providers/email/hunter.ts` (NEW) | `api_key` query / `Authorization: Bearer` |
| `snov` | `SNOV_ENABLED` | `SNOVIO_CLIENT_ID`, `SNOVIO_CLIENT_SECRET` | `https://api.snov.io` | `providers/email/snov.ts` (NEW) | OAuth2 client_credentials → Bearer |
| `google_places` | `GOOGLE_PLACES_ENABLED` | `GOOGLE_PLACES_API_KEY` | `https://places.googleapis.com/v1` | `judgment/harvest/adapters/places_adapter.ts` (exists — MIGRATE to New API) | `X-Goog-Api-Key` + `X-Goog-FieldMask` |
| `meta_adlib` | `ADLIB_ENABLED` | `META_AD_LIBRARY_TOKEN` | `https://graph.facebook.com/v25.0` | `judgment/harvest/adapters/ad_library_adapter.ts` (exists) | `access_token` query/Bearer |
| `2captcha` | `TWOCAPTCHA_ENABLED` | `TWOCAPTCHA_API_KEY` | `https://api.2captcha.com` | `providers/captcha/twocaptcha.ts` (NEW) | `clientKey` in body |
| `anac_ted` | `ANAC_TED_ENABLED` | — | ANAC/TED open data | `judgment/harvest/adapters/tender_adapter.ts` (NEW) | none |
| `accredia` | `ACCREDIA_ENABLED` | — | Accredia registry | `judgment/harvest/adapters/cert_adapter.ts` (NEW) | none |

## 6. Activation-condition rules (the predicates)

All predicates are pure functions on `(provider, RoleResolveContext)`. The resolver short-circuits a step (excludes its provider) when its condition is false; the router then re-asserts the same gates independently.

1. **free-first**: every cascade lists tier-0/1 (cost 0) before any tier-2. The router sorts ascending by tier anyway; the registry order is the contract for readability + for the `paidOnly` second-pass.
2. **paid-gate (default-deny)**: a tier-2 step's condition includes `ctx.paidEnabled === true`. Without `--enable-paid` the run is €0 (router `provider_router.ts:294` is the enforcer).
3. **key+flag present**: condition reuses the provider's own `available()` (`ENABLED && key`). The resolver does NOT duplicate the check — it calls `available()`.
4. **per-lead budget**: condition `provider.costPerCallEur <= ctx.remainingLeadBudgetEur`. Compiled into `RouteOptions.remainingLeadBudgetEur`.
5. **run cost ceiling**: compiled into `RouteOptions.runCostCeilingEur`; router atomically reserves (`provider_router.ts:148-154`).
6. **category routing**: e.g. `italian_real_estate` → exclude `ddg_lite`+`serper` (R14); `hospitality/ristorazione` → enable `google_places` for REVIEWS_REPUTATION (P3). Compiled into `excludeProviderIds` / `includeProviderIds` via an extended `provider_policy.ts`.
7. **on-request top-only** (Openapi paid tiers): condition `isTopCompany(lead) && ctx.onRequest === true`. `isTopCompany()` is a new predicate (revenue/employees threshold OR operator allowlist). Per-lead ceiling €0.13.
8. **confidence threshold / escalation**: a paid step in a field cascade fires only when the free step's `confidence < descriptor.stopConfidence` (existing field-runner behaviour). For role escalation (WEB_UNBLOCK after WEB_FETCH), the resolver only requests the paid step after `direct_fetch` returned `status:0/blocked` or empty html.
9. **circuit-breaker open**: handled entirely by the router (`breaker.allow(p.id)`); the resolver does nothing — a tripped provider is simply skipped, the next cascade step is tried.
10. **forbidden**: `google-maps-scrape`, `linkedin-scrape`, `facebook-instagram-scrape` are never registered; any role requesting them resolves to the official-API alternative or nothing.
11. **scope guards**: `meta_adlib` requires target country in EU/DSA scope; `2captcha` refuses official/government source contexts (`ctx.sourceClass !== 'official'`).

## 7. Wiring into existing subsystems

### 7.1 Router (extend, not rewrite)
- Add `roles: ProviderRole[]` to the base `Provider` interface (`types/providers.ts:42-49`) as an optional readonly field (back-compat: existing providers default to `[]` then are annotated).
- Add an optional `roleIndex` to `ProviderRouter` constructed from the three family arrays (`providers/provider_catalog.ts`). No method signature changes — the RoleResolver reads the index and calls existing `search/fetch/complete`.
- NEW `RouteOptions` additions are NOT needed; the resolver only fills existing fields (`includeProviderIds`, `excludeProviderIds`, `maxTier`, `paidEnabled`, `remainingLeadBudgetEur`, `runCostCeilingEur`, `meta`).

### 7.2 RoleResolver (new, the only orchestrator)
`src/providers/role_resolver.ts` exports `resolveRole(role, ctx)` returning `{ providerIds, routeOptions }` and convenience wrappers `searchForRole`, `fetchForRole`, `completeForRole` that delegate to the router. For non-router roles (`OFFICIAL_COMPANY_DATA`, `REVIEWS_REPUTATION`, `ADS_SIGNAL`, etc.) it returns the ordered eligible adapter list for the harvest/field layer to iterate.

### 7.3 Role registry (data module)
`src/providers/role_registry.ts` exports `ROLE_REGISTRY: RoleEntry[]` (the array in deliverable #2) + `cascadeForRole(role)`. This is the single source of truth; the resolver reads it.

### 7.4 Per-field cascade (`enrichment/fields/field_registry.ts`)
- The existing `EnrichmentStep[]` cascades ALREADY are role cascades for EMAIL_FIND, OFFICIAL_COMPANY_DATA, SOCIAL_DETECT, DECISION_MAKER. The wiring: replace the `disabled('email.finder_api', …)` / `disabled('decision_maker.people_finder', …)` placeholders with REAL steps that call `hunter`/`snov` via the new adapters, gated by `ctx.paidEnabled` + per-field `ceilingEur` (already enforced by `run_field_cascade.ts`). VAT/fatturato steps stay as-is (already wired free-first with entity-guard `isWrongEntity`).
- Add a `role` tag to each `EnrichmentFieldDescriptor` so the field cascade and the role registry stay consistent (cross-check test).

### 7.5 Judgment collectors + harvest adapters
- `collect_a.ts` / `collect_b.ts` already call `harvestSource(adapter, …)` and `ctx.search(...)`. The role mapping: `RegistrySourceAdapter`→OFFICIAL_COMPANY_DATA(A spine), `PlacesSourceAdapter`→REVIEWS_REPUTATION, `AdLibrarySourceAdapter`→ADS_SIGNAL, the press/awards searches→NEWS_AWARDS, `SocialSourceAdapter`→SOCIAL_DETECT.
- `places_adapter.ts` MUST migrate from the LEGACY endpoint (`maps.googleapis.com/maps/api/place/textsearch/json`, line 49) to the New Places API (`places.googleapis.com/v1/places:searchText` + `/places/{id}`) with mandatory `X-Goog-FieldMask` (NAP-only Essentials call separated from the Atmosphere call to control SKU cost). Response shape changes: `places[].displayName.text`, `rating`, `userRatingCount`, `businessStatus` (`CLOSED_PERMANENTLY` = A kill-flag).
- NEW harvest adapters `tender_adapter.ts` (TENDER_CONTRACTS) + `cert_adapter.ts` (CERTIFICATIONS) follow the `SourceAdapter` interface; add `'tender'` and `'certification'` to `SourceKind`.
- `runtime_context.ts:buildJudgeLLM` already builds the LLM_JUDGE via `router.complete`; extend the fallback chain order to anthropic→openrouter→openai per the LLM_JUDGE cascade.

### 7.6 CostLedger / breaker / rate-limiter
- No interface change. New adapters call `request()` and throw `ProviderBlockError` on 401/403/429 (Brightdata, Firecrawl, Hunter, Snov, OpenAI, DeepSeek, etc.) exactly like `serper.ts` so the breaker + ledger classify correctly.
- Add per-provider rate-limiter configs in `provider_catalog.ts` for the new paid providers per their published limits (Hunter 15 req/s; Tavily 100 RPM dev; OpenAI/Anthropic SDK auto-retry; 2captcha poll ≥5s). Add breaker tuning where blocks are common (brightdata, firecrawl strict default; oracle loose).

## 8. Cost-ceiling worked example (per-lead, paid run)
A hospitality lead, `--enable-paid`, per-lead ceiling €0.20:
1. SEARCH_WEB free (bing) €0 → finds site
2. WEB_FETCH direct_fetch €0 → body extraction (email+social free-gold)
3. OFFICIAL_COMPANY_DATA vies+fatturato €0
4. REVIEWS_REPUTATION google_places (Atmosphere) ≈ €0.037+0.023 = €0.060 (category-routed)
5. EMAIL_FIND falls to hunter only if body empty → €0.04 (within remaining €0.14)
6. LLM_JUDGE anthropic €0.02 (run-level ceiling permitting)
Total ≈ €0.12 < €0.20. Router drops any step that would breach the ceiling and fires `onRunCeilingHit` once.

## 9. Acceptance criteria (test-driven)
- AC1: `--enable-paid` absent ⇒ ledger total €0 across a full run (no tier-2 provider records). verify: ledger summary.
- AC2: every role in `ROLE_REGISTRY` has ≥1 tier-0/1 step OR is explicitly paid-only (`LLM_*`, `WEB_UNBLOCK`, etc.). verify: unit test.
- AC3: `resolveRole` output `providerIds` is a subset of registered providers for that role's family. verify: unit test.
- AC4: forbidden providers never appear in any registry/index. verify: unit test.
- AC5: category `italian_real_estate` excludes `ddg_lite`+`serper` from SEARCH_WEB. verify: policy test.
- AC6: Openapi paid tiers fire ONLY when `isTopCompany && onRequest`. verify: unit test.
- AC7: Places adapter calls the NEW endpoint with a FieldMask. verify: mocked-fetch test asserting URL + header.
- AC8: field-cascade `role` tag matches `ROLE_REGISTRY` entry for that field. verify: cross-check test.

---

# ADDENDUM v1.1 — revision decisions (resolving the adversarial critic)

*The design above is v1.0. The critic returned `needs_revision` with real catches. These are the
binding resolutions; where they conflict with v1.0, v1.1 wins.*

### R1 — close the cost-safety hole (HIGHEST). Family-agnostic gated execution.
The router's gates (paid-gate, per-lead budget, run-ceiling, circuit-breaker, ledger) live ONLY in
`router.filter()` and only cover `serp|http|llm`. The new roles (email/official/reviews/captcha/ads)
are NOT those families → they would bypass cost-safety. **Resolution:** add a single generic method
`ProviderRouter.invoke(meta, call, opts)` that runs the SAME gate pipeline (available → breaker.allow →
tier → paid-gate → per-lead budget → run-ceiling reserve → ledger.record → breaker.record) around ANY
provider call, regardless of family. Every paid non-router provider (hunter, snov, openapi paid tiers,
google_places, 2captcha) is invoked through `router.invoke` — so there is exactly ONE place where money
can be spent, for all families. `ProviderFamily` is widened to a string union incl. `email|official|
reviews|ads|captcha` for ledger tagging only (the three method-registries stay serp/http/llm).

### R2 — id collision. Distinct ids per (provider, role-family).
BrightData fills SERP + unlocker. One client, but TWO registered wrappers with DISTINCT ids
`brightdata_serp` and `brightdata_unlocker`, each its own breaker + rate-limiter key. Same rule for any
provider spanning two router families.

### R3 — `assertPaidSecrets` is data-driven. No hardcoded 4-provider list.
Build the paid-candidate list from a declared `PAID_PROVIDERS` table covering EVERY paid provider
(serper, exa, tavily, perplexity, brightdata, firecrawl, openai, openrouter, deepseek, zhipu, kimi,
anthropic, hunter, snov, google_places, openapi, 2captcha). Enabling ANY one (flag+key) satisfies the
assertion; enabling one with an empty key throws the actionable error. Closes the false-negative.

### R4 — PEC: honest free path. No fake free API.
There is NO reliable free INI-PEC-by-VAT API (INI-PEC has no open endpoint). `pec.inipec_by_vat` STAYS
disabled with that documented reason. PEC cascade = `pec.body` (free, website extraction) → `openapi`
IT-pec (paid €0.03, top-on-request). We do not pretend a free PEC lookup exists.

### R5 — broken-live migrations FIRST (P0, before net-new providers).
`places_adapter.ts` (legacy `maps.googleapis.com/.../textsearch/json`) and `ad_library_adapter.ts`
(`graph.facebook.com/v18.0`) are already deprecated/erroring. Migrate Places → New API
(`places.googleapis.com/v1`, `X-Goog-FieldMask`, Essentials vs Atmosphere SKU split) and AdLib → current
Graph version BEFORE adding new providers, else REVIEWS_REPUTATION + ADS_SIGNAL silently yield zero.

### R6 — low-confidence specs: de-risk.
- **Perplexity → LLM role only** (LLM_REASON/LLM_ANSWER), NOT SEARCH_WEB. Its `/search` returns a
  synthesized answer with citations, not clean ranked SERP rows (spec confidence 0.85). Re-classify.
- **Snov (0.72) deferred.** Hunter already covers EMAIL_FIND/VERIFY/B2B. Declare env + register a stub,
  but implement Hunter fully first; Snov adapter is a later opt-in (lowest value, riskiest OAuth+poll).
- **Zhipu GLM / Kimi / DeepSeek: paid-gated, conservative cost (> 0).** Do NOT mark GLM as an always-on
  free LLM. LLM_CHEAP therefore has NO always-free step: on a free-only run LLM_CHEAP returns null and
  callers MUST handle null (AC added). LLM is inherently paid.
- **Openapi free-tier (0.72): re-verify before relying.** Treat IT-search dryRun as paid-gated (not
  assumed free); keep the €0.13 per-lead ceiling but flag one-retry-blows-it; the activation layer
  (isTopCompany + on-request) stays pending.

### R7 — cost numbers: integration-spec is authoritative.
Reconcile field_registry placeholders to the spec costs (Hunter email-finder ~€0.04, verifier ~€0.02).
A single provider/role pair has ONE cost number across registry + field cascade.

### R8 — single-provider/no-free roles are acceptable but flagged.
REVIEWS_REPUTATION (google_places), EMAIL_VERIFY (hunter), B2B_CONTACT (paid only) have no free
fallback by nature. On a free-only run they yield nothing — documented, and no judgment axis may
HARD-depend on a paid-only signal (the §17 firewall already treats absence-of-paid-signal as `unknown`,
never as a negative).

### Implementation order (revised)
1. Foundation: `types/providers.ts` (ProviderRole + roles + widened family + CostedMeta), `env.ts`
   (all flags + data-driven `assertPaidSecrets`), `provider_router.ts` (`invoke`), `role_registry.ts`,
   `role_resolver.ts`. ← cost-safe core.
2. Adapters (new files, parallel-safe): llm/{openai,deepseek,zhipu_glm,kimi,perplexity}, http/{firecrawl,
   brightdata}, email/hunter, captcha/twocaptcha. (snov stub.)
3. Migrations P0: places New API, adlib version bump.
4. Wiring: provider_catalog (register + ids + rate/breaker), field_registry (hunter steps + role tags),
   judgment harvest/runtime_context.
5. Tests: free_run_zero_cost (AC1), role registry/resolver (AC2-4), policy routing (AC5), openapi gate
   (AC6), places New API (AC7), field-role cross-check (AC8).
