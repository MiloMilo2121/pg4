# Legacy Failure Taxonomy — pg3 audit → pg4 guardrails

> **Purpose.** Before pg4 goes live, every recurring failure mode observed in pg3's CSV outputs and logs is converted into an explicit guardrail (regex, blocklist, circuit breaker, schema rule, or test). pg4 stays small precisely because it embeds these lessons rather than re-implementing the surrounding firefighting.

This document is generated from a real audit of:
- `pg3/output/campaigns/MASTER_WITH_WEBSITE.csv` (1700 rows)
- `pg3/output/campaigns/MASTER_NO_WEBSITE.csv` (2506 rows)
- `pg3/output/campaigns/ENRICHMENT_QUEUE.csv` (989 rows)
- `pg3/output/campaigns/EXPORT_CAMPAIGN_FULL_V2_20260505.csv` (660 rows)
- `pg3/logs/v8_*.log`, `pg3/logs/recovery_serper.log`, `pg3/logs/scheduler_*.log`
- `pg3/output/missions/italia_agenzie_immobiliari_*/`

---

## 1. Same business across multiple comuni — under-deduplicated

**Evidence.** In `MASTER_NO_WEBSITE.csv` (2506 rows): **493 pg_urls appear more than once, max count = 10**. Same agency was emitted up to 10 times, once per query (city/comune) it surfaced in.

**Root cause.** pg3's per-batch dedupe was scoped to a single (category, comune) query. A global cross-comune dedupe by stable identity (`pg_url`, `maps_url`, phone, registrable host) was either missing or run too late.

**pg4 guardrail.**
- `Deduplicator` already indexes by `pg_url`, `maps_url`, phone (digits, country prefix stripped), and `host`. Verified by tests in Phase 3.5.
- Lead carries `query_location` (where the search ran) **separately** from `business_city` (parsed from the card). Cross-comune duplicates collapse on stable identity even when query_locations differ.
- Test `cross-comune dedupe by pg_url collapses despite different query_location` enforces this regression.

---

## 2. "Website" field full of franchise portals, directories, and click-to-action URLs

**Evidence.** Out of 1700 rows in `MASTER_WITH_WEBSITE.csv`:
| dirty host substring | rows |
|---|---|
| immobiliare.it | 191 |
| tecnocasa.it | 103 |
| casa.it | 90 |
| retecasa.it | 18 |
| professionecasa.it | 4 |
| gabetti.it | 4 |
| centrocasa | 4 |
| intercasanet.it | 4 |
| facebook.com | 3 |
| stabilia | 3 |
| myhomegroup | 3 |
| wa.me | 2 |
| remax.it | 2 |
| idealista.it | 2 |
| primacasa | 1 |
| gruppocasa | 1 |
| instagram.com | 1 |
| soloaffitti.it | 1 |
| **total dirty** | **~432 (≈25%)** |

Out of 1700 records labeled "WITH_WEBSITE", ~one in four had a non-official website. These leak into enrichment, decision-maker discovery, and the eventual outreach list.

**Root cause.** The PG card's "website" link can be any of: the agency's own site, the franchise master portal (Tecnocasa/Gabetti/Re/Max/RetCasa), a listing directory (`immobiliare.it`/`casa.it`/`idealista.it`), a social profile, or the PG-generated WhatsApp click-to-chat. pg3 captured them all without distinguishing.

**pg4 guardrail.**
- `discovery/website/content_filter.ts` already blocks search engines + most directories from being treated as `official_website`.
- **Extended for Phase 3.7** with the franchise/click-to-action set documented above (`tecnocasa.it`, `gabetti.it`, `remax.it`, `professionecasa.it`, `retecasa.it`, `intercasanet.it`, `myhomegroup.it`, `gruppocasa*`, `centrocasa*`, `primacasa*`, `stabilia*`, etc.) plus `wa.me`/`whatsapp.com`/`m.me`.
- The PG parser already drops these from card-level `website` capture (Phase 3.6 fix). The pipeline-level enforcement guarantees that a SerpStage / HyperGuesser candidate from these hosts is never stored as `official_website` either.
- Test `dirty hosts never become official_website` enforces this regression at the pipeline level.

---

## 3. SERP_EMPTY_RESULT logged as ERROR thousands of times

**Evidence.** In a single `v8_*.log` run:
| pattern | count |
|---|---|
| `[CostRouter] Provider DNS-MX-MINING-0 failed: SERP_EMPTY_RESULT` | 3221 |
| `[CostRouter] Provider SERPER-API-1 failed: SERP_EMPTY_RESULT` | 3035 |
| `[CostRouter] Provider BING-HTML-1 failed: SERP_EMPTY_RESULT` | 2203 |
| `[CostRouter] Provider EXA-API-2 failed: SERP_EMPTY_RESULT` | 2135 |
| `[CostRouter] Provider DDG-LITE-1 failed: SERP_EMPTY_RESULT` | 2058 |
| `[CostRouter] Provider TAVILY-API-2 failed: SERP_EMPTY_RESULT` | 445 |

**Root cause.** Empty SERP result is a normal outcome (many small Italian agencies are not on the open web). pg3 logged it as `failed`, polluting log signal-to-noise.

**pg4 guardrail.** `ProviderRouter.search()` returns `{ provider: 'none', results: [] }` cleanly when no provider returns hits — empty is not an error, only thrown exceptions are. Already in Phase 3 code; documenting here so we don't regress.

---

## 4. CRT.sh / RDAP intermittent 5xx storms

**Evidence.** 89 entries of `CRTSH_ERROR: DB returned non-200 status. Status: 502/503` in a single run. Plus repeated `ENOTFOUND rdap.nic.it` storms when the registry was unreachable.

**Root cause.** crt.sh is famously flaky and rate-limits IPs aggressively; RDAP endpoints also fail-open on overload. pg3 retried each call individually, paying the round-trip cost every time.

**pg4 guardrail.** New `runtime/circuit_breaker.ts`:
- Per-provider state machine: `closed` → `open` after N consecutive failures within a window → `half_open` after a cooldown → `closed` on the next success.
- `ProviderRouter` consults the breaker before calling: an `open` provider is skipped exactly like an unavailable one.
- Default tuning: 5 failures within 60s → open for 120s.
- Configurable per provider in `provider_catalog.ts`.

---

## 5. ORACLE_DISABLED_BY_USER repeated forever

**Evidence.** When the operator disables the Python Oracle (Crawl4AI) endpoint, pg3 keeps escalating to it:
```
[ScraperClient] Step failed; escalating {"error":"ORACLE_DISABLED_BY_USER"}
[ScraperClient] Step failed; escalating {"error":"ORACLE_DISABLED_BY_USER"}
```
Same error logged hundreds of times in a single batch.

**Root cause.** pg3's escalation chain didn't honor an explicit "this provider is off" signal — only kept retrying.

**pg4 guardrail.** The provider feature-flag pattern (Phase 1) means `available()` returns false when the env var is unset or the flag is false; the router skips the provider once and never logs it as a failure. Documented under provider rules in `IMPLEMENTATION_NOTES.md` §4.

---

## 6. CLOUDFLARE_TURNSTILE on bing.com

**Evidence.** `[BlockClassifier] 🚫 CLOUDFLARE_TURNSTILE on bing.com via scraper_client` — repeated in tight loops in run logs.

**Root cause.** Bing's HTML SERP serves a captcha page when an IP looks bot-like. pg3 retried the same provider on the same IP, getting the same captcha repeatedly.

**pg4 guardrail.**
- `BingHtmlProvider.parse()` already detects captcha-class blocks (Phase 3) and returns `[]` instead of throwing — the router falls through to the next provider.
- The new circuit breaker (item 4) trips the Bing provider after N captcha hits, giving the IP time to cool off before the next attempt.

---

## 7. Maps `~120` cap is silent

**Evidence.** `pg3/src/scraper/providers/maps_grid_provider.ts` documents Maps as "max ~120 results per query"; pg3 logs the count but doesn't surface a cap signal. The orchestrator therefore can't know whether to drill deeper.

**Root cause.** Without a cap signal, dense queries (`agenzie immobiliari` in Milano) stop at 120 and silently lose coverage.

**pg4 guardrail.**
- `parseGoogleMapsResults` already returns `{ total_cards, dropped }`. Phase 3.7 adds a `cap_likely: boolean` field set when `total_cards >= 110`, mirroring the PG `overflow` flag.
- Current Phase 4 orchestrator surfaces the signal in logs / checkpoint
  (`maps_cap_likely_count`, `pg_overflow_count`) but does **not** split
  automatically yet. This is deliberate pending live evidence: PD's
  checkpoint later proved dense PG queries can have `overflow=true` on
  every curated comune. Auto-split is therefore still an active followup,
  not a closed guardrail.

---

## 8. Off-category Maps results silently included

**Evidence.** Maps' search is fuzzy — `"agenzie immobiliari Belluno"` returns `bar`, `parrucchiere`, `pizzeria` if they're prominent in the area. pg3 stored them all with `source=Maps` and the requested category attached as a label, polluting downstream filtering.

**Root cause.** No category-shape sanity check on Maps cards.

**pg4 guardrail.** Lead carries an optional `category_match` field:
- `confirmed` — Maps card's own type span matches one of the expected category tokens (`agenzia`, `immobiliare`, `agente immobiliare`, …).
- `unknown` — type span absent or empty.
- `mismatch` — type span present but doesn't share a token with the requested category. Record is kept (zero silent drops) but flagged with `reason_code=CATEGORY_MISMATCH` so downstream stages can deprioritize.

The category-token list per requested category lives in `discovery/sources/category_match.ts`, fed by the requested category string.

---

## 9. Same business with two different sources collapsed under just one

**Evidence.** `MASTER_NO_WEBSITE.csv` reports rows with `source = "PG + Maps"` (27 of them), proving PG and Maps records were merged but the source provenance string is lossy and inconsistent.

**Root cause.** pg3's deduper concatenated source strings without a stable schema.

**pg4 guardrail.** `Lead.sources?: string[]` (an array, not a delimited string). The deduper merges incoming records by appending to the array, deduped. CSV serialization joins with `+` for human-readability, but the JSONL keeps the structured array.

---

## 10. CSV schema variants across pg3 generations

**Evidence.** Six pg3 CSVs in `output/campaigns/` carry three different column orders:
- "raw + scoring" schema — `MASTER_WITH_WEBSITE.csv`, `MASTER_NO_WEBSITE.csv`, `ENRICHMENT_QUEUE.csv`, `TEST_ENRICHMENT_5.csv` — has `geriko_tier`, `score_total`, `score_negatives`.
- "export-ready" schema — `EXPORT_CAMPAIGN_FULL_V2_20260505.csv`, `MASTER_ENRICHED_V8_ACTIVE.csv` — has `dm_*`, `email_type`, `contact_source`, drops scoring.
- "test enrichment" schema — `TEST_ENRICHMENT_5.csv` — extends raw with `email`, `pec`, `dm_name`, `dm_role`, `employees`.

**Root cause.** Schema drifted across versions; readers in pg3 each tolerated a subset.

**pg4 guardrail.** New `io/legacy_csv_mapper.ts` accepts any pg3 CSV and produces canonical `Lead` objects:
- `company_name | name | ragione_sociale` → `company_name`
- `vat_code | vat | piva | partita_iva` → `vat_code`
- `dm_name | decision_maker_name` → `decision_maker_name`
- `dm_role | decision_maker_role` → `decision_maker_role`
- `dm_linkedin | decision_maker_linkedin` → `decision_maker_linkedin`
- `email_type` → kept as-is (canonical)
- Unknown columns preserved on the catch-all `[extra]` index.
- `geriko_tier`/`score_*` (pg3-specific) preserved as `legacy_*` namespaced fields and ignored by the canonical pipeline.

---

## 11. Email / decision-maker pollution by directories and PDFs

**Evidence.** `MASTER_ENRICHED_V8_ACTIVE.csv` and `EXPORT_CAMPAIGN_FULL_V2_20260505.csv` contain DM names and emails that are clearly from privacy boilerplate / PDF text / generic-mailbox capture. Specific examples redacted; pattern is consistent.

**Root cause.** Phase 5+ enrichment in pg3 trusted any email regex match on any HTML/PDF page surface; DM names were extracted from job-board snippets and compliance pages.

**pg4 guardrail.** Out of scope for Phase 3.7 (this is enrichment territory, not discovery), but logged here as a pre-condition for Phase 5+:
- Email blocklist: generic mailboxes (`info@`, `privacy@`, `dpo@`, `noreply@`, `webmaster@`).
- Email source must be pinned to a verified `official_website` host or its `email_domain` derivative; never accepted from a directory page.
- DM names must come with a role token + LinkedIn URL or a sponsoring page on the official site; never from a job-board search snippet alone.

These will be enforced in `enrichment/contact_enricher.ts` (Phase 5).

---

## Summary — guardrails landed in Phase 3.7 code

| # | Guardrail | Where |
|---|---|---|
| 1 | Cross-comune dedupe; `query_location` ≠ `business_city` | `types/lead.ts`, `discovery/deduper.ts`, `discovery/sources/*` |
| 2 | Franchise + click-to-action blocklist for `official_website` | `discovery/website/content_filter.ts` |
| 3 | SERP_EMPTY is a clean miss, not a logged error | already correct (Phase 3) |
| 4 | crt.sh / RDAP / Bing circuit breaker | `runtime/circuit_breaker.ts`, wired into `providers/provider_router.ts` |
| 5 | Disabled-by-flag providers silently skipped | already correct (Phase 1 feature-flags) |
| 6 | Bing Cloudflare-Turnstile cooldown | uses circuit breaker |
| 7 | Maps `~120` cap signal | `discovery/sources/google_maps_parser.ts` returns `cap_likely` |
| 8 | Off-category Maps marker | `discovery/sources/category_match.ts` + `Lead.category_match` |
| 9 | Multi-source provenance as array | `Lead.sources?: string[]` |
| 10 | Legacy CSV schema mapper | `io/legacy_csv_mapper.ts` |
| 11 | Email/DM pollution | DEFERRED to Phase 5 |

Each guardrail has at least one test in `tests/unit/` that fails if the regression returns.
