# Changelog

All notable changes to pg4 are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [v1.1.0] - 2026-10-02

### Security
- Local dashboard API: requests with a Host other than a loopback name on the bound port get 403 (DNS rebinding); request bodies are capped at 1 MB (413) and malformed JSON gets 400; a scrape category or province starting with `-` is refused instead of reaching the CLI as a flag (`--enable-paid`); `/api/health` answers only GET/HEAD; finished jobs expire after 1 h, at most 200 per registry.

### Fixed
- Setaccio headcount read a range such as `11-20` as 1120; it now shows the midpoint (16).
- LLM judge calls no longer send `temperature` to models that reject it (Claude Opus 4.7+/Sonnet 5.x/Fable, OpenAI reasoning models), which made every call fail with HTTP 400.
- Domains are resolved on the Public Suffix List (`tldts`) in one helper: `foo.pd.it`, `foo.co.uk` and hosting tenants such as `x.altervista.org` no longer collapse to `pd.it`, `co.uk` or `altervista.org` in the email-ownership filter, same-site crawling, dedupe review and website candidates. RDAP now queries the registrable domain (`shop.foo.it` → `foo.it`) and skips hosting tenants.
- RDAP and VIES calls now go through a shared rate limit (1 req/s, burst 2) and circuit breaker, so a registry outage stops costing every lead a full timeout. A busy or throttled VIES (`MS_MAX_CONCURRENT_REQ`, 429) now reads as "not checked" rather than "VAT invalid".
- The fatturatoitalia.it breaker is per host and per 120 s window, with a half-open probe. Scattered transients and one lead's missing page no longer switch the source off for every lead.
- Paid SERP spend was under-recorded (Tavily by 32%, Exa by 22%): adapters and the role registry now share one price table.
- Dashboard enrich honours the suppression list like `pnpm enrich`: a suppressed lead is skipped before any fetch and a suppressed address is never inferred nor written from the website; paid steps stay off.
- Dashboard scrape does what the wizard shows: one run per selected category × province (sequential), `--maps` when Maps is selected, the MCP's 12 h timeout instead of 10 minutes, and a run that dies keeps the rows it wrote (job status `partial`). Sources the CLI cannot run from the dashboard (paid ones) are refused with the reason.
- `/api/cost` adds up the enrich, judgment and scrape jobs of the session from their recorded costs, and reports a cost it cannot measure (a seed without a ledger) as `null` instead of `0`.

### Changed
- Demo dataset (`pnpm demo`) is now 480 fictional B2B SaaS and deeptech companies (SaaS, AI, cybersecurity, fintech, robotics, photonics, biotech/medtech, spacetech, quantum) in 18 northern Italian provinces, generated reproducibly by `scripts/generate_demo_dataset.ts`. It replaces the 427 local SMEs (dentists, hauliers, mechanics, estate agents).
- ATECO crosswalk (`data/reference/category_ateco_map.json`) classifies the new sectors (divisions 62 extended, 64, 28, 26, 30, 72), so the coverage gap map and backlog work on them against the ISTAT universe.
- Setaccio dashboard: the national map rolls up every region the data touches (it used to show Veneto only); the detail panels of nation, region and province, the Cockpit's province count and "most companies" hint, and the comuni map (now Padova) are computed from the API instead of hard-coded; the static panels (markets, funnel, credits, providers, analytics insights, lists) were rewritten for SaaS and deeptech targets.
- Setaccio dashboard moved to Design System v2 "Grafite", in an app variant: graphite on warm paper with night sidebar, topbar and status bar, square panels joined by shared hairlines (2px on controls, no shadows), a 24px measuring grid behind the content, Archivo + DM Mono self-hosted via `next/font`, MM monogram, Milo v2, and one geometric line-icon set drawn in the DS vocabulary (status nodes: solid done, open waiting, slashed failed). Charts and the Italia map use one graphite ramp; status colours appear only where they carry meaning. Tokens and primitives live in `web/app/ds/`, Setaccio composites in `web/app/setaccio/ui/`; inline styles went from 504 to under 90. Lint now rejects em dashes in copy, italics, literal colours and inline radii or shadows in `web/app`.
- Setaccio is keyboard-first: ⌘K / Ctrl K command palette (views, actions, markets, companies by name, city or VAT), `g` + letter to change view, `/` to search the archive, `?` for the shortcut list. The market picker is a real listbox instead of a click-to-cycle pill, the topbar shows the path (`setaccio / archivio / …`), and a status bar reports engine state, measured API latency, the running job and the session cost.
- Setaccio accessibility: overlays are real dialogs (focus in, Tab trapped, Escape, focus return), tabs follow the ARIA pattern with arrow keys, the Italia map is reachable and operable from the keyboard, toggles expose `aria-pressed`, tables are real tables. The Milo tour no longer opens by itself on first visit; the button carries a "new" mark instead.
- Setaccio responsive down to 360px: off-canvas sidebar below 1100px, reflowing grids, horizontally scrolling tables with a sticky first column, stacked Italia panels. Every transition and the map count-up respect `prefers-reduced-motion`.
- `pnpm --dir web test:e2e` (Playwright + axe-core) checks every view and overlay on the demo dataset at 1440px and 360px: no serious or critical axe violations, no horizontal overflow, keyboard paths (dialogs, tabs, map, palette, shortcuts, market picker).
- Retired default models replaced (DeepSeek, GLM, Kimi); model ids, prices and browser versions each live in one table with a verification date.
- User-Agent and client hints refreshed (Chrome 155, Firefox 156); Meta Graph API v21.0 → v26.0.

## [v1.0.0] - 2026-09-28

First public release.

### Added
- Discovery from PagineGialle and Google Maps (Playwright), with pure HTML parsers, checkpointed and resumable runs, and de-duplication across comuni.
- Evidence-backed official-website resolution: input site, PagineGialle detail page, domain guessing, SERP, RDAP rescue.
- Enrichment of email, PEC, phone, social profiles, VAT, revenue and headcount from the site and from official registries; email inference checked with MX/SMTP.
- Optional two-axis judgment layer (business potential vs digital presence).
- Cost safety: paid providers are off by default; per-lead caps re-read live from the ledger; atomic run-level reservation; failed calls recorded at their real cost.
- Operations: PID-reuse-safe watchdog, recovery agent whose merges wait for human approval, graceful shutdown.
- MCP server with a path sandbox, and the Setaccio dashboard with a synthetic demo dataset (`pnpm demo`).

### Security
- Fetches and SMTP dials that start from scraped data cannot reach loopback, private or cloud-metadata addresses (checked at connect time, redirects included); response bodies are size-capped.
