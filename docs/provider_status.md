# Provider status — pg4 definitive close

Single source of truth for every provider/source: role, status, cost, how to
enable. Status legend: ✅ working (real impl, tested) · 🔑 working, needs API key
+ enable flag · ⛔ not built (honest gap) · 🚫 forbidden (compliance).

## Free (no key, €0)

| Provider | Role | Status | Enable |
|---|---|---|---|
| direct_fetch | WEB_FETCH (tier 0) | ✅ always on | — |
| bing_html | SERP free | ✅ | default on (rate-limited 0.5/s) |
| ddg_lite | SERP free | ✅ | on, gated off for real-estate profile (low yield) |
| rdap | website confidence boost | ✅ | default on |
| free-gold body extraction | email/pec/social/vat from fetched body | ✅ | default on (€0) |
| **JSON-LD / Open Graph** | sameAs → all socials (incl. tiktok/youtube) + name/email/tel/vatID/founder/rating | ✅ **(WS-A)** | default on (€0); schema v3 |
| **email inference + MX/SMTP** | EMAIL_FIND | ✅ **(Fase 1a)** | `EMAIL_INFERENCE_MX_ENABLED=true` (Gate-A, default off) |
| VIES | VAT confirm | ✅ | `OFFICIAL_DATA_ENRICH_ENABLED=true` (+ VIES default on) |
| fatturatoitalia | revenue/employees by VAT | ✅ | `OFFICIAL_DATA_ENRICH_ENABLED=true` (+ FATTURATOITALIA default on) |

## Paid (real impl, need key + enable flag + `--enable-paid`)

| Provider | Role | Status | Enable |
|---|---|---|---|
| serper | SERP | 🔑 | `SERPER_ENABLED` + `SERPER_API_KEY` |
| tavily | SERP fallback | 🔑 | `TAVILY_ENABLED` + `TAVILY_API_KEY` |
| exa | SERP fallback | 🔑 | `EXA_ENABLED` + `EXA_API_KEY` |
| perplexity | SERP/LLM | 🔑 | `PERPLEXITY_ENABLED` + `PERPLEXITY_API_KEY` |
| firecrawl | WEB_UNBLOCK | 🔑 | `FIRECRAWL_ENABLED` + `FIRECRAWL_API_KEY` |
| brightdata | WEB_UNBLOCK / residential | 🔑 | `BRIGHTDATA_ENABLED` + `BRIGHTDATA_API_TOKEN` |
| hunter | EMAIL_FIND (paid alt to inference) | 🔑 | `HUNTER_ENABLED` + `HUNTER_API_KEY` |
| anthropic | JUDGE_LLM (default judge) | 🔑 | `ANTHROPIC_ENABLED` + `ANTHROPIC_API_KEY` |
| openrouter / openai / deepseek / zhipu / kimi | LLM_REASON/CHEAP | 🔑 | `*_ENABLED` + `*_API_KEY` |
| google_places | judgment A-axis (reviews/rating) | 🔑 | `GOOGLE_PLACES_ENABLED` + `GOOGLE_PLACES_API_KEY` |
| openapi (InfoCamere reseller) | registry firmographics + decision-maker + PEC | 🔑 | `OPENAPI_ENABLED` + `OPENAPI_API_KEY` (activation layer: docs/openapi_layer_rules.md) |
| **apify google-maps** | rating+reviews (A-axis) + website recall + phone + socials | 🔑 ✅ **(WS-D)** | `APIFY_ENABLED` + `APIFY_API_KEY` + `APIFY_MAPS_ENABLED` (GREEN business data; entity-guarded) |
| apify contact/facebook | email/phone/social from a page | 🔑 | `APIFY_CONTACT_ENABLED` / `APIFY_FACEBOOK_ENABLED` (YELLOW ToS) — provider built, stage = next increment |
| apify instagram/tiktok | follower/bio/contact | 🔑 ⚠️ | `APIFY_INSTAGRAM_ENABLED` / `APIFY_TIKTOK_ENABLED` (**RED ToS** — conscious opt-in) — provider built, stage = next increment |
| perplexity (entity-resolution) | website/social/VAT for hard leads, with citations | 🔑 | `PERPLEXITY_ENABLED`+key+`PERPLEXITY_RESOLVE_ENABLED` — **next increment** (LLM is wired) |

## Not built / deferred (honest gaps)

| Source | Why | Path |
|---|---|---|
| INI-PEC direct (PEC by VAT) | ⛔ official lookup is CAPTCHA-gated, no clean free API | free PEC = on-page body PEC (✅); full PEC-by-VAT via Openapi (paid) |
| ANAC/TED (gare) | ⛔ A-axis source, not wired | "cose in più" — `ANAC_TED_ENABLED` flag reserved |
| Accredia (certificazioni) | ⛔ A-axis source, not wired | "cose in più" — `ACCREDIA_ENABLED` flag reserved |
| email_pattern_guess (old) | replaced | superseded by email inference + MX (Fase 1a) |
| dns_mx, crtsh | removed (0/12,728 as discovery) | MX reused only as the email VERIFIER (Fase 1a), not discovery |

## Compliance gates

- **Email (Gate-A):** `EMAIL_INFERENCE_MX_ENABLED` off by default — an inferred email is personal data; go-live is the operator's documented choice. Suppressed emails are never synthesised (suppression.ts `matchesEmail`).
- **SMTP probe:** `EMAIL_SMTP_PROBE_ENABLED` separable — MX-only mode asserts nothing where port 25 is blocked.
- **Official data:** free public sources (VIES, fatturatoitalia) for own-use enrichment; redistribution license (Openapi/registry → resold to customers) is a SaaS-expansion concern, not required to close pg4.
- **Paid:** every paid provider is default-off + needs `--enable-paid` + a per-lead/run cost ceiling.
