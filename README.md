# pg4

**Lead discovery and enrichment engine for Italian SMBs. It prefers free sources, puts a hard ceiling on every euro spent, and is heavily tested.**

[![CI](https://github.com/MiloMilo2121/pg4/actions/workflows/ci.yml/badge.svg)](https://github.com/MiloMilo2121/pg4/actions/workflows/ci.yml)
![Node 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/unit%20tests-1.2k%2B-brightgreen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Give pg4 a business category and a territory (*"real-estate agencies in the province of Padua"*). It scrapes every matching company from PagineGialle and Google Maps, then works out each company's **official website**, backed by evidence. From that site and from official registries it fills in email, PEC, phone, VAT number, revenue, headcount and social profiles. Every field records its source, every row records a status and a reason, and every euro spent is logged in a ledger.

![Setaccio dashboard: cockpit](docs/assets/dashboard-cockpit.png)

<sub>The *Setaccio* dashboard (Next.js, Italian UI), running on the synthetic demo dataset (`pnpm demo`): 480 fictional B2B SaaS and deeptech companies in the northern Italian tech hubs. Cockpit, companies, enrichment and the coverage map (nation, Veneto, province of Padova) read live from the local API; some panels (market trends, credits, provider table) still show the design prototype's illustrative figures and are labelled *dati di esempio*. Built on the author's design system ("Grafite", app variant): graphite on paper, square panels, Archivo + DM Mono, one line-icon set.</sub>

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
- **A dashboard you can drive from the keyboard.** ⌘K finds any view, action, market or company (name, city or VAT); `g` + a letter jumps between views; `/` searches the archive. Overlays are real dialogs (focus trap, Escape, focus return), the map is operable without a mouse, and a Playwright + axe suite checks every view and overlay at 1440px and 360px.

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
web/            Setaccio dashboard (Next.js 16, own lockfile and CI gate)
tools/          operator passes and research probes (typechecked, not shipped)
```

More in [`docs/architecture.md`](docs/architecture.md) (invariants and command flow) and [`docs/provider_cascade_architecture.md`](docs/provider_cascade_architecture.md).

## How it decides

Every diamond below is a decision the code actually takes, traced from the source. Colours: **green** verified / target, **red** dropped / blocked, **amber** partial / borderline, **purple** cost, privacy and safety gates.

- [Overview](#overview)
- [Discovery](#discovery)
- [Enrichment](#enrichment)
- [Is this website really the company's?](#is-this-website-really-the-companys)
- [Judgment](#judgment)
- [Operations](#operations)
- [Known gaps](#known-gaps)

### Overview

```mermaid
flowchart LR
  subgraph IN["Entry points"]
    CLI["CLI<br/>scrape · enrich · pipeline · judge"]
    DASH["Setaccio dashboard<br/>map a market · enrich · judge"]
    MCP["MCP server<br/>AI agents: pg4_run, pg4_judge…"]
    CAMP["campaign.sh + watchdog<br/>overnight campaigns"]
  end
  IN --> S1["① Discovery<br/>PagineGialle + Google Maps"]
  S1 --> G1{"Scrape complete?<br/>0 failed queries"}
  G1 -- "no, partial" --> P1["CLI: no enrich, exit 1 → recovery<br/>Dashboard: ingests the rows it has anyway"]
  G1 -- "yes" --> S2["② Website verification<br/>five-rung ladder"]
  S2 --> S3["③ Enrichment<br/>contacts · VAT · official data"]
  S3 --> OUT["Output<br/>CSV / JSONL · dashboard · export"]
  S3 --> S4["④ Judgment, optional<br/>potential A × digital presence B"]
  S4 --> OUT
  SUP[["GDPR suppression list<br/>applied in discovery, enrichment and judgment"]]
  PAID[["Paid gate<br/>off by default · € caps per lead and per run"]]
  SUP -.-> S1
  SUP -.-> S3
  SUP -.-> S4
  PAID -.-> S2
  PAID -.-> S3
  PAID -.-> S4
  classDef ok fill:#e2eedf,stroke:#4f7a4a,color:#1f3a1c
  classDef warn fill:#f6ead0,stroke:#b07d2a,color:#4a3510
  classDef gate fill:#efe4f3,stroke:#7a4f8f,color:#2e1a38
  class OUT ok
  class P1 warn
  class SUP,PAID gate
```

The dashboard runs the same `pipeline` command as the CLI, one process per category × province, always on free sources only. Depth **Rapido** scrapes the province capital, one page (30–120 s); **Completo** and **Esteso** run the whole province. While a run is going, its rows are ingested every 2 seconds, so the dashboard counts grow live.

### Discovery

```mermaid
flowchart TD
  A["Request: category + province or comuni"] --> B{"--comuni given?"}
  B -- "yes" --> C["Use those comuni"]
  B -- "no" --> D{"Province in the curated list?<br/>12 provinces, e.g. PD = 12 comuni"}
  D -- "yes" --> E["The province's curated comuni"]
  D -- "no" --> F["The code itself as one location"]
  C --> G
  E --> G
  F --> G
  G{"--fresh?"} -- "yes" --> H["Delete outputs and checkpoint"]
  G -- "no" --> I{"Checkpoint exists?"}
  I -- "yes, with JSONL" --> J["Resume: prior rows go back<br/>into the deduplicator"]
  I -- "yes, JSONL lost but CSV present" --> K["MissingPriorJsonl error<br/>unless --allow-missing-jsonl"]
  I -- "no, or orphaned" --> L["Cold start"]
  H --> P
  J --> P
  L --> P
  P{"Selector preflight<br/>test query"}
  P -- "PG: 0 cards or error" --> PX["PreflightError → exit 3"]
  P -- "Maps down" --> PM["PG only; coverage will be partial"]
  P -- "ok" --> Q
  PM --> Q
  Q{"For each comune, each PG page:<br/>already closed in the checkpoint?"}
  Q -- "yes" --> QS["Skip the page"]
  Q -- "no" --> N["Navigate: 3 retries with backoff<br/>network errors only · cookie consent on page 1"]
  N --> N1{"Retries exhausted?"}
  N1 -- "yes" --> NF["Page failed → next page"]
  N1 -- "no" --> N2{"Cards found?"}
  N2 -- "0 with explicit 'no results'" --> NE["Verified empty → next comune"]
  N2 -- "0 for any other reason" --> NB["Failed: consent wall, captcha<br/>or selector drift → next comune"]
  N2 -- "yes" --> N3{"2 pages in a row<br/>with no new companies?"}
  N3 -- "yes" --> NS["Next comune"]
  N3 -- "no" --> NX["Next page, max 30"]
  NS --> M
  NE --> M
  M{"--maps?"}
  M -- "yes" --> MP["Google Maps: comune × query variants<br/>consent · scroll to end, 3 stalls or 40 attempts"]
  M -- "no" --> DD
  MP --> DD["Dedupe across every source<br/>phone → name+city → name+address → pg_url → maps_url → domain<br/>near-duplicates only flagged for review"]
  DD --> SP["Suppression list: drop phone or VAT matches"]
  SP --> W["Write CSV + JSONL + coverage.json"]
  W --> CP{"0 failed queries, not interrupted,<br/>files present and non-empty?"}
  CP -- "yes" --> OK["complete.json → exit 0"]
  CP -- "no" --> PA["recovery.json, max 20 failures → exit 1<br/>the pipeline refuses to enrich"]
  CP -- "interrupted" --> IN["exit 130, restartable"]
  classDef ok fill:#e2eedf,stroke:#4f7a4a,color:#1f3a1c
  classDef ko fill:#f5e0da,stroke:#a4493a,color:#4a1a12
  classDef warn fill:#f6ead0,stroke:#b07d2a,color:#4a3510
  classDef gate fill:#efe4f3,stroke:#7a4f8f,color:#2e1a38
  class OK ok
  class PX,K,NB,NF ko
  class PA,PM,IN,NE,NS warn
  class SP gate
```

Nothing is dropped for relevance at this stage: Maps tags `category_match` and `permanently_closed`, and closed businesses are skipped at enrichment.

### Enrichment

```mermaid
flowchart TD
  R0["Run setup"] --> PG{"--enable-paid<br/>or PAID_DEFAULT_ON?"}
  PG -- "no" --> FREE["Free sources only · €0"]
  PG -- "yes" --> SEC{"At least one paid provider<br/>enabled and keyed?"}
  SEC -- "no" --> SE["Explicit flag: error<br/>default: warning and a free run"]
  SEC -- "yes" --> CE["Caps: per lead, default €0.10 · per run<br/>cap 0 = paid off"]
  FREE --> L0
  CE --> L0
  L0["Each row, 4 in parallel"] --> S1{"On the suppression list?"}
  S1 -- "yes" --> X1["Dropped, no row written"]
  S1 -- "no" --> S2{"Permanently closed?"}
  S2 -- "yes, without --include-closed" --> X2["SKIPPED"]
  S2 -- "no" --> S3{"Input quality under 0.3?"}
  S3 -- "yes" --> X3["SKIPPED · input quality too low"]
  S3 -- "no" --> W1
  W1["Rung 1: website given in the input<br/>drops messaging links, redirects, directories, socials"] -- "verified" --> V
  W1 -- "no" --> W2["Rung 2: PagineGialle detail page<br/>fills VAT, phone, email, address<br/>accepts the site only on a VAT or phone match"]
  W2 -- "verified" --> V
  W2 -- "no" --> W3["Rung 3: guess the domain<br/>up to 60 domains → DNS → best 6"]
  W3 -- "verified" --> V
  W3 -- "no" --> W4["Rung 4: free web search<br/>DuckDuckGo → Bing · verify the top 5"]
  W4 -- "verified" --> V
  W4 -- "no" --> W4P{"Paid on and a distinctive name?"}
  W4P -- "yes" --> W4B["Serper → Tavily → Exa<br/>VAT or phone match only<br/>vetoed if it looks like an aggregator"]
  W4P -- "no" --> W5
  W4B -- "verified" --> V
  W4B -- "no" --> W5["Rung 5: RDAP, the .it registry<br/>VAT in the record → 0.9 · name → match"]
  W5 -- "verified" --> V
  W5 -- "no" --> NS["No website"]
  V["Verified website"] --> FG
  NS --> FG
  FG["Free extraction from the site:<br/>same-domain email · PEC · socials · VAT · phone<br/>fills empty fields only"] --> DP{"Deep pages enabled?"}
  DP -- "yes" --> DPX["Up to 3 contact / about pages"]
  DP -- "no" --> OD
  DPX --> OD
  OD{"Official data enabled?"}
  OD -- "yes" --> VI["VIES on up to 3 VAT numbers<br/>2 name tokens in common → 0.95"]
  VI --> FI["Revenue and employees<br/>different legal entity → dropped, fail-closed"]
  OD -- "no" --> EM
  FI --> EM
  EM{"Email inference enabled<br/>and no email yet?"}
  EM -- "yes" --> EMX["Pattern + MX/SMTP check<br/>fills only when 'deliverable'"]
  EM -- "no" --> PL
  EMX --> PL
  PL{"Paid on and budget left?"}
  PL -- "yes" --> AP["Last resort: Apify Maps → Perplexity<br/>→ Apify financials / registry"]
  PL -- "no" --> FN
  AP --> FN
  FN["Finish: second suppression pass<br/>status FOUND_WEBSITE_ONLY or NOT_FOUND · lead_score<br/>every call recorded in the cost ledger"]
  classDef ok fill:#e2eedf,stroke:#4f7a4a,color:#1f3a1c
  classDef ko fill:#f5e0da,stroke:#a4493a,color:#4a1a12
  classDef warn fill:#f6ead0,stroke:#b07d2a,color:#4a3510
  classDef gate fill:#efe4f3,stroke:#7a4f8f,color:#2e1a38
  class V ok
  class X1,X2,X3,SE ko
  class NS warn
  class FREE,CE,W4B,AP gate
```

Each rung has a deadline (12 s; 90 s for Apify and Perplexity). Past a spending cap, the paid call is skipped and the lead continues on free sources; a circuit breaker isolates a provider after 5 failures in 60 s.

### Is this website really the company's?

The core of precision: a site is attributed to a company only when the page itself proves it.

```mermaid
flowchart TD
  C["Candidate website"] --> D{"Directory or social domain?"}
  D -- "yes" --> X1["Dropped without fetching"]
  D -- "no" --> F["Fetch the page<br/>retries at 300 and 1500 ms, 2.5 s budget"]
  F --> P{"Parked, under construction<br/>or under 50 characters?"}
  P -- "yes" --> X2["Dropped"]
  P -- "no" --> V{"Company VAT number<br/>on the page?"}
  V -- "yes" --> OK1["VERIFIED · 0.95"]
  V -- "no" --> T{"Last 7 digits of the phone<br/>on the page?"}
  T -- "yes" --> OK2["VERIFIED"]
  T -- "no" --> ST{"Name too generic?"}
  ST -- "yes" --> X3["Rejected"]
  ST -- "no" --> SEM{"Full name, or brand + sector,<br/>or several tokens + city + sector?"}
  SEM -- "no" --> X4["Rejected: weak evidence,<br/>sector conflict or missing city"]
  SEM -- "yes" --> RD{"RDAP: country, province<br/>or city conflict?"}
  RD -- "yes" --> X5["Rejected"]
  RD -- "no, or RDAP unreachable" --> OK3["SEMANTICALLY VERIFIED · 0.8–0.9"]
  classDef ok fill:#e2eedf,stroke:#4f7a4a,color:#1f3a1c
  classDef ko fill:#f5e0da,stroke:#a4493a,color:#4a1a12
  class OK1,OK2,OK3 ok
  class X1,X2,X3,X4,X5 ko
```

### Judgment

Two independent axes: **A** is business potential, from third-party sources only; **B** is the quality of the digital presence, from owned channels only. High A with low B is a **silent gem**: a strong company that is under-represented online.

```mermaid
flowchart TD
  J0["Enriched company"] --> SU{"On the suppression list?"}
  SU -- "yes" --> JS["Skipped"]
  SU -- "no" --> TR{"Triage: closed, pure reseller<br/>or no identity?"}
  TR -- "yes" --> TX["Dropped: A?B?, target NO"]
  TR -- "no" --> L2["L2 digital footprint<br/>website · socials · Places and ad library only with paid"]
  L2 --> FW{"Absence searched for seriously?"}
  FW -- "yes" --> AB["Channel confirmed absent"]
  FW -- "no" --> UK["Unknown: never 'absent' by default"]
  AB --> L3
  UK --> L3
  L3["L3 signals<br/>A: awards, patents, historic brand, press, registry<br/>only when corroborated by city, province, VAT or domain<br/>B: website, socials, reviews and other owned channels"]
  L3 --> JA["L4 judge A · deterministic"]
  L3 --> JB["L4 judge B · deterministic"]
  JA --> LL{"LLM available?<br/>CLI with --paid and a key only"}
  JB --> LL
  LL -- "yes" --> LR["Refines only what was observed"]
  LL -- "no" --> Q
  LR --> Q
  Q["Quadrant A+/A?/A- × B+/B?/B-<br/>+ when score ≥ 0.66"] --> T1{"Disqualifier?<br/>closed · reseller · liquidation or bankruptcy"}
  T1 -- "yes" --> N1["Target NO"]
  T1 -- "no" --> T2{"Axis A or B unknown?"}
  T2 -- "yes" --> B1["BORDERLINE"]
  T2 -- "no" --> T3{"A- B+: all shop window, no substance?"}
  T3 -- "yes" --> N2["Target NO"]
  T3 -- "no" --> T4{"A ≥ 0.60 and gap A−B ≥ 0.30?"}
  T4 -- "yes" --> Y["TARGET YES · silent gem"]
  T4 -- "no" --> T5{"A ≥ 0.50 and gap ≥ 0.20?"}
  T5 -- "yes" --> B2["BORDERLINE"]
  T5 -- "no" --> N3["Target NO"]
  Y --> LV["Levers, in order: positioning → acquisition<br/>→ conversion, if a site exists → measurement"]
  B1 --> LV
  B2 --> LV
  LV --> CR["L5 critic: A and B never cite each other,<br/>no invented states, citations, minimum coverage<br/>→ validation score"]
  N1 --> CR
  N2 --> CR
  N3 --> CR
  classDef ok fill:#e2eedf,stroke:#4f7a4a,color:#1f3a1c
  classDef ko fill:#f5e0da,stroke:#a4493a,color:#4a1a12
  classDef warn fill:#f6ead0,stroke:#b07d2a,color:#4a3510
  classDef gate fill:#efe4f3,stroke:#7a4f8f,color:#2e1a38
  class Y ok
  class N1,N2,N3,TX,JS ko
  class B1,B2 warn
  class LR gate
```

From the dashboard, judgment always runs without an LLM and at €0. Without a paid source for axis A, many companies stay BORDERLINE by design: the firewall never scores what was not measured.

### Operations

```mermaid
flowchart TD
  C0["campaign.sh: each province × sector"] --> V{"Cell already verified complete?"}
  V -- "yes" --> SK["Skip"]
  V -- "no" --> B{"Recovery pending or blocked?"}
  B -- "yes" --> BL["Cell waits"]
  B -- "no" --> SC["Scrape: 8 h timeout, up to 3 attempts"]
  SC --> RC{"Exit code"}
  RC -- "0" --> DONE["Cell complete"]
  RC -- "1, partial" --> ENQ["Queue a recovery"]
  RC -- "2, 3 or timeout" --> RT["Retry with backoff from 120 s, max 1800 s"]
  RT --> RT2{"Attempts used up?"}
  RT2 -- "yes" --> BL2["Cell blocked"]
  RT2 -- "no" --> SC
  RC -- "130, interrupted" --> RS["Stays restartable"]
  ENQ --> GH{"GitHub credentials present?"}
  GH -- "no" --> BL3["Cell blocked"]
  GH -- "yes" --> DI["repository_dispatch → recovery-agent workflow"]
  DI --> AG["An LLM writes the patch"]
  AG --> G1{"Patch guard: only 9 scraper files,<br/>no secrets, network, exec or deletions,<br/>regression test required"}
  G1 -- "no" --> REJ["Patch rejected"]
  G1 -- "yes" --> G2{"git apply, typecheck and tests green?"}
  G2 -- "no" --> REJ
  G2 -- "yes" --> G3{"A second, independent LLM approves?"}
  G3 -- "no" --> REJ
  G3 -- "yes" --> PR["PR → merge in a protected environment"]
  PR --> RE["Resume the scrape and re-verify the cell"]
  RE --> FP{"Same failure after 2 cycles?"}
  FP -- "yes" --> BL4["Cell blocked, needs a human"]
  FP -- "no" --> DONE
  WD["watchdog: until every cell is complete,<br/>relaunch the campaign if it dies"] -.-> C0
  classDef ok fill:#e2eedf,stroke:#4f7a4a,color:#1f3a1c
  classDef ko fill:#f5e0da,stroke:#a4493a,color:#4a1a12
  classDef warn fill:#f6ead0,stroke:#b07d2a,color:#4a3510
  classDef gate fill:#efe4f3,stroke:#7a4f8f,color:#2e1a38
  class DONE,PR ok
  class BL2,BL3,BL4,REJ ko
  class BL,RS,ENQ warn
  class G1,G2,G3 gate
```

### Known gaps

Found while mapping the code above; none affects the free default path.

- **Esteso = Completo**: the dashboard's "Esteso" depth does nothing beyond "Completo" yet.
- **Guessed domains**: a site found by domain guessing (or verified only semantically) does not hand its page body to contact extraction, which then happens only with deep pages enabled (`hyper_guesser_stage.ts:66-77`).
- **Input VAT**: promoted to `vat_code_final` before VIES runs, so the VIES check of a declared VAT is effectively skipped (`field_registry.ts:215`).
- **Apify Maps / Registro / Bilanci** accept the data when the source returns no name: the opposite of `isWrongEntity`'s fail-closed rule.
- **RDAP rescue** can accept a site that rung 1 had already rejected.
- **Unused statuses**: `FOUND_COMPLETE` and `ENRICHMENT_ONLY_NO_WEBSITE` exist in the type, but no path assigns them.
- **Triage**: 5 disqualifiers are marked as cheaply checkable, 3 are checked (`judgment/config/v0.ts:294-298`).
- **Recorded model**: with `--paid` the verdict records the configured model, but the router may be answered by another provider (`runtime_context.ts:58`).

| Area | Main files |
|---|---|
| Orchestration | `src/cli/run.ts` (gate on a partial scrape: 123–135) |
| Discovery | `src/discovery/scrape_pipeline.ts`, `sources/pagine_gialle_live.ts`, `sources/maps_live.ts`, `preflight.ts`, `deduper.ts`, `discovery/scrape_completion.ts` (completion criteria: 250–256) |
| Enrichment | `src/cli/enrich_command.ts`, `enrichment/enrichment_pipeline.ts`, `stages/*_stage.ts`, `website/verify_candidates.ts`, `discovery/website/preverify_gate.ts` |
| Paid gate | `providers/provider_router.ts` (filters: 399–448, budget reservation: 324–360), `providers/smart_serper_gate.ts`, `providers/paid_evidence_gate.ts` |
| Judgment | `src/judgment/run_judgment.ts`, `triage.ts`, `collectors/collect_a.ts`, `judges/gap_reasoner.ts` (target rule: 68–78), `judges/critic.ts` |
| Operations | `scripts/campaign.sh`, `scripts/recovery_coordinator.sh`, `src/cli/recovery_agent.ts`, `src/runtime/recovery_patch_guard.ts` |
| Dashboard | `src/server/api_server.ts`, `src/server/scrape_job.ts`, `src/server/scrape_request.ts` |

## Quick start

Requires Node 24 and pnpm.

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
pnpm demo        # API on :8787 + dashboard on :3000, 480 fictional B2B SaaS / deeptech companies
pnpm demo:live   # same, but empty: "Mappa il mercato" → depth "Rapido" scrapes a real
                 # capital in ~1 min, free sources only, and the counts grow live
```

In the dashboard: <kbd>⌘</kbd> <kbd>K</kbd> (or <kbd>Ctrl</kbd> <kbd>K</kbd>) opens the command palette, <kbd>?</kbd> lists every shortcut, and the status bar at the bottom shows the engine, the measured API latency, the running job and the session cost.

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

![Companies archive: SaaS and deeptech companies with revenue, headcount and maturity](docs/assets/dashboard-aziende.png)
![Command palette: a company found by name](docs/assets/dashboard-palette.png)
![Coverage map: companies per region, from the demo dataset](docs/assets/dashboard-italia.png)
![Province of Padova: companies per comune, with data maturity and cost per target](docs/assets/dashboard-padova.png)
![Analytics overview: source yield, insights, acquisition trend, tier mix](docs/assets/dashboard-analytics.png)
![The same views at 360px](docs/assets/dashboard-mobile.png)

</details>

## Quality gates

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
RUN_SMOKE=1 pnpm test:smoke    # opt-in: touches real network/browser
pnpm --dir web test:e2e        # dashboard: axe, keyboard paths, 1440px and 360px (local, starts pnpm demo)
```

CI runs two independent jobs on every PR:
- **core**: frozen install, typecheck, unit tests, lint, build and production dependency audit;
- **dashboard**: typecheck, lint (including design-system rules: no literal colours, radii or shadows, no em dash, no italics), `next build` and audit.

## Why pg4 exists

pg4 is the third generation of the same project, and the earlier ones are the reason it looks the way it does.

- **pg1** was the first resolver. It is kept only as a reference for the lessons it taught.
- **pg3** became the production runtime and then collapsed under its own operational weight. It had BullMQ/Redis, crawler sidecars, monolithic orchestration and cost controls nobody could reason about as a single system. Its logs show the symptoms: Redis degradation, sidecar crashes, crt.sh 5xx storms, empty search results counted as provider failures, and paid providers left to burn money until someone killed the process.
- **pg4** started as a clean export and a deliberately small core. Every failure mode pg3 had was audited from its real outputs and turned into an explicit guardrail with a test. Examples: the same agency emitted 10 times across comuni, and 191 "websites" that were really immobiliare.it listings. The result is a short list of invariants and one boundary per concern. Adding a provider is one file; adding a stage is one file.

## Responsible use

This is a portfolio project. It collects **publicly listed business information**; that data is personal data under the GDPR only when it identifies a natural person (for example, a sole trader).

- The repository contains **no scraped data**. Test fixtures are anonymised and the demo dataset is fictional (`*.example` domains, `999…` VAT numbers). It is generated by `scripts/generate_demo_dataset.ts`; the screenshots above by `pnpm --dir web exec node scripts/capture-screenshots.mjs` against a running `pnpm demo`.
- Scraping third-party sites may conflict with their terms of service. Check the terms and your legal basis before running live scrapes.
- There is a GDPR toolkit in [`docs/gdpr/`](docs/gdpr/): a legitimate-interest assessment template, an Art. 14 notice and a pre-production checklist. A suppression list is enforced by the pipeline.
- Paid providers are off unless you explicitly turn them on.

## License

[MIT](LICENSE) © Marco Milanello
