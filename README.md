# pg4

**Lead discovery and enrichment engine for Italian SMBs. It prefers free sources, puts a hard ceiling on every euro spent, and is heavily tested.**

[![CI](https://github.com/MiloMilo2121/pg4/actions/workflows/ci.yml/badge.svg)](https://github.com/MiloMilo2121/pg4/actions/workflows/ci.yml)
![Node 22](https://img.shields.io/badge/node-22-339933?logo=node.js&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/unit%20tests-1.2k%2B-brightgreen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Give pg4 a business category and a territory (*"real-estate agencies in the province of Padua"*). It scrapes every matching company from PagineGialle and Google Maps, then works out each company's **official website**, backed by evidence. From that site and from official registries it fills in email, PEC, phone, VAT number, revenue, headcount and social profiles. Every field records its source, every row records a status and a reason, and every euro spent is logged in a ledger.

![Setaccio dashboard: cockpit](docs/assets/dashboard-cockpit.png)

<sub>The *Setaccio* dashboard (Next.js, Italian UI), running on the synthetic demo dataset (`pnpm demo`). Cockpit, companies and enrichment read live from the local API; some panels (market trends, national map, credits) still show the design prototype's illustrative figures and are labelled *dati di esempio*.</sub>

---

## What it does

| Stage | How |
|---|---|
| **Discover** | Playwright drives PagineGialle and Google Maps page by page. The parsers are pure functions over saved HTML. Runs are checkpointed and resumable per `(provider, category, comune, page)`. Results are de-duplicated across comuni by `pg_url`, `maps_url`, phone and host. |
| **Verify the website** | A ladder of stages: the input website, then the PG detail page, then domain guessing (NER + DNS), then SERP, then RDAP rescue. A candidate site is accepted only when the page itself proves it belongs to the company: a matching VAT or phone number, or semantic evidence that clears strict gates. |
| **Enrich** | Extracts email, PEC, phone, socials and VAT from the site and its contact pages. Official data comes from VIES, business-register sources and public financial summaries (revenue, employees). Candidate emails are inferred and checked with MX/SMTP. |
| **Judge** | An optional two-axis judgment layer: **A** is business potential, **B** is the quality of the company's digital presence. High A with low B marks a "silent gem": a strong company that is under-represented online. |
| **Operate** | A CLI, a local dashboard, an MCP server so AI agents can drive the pipeline, a watchdog for overnight campaigns, and a recovery loop that opens fix PRs when a scraper breaks. |

## Engineering highlights

- **Money cannot leak.** All paid calls go through one `ProviderRouter`.
  - Paid providers are denied by default. They need a feature flag, an API key **and** an explicit `--enable-paid`.
  - Before every paid attempt, the router checks a per-lead cap re-read live from the `CostLedger`, plus an atomic run-level reservation.
  - A failed call is recorded at its real cost (for example, an Apify run that was started and billed), never silently as €0.
  - Incident that shaped this: a €0.10 run cap once reached €0.229 before anyone noticed. Tests now lock that entire class of bug.
- **Precision before recall.** A website is never "found" because a search engine ranked it first.
  - Directory portals, franchise flagships, parked domains and WhatsApp/click-to-call links are filtered out, following a taxonomy of every false positive pg3 produced ([`docs/legacy_failure_taxonomy.md`](docs/legacy_failure_taxonomy.md)).
  - The paid-SERP pass was audited at **96.2% precision** on the websites it added.
- **Nothing is dropped silently.**
  - Every input row produces an output row with a `status` and a `reason_code`.
  - A checkpoint that says "done" while its JSONL is missing is a hard stop.
  - Only an explicit completion manifest lets a campaign cell count as finished.
- **Built to survive a laptop.** On the first real campaigns, 99% of scraper failures were network drops, not anti-bot blocks. The answers are:
  - retry with backoff, circuit breakers and per-provider rate limits;
  - a PID-reuse-safe watchdog that relaunches dead campaigns;
  - a recovery agent that turns a broken cell into a pull request, with the merge to `main` held behind a protected environment.
- **Safe on untrusted input.** URLs and mail hosts come from scraped data, so every fetch and SMTP dial is checked at connect time and can never reach `localhost`, private networks or the cloud-metadata endpoint, redirects included. Bodies are size-capped.
- **Safe to hand to an agent.** The MCP server sandboxes every path an agent sends. Outputs must stay under `output/`, and traversal, symlink escapes and dotfiles are rejected.
- **Strict gates.**
  - TypeScript `strict`, with `noUnusedLocals`/`noUnusedParameters` on.
  - Zero `any`.
  - Type-aware lint for floating and misused promises.
  - 1.2k+ offline unit tests.
  - A production dependency audit in CI for both the engine and the dashboard.

## Architecture

```mermaid
flowchart LR
  Q["category × territory"] --> S["scrape<br/>PagineGialle + Google Maps<br/>(Playwright, checkpointed)"]
  S --> R[("raw leads<br/>CSV + JSONL")]
  R --> E["enrich<br/>per-lead stage ladder"]
  E <--> P["ProviderRouter<br/>free-first · breakers · rate limits<br/>paid gate · live cost caps"]
  P --> L[("CostLedger<br/>JSONL, per lead")]
  E --> O[("enriched leads<br/>CSV + JSONL")]
  O --> J["judgment layer<br/>(A × B gap)"]
  O --> D["Setaccio dashboard"]
  O --> M["MCP server"]
```

```text
src/
  cli/          thin entry points: scrape, enrich, run, judge, lookup, coverage, benchmark
  discovery/    pure PG/Maps parsers, live navigators, dedupe, website evidence gates
  enrichment/   stage ladder, field cascades, extraction, email inference, lead score
  providers/    router + adapters (SERP, HTTP, LLM, Apify, OpenAPI, email)
  runtime/      cost ledger, circuit breaker, rate limiter, checkpoint, locks, shutdown
  judgment/     two-axis judgment layer (collectors, judges, critic, config)
  compliance/   GDPR suppression list
  server/       local dashboard API + MCP stdio server
  types/        the one canonical Lead type and output schemas (append-only)
web/            Setaccio dashboard (Next.js 15, own lockfile and CI gate)
tools/          operator passes and research probes (typechecked, not shipped)
```

More in [`docs/architecture.md`](docs/architecture.md) (invariants and command flow) and [`docs/provider_cascade_architecture.md`](docs/provider_cascade_architecture.md).

## Quick start

Requires Node 22 and pnpm.

```bash
git clone https://github.com/MiloMilo2121/pg4.git && cd pg4
pnpm install && pnpm --dir web install
cp .env.example .env
```

**1. Enrich offline.** No keys, no network, no browser:

```bash
pnpm enrich --input examples/input_companies.csv \
  --out output/examples/enriched.csv \
  --mock-http examples/mock_http_pages.json
# → [enrich] done  total=5 with_website=5 errors=0 · cost €0
```

**2. Open the dashboard on synthetic data:**

```bash
pnpm demo        # API on :8787 + dashboard on :3000, 427 fictional companies
```

**3. Scrape for real** (Playwright Chromium, live pages):

```bash
pnpm scrape --category "agenzie immobiliari" --province BL --out output/raw.csv
pnpm enrich --input output/raw.csv --out output/enriched.csv          # free-only by default
pnpm run pipeline --category "agenzie immobiliari" --province BL --out output/campaign
```

| Command | What it does |
|---|---|
| `pnpm scrape` | Discovery from PG/Maps (live or `--fixture` HTML), resumable |
| `pnpm enrich` | Website verification + enrichment; `--enable-paid --run-cost-ceiling-eur <€>` to allow paid providers |
| `pnpm run pipeline` | Scrape → enrich under one run id; refuses to enrich an incomplete scrape |
| `pnpm judge` | Two-axis judgment over an enriched CSV |
| `pnpm lookup` | Find a lead already in `output/` by VAT or phone |
| `pnpm coverage` | Coverage gap map: industry × territory against ISTAT counts |
| `pnpm mcp` | MCP stdio server exposing the pipeline to agents |

Every command accepts `--help`.

<details>
<summary>More screenshots</summary>

![Companies archive](docs/assets/dashboard-aziende.png)
![Coverage map](docs/assets/dashboard-italia.png)

</details>

## Quality gates

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
RUN_SMOKE=1 pnpm test:smoke    # opt-in: touches real network/browser
```

CI runs two independent jobs on every PR:
- **core**: frozen install, typecheck, unit tests, lint, build and production dependency audit;
- **dashboard**: typecheck, lint, `next build` and audit.

## Why pg4 exists

pg4 is the third generation of the same project, and the earlier ones are the reason it looks the way it does.

- **pg1** was the first resolver. It is kept only as a reference for the lessons it taught.
- **pg3** became the production runtime and then collapsed under its own operational weight. It had BullMQ/Redis, crawler sidecars, monolithic orchestration and cost controls nobody could reason about as a single system. Its logs show the symptoms: Redis degradation, sidecar crashes, crt.sh 5xx storms, empty search results counted as provider failures, and paid providers left to burn money until someone killed the process.
- **pg4** started as a clean export and a deliberately small core. Every failure mode pg3 had was audited from its real outputs and turned into an explicit guardrail with a test. Examples: the same agency emitted 10 times across comuni, and 191 "websites" that were really immobiliare.it listings. The result is a short list of invariants and one boundary per concern. Adding a provider is one file; adding a stage is one file.

## Responsible use

This is a portfolio project. It collects **publicly listed business information**; that data is personal data under the GDPR only when it identifies a natural person (for example, a sole trader).

- The repository contains **no scraped data**. Test fixtures are anonymised and the demo dataset is fictional (`*.example` domains, `999…` VAT numbers).
- Scraping third-party sites may conflict with their terms of service. Check the terms and your legal basis before running live scrapes.
- There is a GDPR toolkit in [`docs/gdpr/`](docs/gdpr/): a legitimate-interest assessment template, an Art. 14 notice and a pre-production checklist. A suppression list is enforced by the pipeline.
- Paid providers are off unless you explicitly turn them on.

## License

[MIT](LICENSE) © Marco Milanello
