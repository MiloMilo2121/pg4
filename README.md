# pg4

pg4 is a Node 22 + TypeScript lead discovery and website-verification pipeline for technical B2B teams working on Italian SMB data.

## Why pg4

pg4 is the third generation of the PG Scraper workstream.

pg1 is kept as the legacy resolver reference. pg3 became the active runtime, but its April 2026 refactor notes show why a cleaner generation was needed: the production surface had BullMQ/Redis, crawler sidecars, monolithic orchestration, browser evasion concerns, and cost controls that were hard to reason about as one system. The pg3 benchmark logs also show operational symptoms: Redis degradation, Oracle sidecar failures, crt.sh 5xx/429 storms, SERP empty results treated as provider failures, and paid-provider pressure triggering stop-the-bleeding behavior.

pg4 keeps the useful lessons and removes the operational sprawl:

- One canonical `Lead` type and stable CSV/JSONL outputs.
- Explicit module boundaries for scrape, enrichment, providers, runtime, and IO.
- Free-first provider routing, paid providers default-denied by flag and API key.
- Structured Pino logs plus JSONL cost ledger instead of ad hoc stdout.
- Unit tests run offline by default; real-network smoke tests require `RUN_SMOKE=1`.

## Architecture

```text
input category/geography
        |
        v
  scrape command
  discovery/sources/*
  - PagineGialle parser/live source
  - Google Maps parser/live source
        |
        v
  raw Lead CSV + JSONL
        |
        v
  enrich command
  enrichment/stages/*
  - input website verification
  - PG detail backfill
  - hyper-guesser
  - SERP fallback
  - RDAP boost
        |
        v
  enriched CSV + JSONL + cost ledger
```

Module boundaries:

```text
src/cli/          command argument parsing and dispatch only
src/config/       Zod-validated env and defaults
src/types/        canonical Lead, provider, and output contracts
src/runtime/      logger, cost ledger, cache, checkpoint, locks, breakers
src/discovery/    scraper pipeline, parsers, dedupe, website evidence
src/enrichment/   stage orchestration and per-lead result policy
src/providers/    free/paid provider registry behind the router
src/io/           CSV and JSONL readers/writers
```

## Quick Start

```bash
git clone https://github.com/MiloMilo2121/PG-scraper.git
cd PG-scraper/pg4
pnpm install
cp .env.example .env
```

Run the offline example first. It uses a mock HTTP fixture, so it does not need API keys, browser access, or network access.

```bash
pnpm run enrich -- \
  --input examples/input_companies.csv \
  --out output/examples/enriched.csv \
  --mock-http examples/mock_http_pages.json
```

Expected result:

```text
[enrich] using offline mock HTTP fixture
[CostLedger] run summary total_calls=5 total_cost_eur=0
[enrich] done total=5 with_website=5 errors=0
```

The generated CSV should match the status/reason/website shape shown in `examples/expected_enriched.sample.csv`. Dynamic fields such as `duration_ms` are intentionally not exact.

## Commands

### scrape

Offline fixture mode, used for deterministic parser work:

```bash
pnpm run scrape -- \
  --fixture pg=tests/fixtures/scraper/pg_belluno_normal.html,maps=tests/fixtures/scraper/maps_feltre_feed.html \
  --category "agenzie immobiliari" \
  --out output/raw.csv
```

Example output from the checked-in fixtures:

```text
[scrape] fixture mode done fixtures=2 raw=8 out=output/raw.csv
```

Live mode uses Playwright Chromium and real PG/Maps pages:

```bash
pnpm run scrape -- --category "agenzie immobiliari" --province BL --out output/raw.csv
```

### enrich

Default mode verifies candidate websites from raw CSV input and writes enriched CSV, JSONL, and cost ledger files:

```bash
pnpm run enrich -- --input output/raw.csv --out output/enriched.csv
```

Offline mock mode:

```bash
pnpm run enrich -- \
  --input examples/input_companies.csv \
  --out output/examples/enriched.csv \
  --mock-http examples/mock_http_pages.json
```

Example output from the mock fixture:

```text
total=5 with_website=5 errors=0 total_cost_eur=0
```

### run

```bash
pnpm run run -- --category "agenzie immobiliari" --province BL --out output/campaign
```

Current status: this command is reserved for the end-to-end scrape -> enrich workflow and currently logs the intended campaign. Use `scrape` and `enrich` separately for production runs until it is wired.

### benchmark

```bash
pnpm run benchmark -- --input tests/fixtures/sample_companies.csv
```

Current status: code-level Phase 5 placeholder. The available pg3 evidence and pg4 measurement gaps are documented in `BENCHMARK.md`.

All commands expose usage:

```bash
pnpm run scrape -- --help
pnpm run enrich -- --help
pnpm run run -- --help
pnpm run benchmark -- --help
```

## Quality Gates

Default gates are offline and deterministic:

```bash
pnpm run typecheck
pnpm test
```

Smoke tests are intentionally gated because they touch real network/browser surfaces:

```bash
RUN_SMOKE=1 pnpm run test:smoke
```

Benchmark policy:

- pg3 comparison data comes from checked-in pg3 `benchmark_*.log` files.
- pg4 benchmark cells remain `TBD - to be measured` until a comparable real run exists.
- Never infer accuracy from a found-count alone; use `TBD` unless there is a validated truth set.

CI runs `pnpm install --frozen-lockfile`, `pnpm run typecheck`, and `pnpm test`. Smoke tests and secrets are excluded from CI.

## Project Layout

```text
repo root/
  .github/workflows/ci.yml      GitHub Actions unit gate for pg4

pg4/
  examples/                     offline CSV + mock HTTP example
  docs/                         audit notes and recalibration reports
  scripts/                      local audit/report helpers, not CI entrypoints
  src/
    browser/                    Playwright factory and consent handling
    cli/                        scrape, enrich, run, benchmark
    config/                     env schema and defaults
    discovery/                  scraping, parsing, dedupe, website evidence
    enrichment/                 enrichment stages and result policy
    io/                         CSV/JSONL IO
    providers/                  provider catalog and router
    runtime/                    logging, ledgers, circuit breakers, locks
    types/                      canonical data contracts
  tests/
    fixtures/                   saved parser fixtures and small CSVs
    smoke/                      RUN_SMOKE=1 live checks
    unit/                       offline unit coverage
```

## Roadmap

- Wire `run` into the existing scrape -> enrich components without changing the CLI contract.
- Produce a real pg4 benchmark on the same target class as the pg3 wave benchmark and update `BENCHMARK.md`.
