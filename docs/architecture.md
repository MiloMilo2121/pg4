# pg4 — Architecture

> Status as of Phase 4.4 (structure cleanup). 256 unit tests, 1 placeholder, 0 network in CI. Phase 4.3 PG live canary on Belluno **passed** (47 unique leads, checkpoint resumes correctly, no captcha loops).

## Folder responsibilities

```
src/
  cli/             Thin entry points — parse argv, validate, dispatch to a pipeline.
                   No orchestration logic here. One file per command.

  config/          Env (zod-validated) + runtime defaults. No magic numbers in modules.

  types/           Canonical shapes. ONE Lead type. Reason-code / discovery-method
                   taxonomies as TS const objects so the compiler catches typos.

  runtime/         Cross-cutting infrastructure — the parts that don't know about
                   PG vs Maps vs anything domain-specific:
                     logger        single pino logger
                     cost_ledger   in-memory + JSONL append per call (canonical
                                   per-lead cost source)
                     circuit_breaker per-key state machine (closed/open/half_open)
                     backpressure  concurrency throttle on error rate
                     cache         L1 in-memory; Redis adapter slot reserved
                     run_context   per-run + per-lead containers; tierCapForLead()
                     rate_limiter  per-key token bucket
                     checkpoint    file-backed JSON, atomic write
                     errors        thrown-error → reason_code classifier

  browser/         Playwright integration ONLY. No parsing, no domain logic.
                     factory          single-page IT-locale session, proactive restart
                     consent_handler  per-domain (pg/maps/generic) trial-and-click
                                      with in-process counters (no log spam)

  discovery/       Lead-discovery domain logic. Pure where possible.
                     input_normalizer        Italian-aware normalization
                     deduper                 multi-key (phone / name+city /
                                             name+address / pg_url / maps_url / host)
                     resume_prior_run        rehydrate from JSONL on resume;
                                             hard-stops if checkpoint says done
                                             but JSONL is missing
                     scrape_pipeline         fixture mode + live mode orchestration
                                             (lazy-loaded Playwright import)
                     text_cleanup            conservative mojibake strip
                     sources/                pure parsers + URL builders + live
                                             navigators + italy_geo + category_match
                     website/                URL classification, PreVerifyGate,
                                             SerpDeduplicator, HyperGuesser,
                                             RDAPValidator, content_filter

  enrichment/      Per-lead enrichment pipeline.
                     enrichment_pipeline.ts  small orchestrator: ingest gate,
                                             stage ordering, cost sync, finalize.
                     stages/                 one Stage per file:
                                               input_website_stage
                                               hyper_guesser_stage
                                               serp_stage
                                               rdap_stage
                                               verify_candidates  (shared helper)

  providers/       Cost-tiered router + adapters.
                     provider_router.ts      family-aware (serp/http/llm),
                                             empty SERP is NOT a failure,
                                             ProviderBlockError → kind:'blocked'
                     provider_catalog.ts     boot-time registry build with
                                             feature-flag gating
                     serp/                   dns_mx, crtsh, ddg_lite, bing_html
                     http/                   direct_fetch
                     llm/                    (none yet — Phase 5+)

  io/              CSV reader, CSV writer, JSONL reader/writer, output_manager.
                   Schemas (RAW_CSV_COLUMNS, ENRICHED_CSV_COLUMNS) live in types/lead.

tests/
  fixtures/        Synthetic + real HTML, sample CSVs, RDAP JSON, baseline files.
  unit/            ZERO network. Mocks/fixtures only. Run on every typecheck.
  smoke/           Network-touching, gated by RUN_SMOKE=1. Skipped in CI default.
```

## Command flow

### scrape
```
CLI argv → cli/scrape.ts
  → discovery/scrape_pipeline.ts
       fixture mode:  read HTML → parsers → dedupe → CSV+JSONL
       live mode:     Playwright BrowserFactory + consent_handler
                      → for each comune: pg_live OR maps_live
                          → pure parsers (no browser logic inside)
                          → checkpoint per (provider, category, location, page)
                      → global dedupe across comuni
                      → CSV+JSONL+checkpoint
                      ↑ on resume: rehydrateFromPriorRun reloads JSONL into
                                   the deduper BEFORE iterating comuni
```

### enrich
```
CLI argv → cli/enrich.ts
  → io/csv_reader: stream raw rows
  → for each lead, runEnrichmentPipeline:
       ingest gate (INPUT_QUALITY_TOO_LOW / ERROR_INVALID_INPUT_ROW)
       normalize
       discovery ladder (stages run in order; first success breaks):
         input_website_stage
         hyper_guesser_stage   (NER + DNS sweep + verify)
         serp_stage            (free providers + SerpDeduplicator + verify)
         rdap_stage            (WHOIS rescue)
       finalize: lead.cost_eur from CostLedger.costForLead(leadId)
  → io/output_manager: enriched CSV + JSONL
  → CostLedger.flushSummary(): structured summary line in <out>.cost-ledger.jsonl
```

### run / benchmark (Phase 5+)
- `cli/run.ts` — composes scrape → enrich end-to-end. Stub today.
- `cli/benchmark.ts` — pg4 vs pg3 on the same fixture set. Stub today.

## Invariants

1. **Parsers are pure.** `pagine_gialle_parser.ts` and `google_maps_parser.ts`
   take HTML in and return parsed leads out. No network, no browser, no
   navigation logic. Test surface: pure functions + saved HTML fixtures
   (synthetic + real).

2. **Browser is a navigation shell only.** Selectors-+-DOM-extraction live
   in `discovery/sources/{pg_live,maps_live}.ts`; the actual parsing is
   delegated to the pure parser. Browser code never touches lead schema.

3. **CostLedger is the source of truth for cost.** Every router call
   (`.search`/`.fetch`/`.complete`) tags its ledger entry with
   `meta.lead_id`. After every enrichment stage AND at finalize,
   `perLead.costEur = run.ledger.costForLead(leadId)`. Stages don't
   have to remember to populate `StageOutcome.cost_eur`. The final
   `lead.cost_eur` in CSV is what was actually billable.

4. **No silent drops.**
   - Enrichment: every input row → output row with `status` + `reason_code`.
   - Scrape: every parsed card flows through dedupe; nothing dropped
     without being logged or counted.
   - Resume: a checkpoint that says "done" + a missing JSONL is a
     **HARD STOP**, not a warning. Operator must pass `--fresh` or
     `--allow-missing-jsonl`.

5. **Free-first routing.** Default `maxTier: 1` for SERP. Paid providers
   require both a feature flag AND an API key, otherwise silently
   dropped from the registry at boot.

6. **Empty SERP is NOT a failure.** `kind: 'empty'` in the ledger; does
   NOT trip the circuit breaker. Block pages throw `ProviderBlockError`
   and DO trip the breaker.

7. **Per-lead cost ceiling.** `tierCapForLead(perLead)` reads
   `perLead.costEur` (which is now ledger-sourced) and forces
   `maxTier: 1` once the ceiling is hit.

8. **Output schemas are stable.** `RAW_CSV_COLUMNS` and
   `ENRICHED_CSV_COLUMNS` are append-only; reordering existing columns
   is a breaking change.

9. **No mojibake in canonical fields.** The `text_cleanup` helper
   conservatively strips U+FFFD replacement runs from `company_name`,
   `city`, `business_city`, `address` at the parser boundary. Apostrophes
   and Italian accented letters pass through unchanged.

## Current live rollout state

| Step | State |
|---|---|
| 1 — PG live canary on Belluno (1 comune, 2 pages) | ✅ passed: 47 unique leads, resume verified |
| 2 — 3 comuni BL (Belluno + Feltre + Sedico) | ✅ passed: 116 unique leads, resume verified |
| 3 — Province BL PG-only | ✅ passed: 194 unique leads, 0 overflow |
| 4 — Dense province PG-only (PD) | ✅ ran: 437 unique leads from 900 cards; every checkpoint entry had `overflow=true` |
| 5 — Auto-split PG `overflow=true` / Maps `cap_likely=true` | pending; now proven necessary for dense provinces |
| 6 — Maps live opt-in, after Cloudflare/consent hardening | pending |
| 7 — Paid providers (Serper first) | ✅ R7 passed on PD: 137 found websites, €0.199 spend, 96.2% audited precision on the paid gain set; Serper remains explicit opt-in via `--enable-paid` + run cap |

### Why pg4 stays small

pg3 grew because every new failure mode added a new class. pg4 trades that
for a small set of explicit invariants (above) and one boundary per
concern. Adding a new provider = one file in `providers/<family>/`. Adding
a new enrichment stage = one file in `enrichment/stages/`. Adding a new
scrape source = one file in `discovery/sources/` plus a parser fixture.

When in doubt, check the invariant list before adding a new module.
