# pg4 — Architecture

> Current shape: a TypeScript scraping/enrichment core, a deliberately local
> dashboard adapter, and a durable recovery control plane. CI validates both
> the core and the independent `web/` application; browser/network smoke tests
> remain opt-in.

## Folder responsibilities

```
src/
  cli/          Thin entry points: parse argv, validate, dispatch. One file per
                command (scrape, enrich, run → `pnpm run pipeline`, judge,
                lookup, coverage, benchmark). User mistakes surface as one-line
                `UserError`s; unexpected failures keep their stack in the log.

  config/       Env (Zod-validated; `EnvConfigError` lists every bad variable)
                + runtime defaults. No magic numbers in modules.

  types/        Canonical shapes. ONE Lead type. Reason-code / discovery-method
                taxonomies as TS const objects so the compiler catches typos.

  runtime/      Cross-cutting infrastructure and operational safety:
                  logger            single pino logger (+ per-run JSONL file)
                  cost_ledger       per-call JSONL ledger, O(1) run/lead totals —
                                    the canonical cost source
                  circuit_breaker   per-provider closed/open/half-open
                  rate_limiter      per-provider token bucket
                  backpressure      concurrency throttle on error rate
                  retry             backoff for transient network failures
                  checkpoint        file-backed JSON, atomic write
                  run_context       per-run + per-lead containers
                  run_coverage      completion marker + recovery envelope
                  output_lock       one writer per output target
                  pool, shutdown    bounded concurrency, graceful SIGINT/SIGTERM
                  notifier, errors  operator notifications, error classes

  browser/      Playwright integration ONLY (factory, consent handling).
                No parsing, no domain logic.

  discovery/    Lead discovery. Pure where possible.
                  sources/          pure PG/Maps parsers, URL builders, live
                                    navigators, Italian geography
                  website/          URL classification and evidence gates:
                                    PreVerifyGate, semantic evidence, paid
                                    evidence gate, SERP dedupe, HyperGuesser,
                                    RDAP validator, content filter
                  deduper, input_normalizer, scrape_pipeline, resume_prior_run

  enrichment/   Per-lead pipeline.
                  enrichment_pipeline.ts   orchestrator: ingest gate, stage
                                           ordering, cost sync, finalize
                  stages/                  one stage per file: input website,
                                           PG detail, hyper-guesser, SERP, RDAP,
                                           financial, Perplexity resolve, Apify
                                           Maps / Registro / Bilanci
                  extract/, fields/,       on-page extraction (email, PEC, phone,
                  email/, financial/       socials, VAT), field cascades, email
                                           inference + MX/SMTP, official data
                  lead_score.ts            composite quality score

  providers/    ProviderRouter + adapters, one file each:
                  serp/   bing_html, ddg_lite (free) · serper, exa, tavily (paid)
                  http/   direct_fetch (free, SSRF-guarded) · firecrawl,
                          brightdata (paid render/unblock)
                  llm/    anthropic, openai-compatible, openrouter
                  apify/, openapi/, email/   actor runs, registry API, Hunter

  judgment/     Two-axis judgment layer (collectors, judges, critic, config).
  coverage/     Coverage gap map: industry × territory vs ISTAT universe.
  compliance/   GDPR suppression list and retention.
  persistence/  Tenant-scoped storage (in-memory + Postgres adapter).
  server/       Local dashboard API (loopback-only, no auth by design) and the
                MCP stdio server (path-sandboxed).
  api/          Framework-neutral, tenant-scoped control-plane contracts — the
                boundary a future authenticated API would implement.
  scripts/      Scripts wired into CI/ops: output validation, completion check,
                judgment eval, recovery agent.

tools/          Operator passes and research probes (typechecked, never shipped).
web/            Setaccio dashboard: independent Next.js project with its own
                lockfile and CI gate; talks only to the local API.

tests/
  unit/         ZERO network. Mocks/fixtures only.
  smoke/        Real network/browser, gated by RUN_SMOKE=1.
  fixtures/     Synthetic + anonymised real HTML, sample CSVs, RDAP JSON.
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
         pg_detail_stage       (the PG detail page's declared site)
         hyper_guesser_stage   (NER + DNS sweep + verify)
         serp_stage            (free providers, then gated paid pass)
         rdap_stage            (WHOIS rescue)
       free-gold extraction from the verified site (+ contact pages)
       official data + paid last-resort stages (opt-in, cost-capped)
       finalize: lead.cost_eur from CostLedger.costForLead(leadId)
  → io/output_manager: enriched CSV + JSONL
  → CostLedger.flushSummary(): structured summary line in <out>.cost-ledger.jsonl
```

### pipeline / benchmark
- `cli/run.ts` (`pnpm run pipeline`) — composes scrape → enrich end-to-end.
  It refuses to start enrichment until the scrape coverage manifest is complete.
- `cli/benchmark.ts` — fill-rate report over an enriched file (measured facts
  only; accuracy is never inferred from found-counts).

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

10. **One target owns one durable state bundle.** The output CSV path scopes
    its output lock, checkpoint, coverage manifest, completion marker,
    recovery envelope and persistent browser storage. Two campaign cells for
    the same category cannot share cookies or overwrite one another's resume
    state.

11. **Completion is explicit.** A CSV/JSONL is an artifact, not proof of a
    complete scrape. Only a valid `<target>.complete.json` with no failed query
    permits a campaign/watchdog to skip a cell.

12. **The dashboard adapter stays local.** `api_server.ts` has no auth and
    binds only to loopback. A future remotely reachable API must use the
    authenticated `src/api/` control-plane boundary and durable job storage;
    CORS alone is not access control.

## Historical live-validation evidence

These entries document observed canaries, not a claim that a deployment is
currently healthy. Consult a fresh manifest, diagnostics and run record before
using a result operationally.

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
