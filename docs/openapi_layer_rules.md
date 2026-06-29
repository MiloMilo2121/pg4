# Openapi layer — the rules (base built, activation layer next)

*Openapi.com = official Italian registry (InfoCamere reseller, ANCIC). PAID. The base
(request client + connection) is built and DISABLED. This file DEFINES the rules the
ACTIVATION LAYER will enforce. 2026-06-16. Nothing is enabled; €0 until the operator says.*

## The one rule, in Marco's words
**"Openapi non è da usare a priori — solo TOP aziende, SU RICHIESTA."**
Openapi is never an automatic/default lever. It fires only for a TOP company, only on an
explicit operator request. It is the deliberate, paid, deep-enrich — not the free pass.

## What the BASE enforces NOW (always-on safety — `openapi_enrich.ts` + `openapi_client.ts`)
1. **Disabled by default** — triple-gate: `OPENAPI_ENABLED=true` + `OPENAPI_API_KEY` set
   (`client.available()`) + the caller's ceiling. Off → `enrichByVat` returns `disabled`.
2. **Entity-guard (mandatory)** — the official record's name must ≥2-match the lead
   (`isWrongEntity`), else the VAT belongs to a different entity (franchisor/accountant)
   → `entity_mismatch`, data refused. (Even though Openapi's by-identity VAT is far
   cleaner than a footer scrape, a by-VAT lookup on a wrong footer-VAT is still guarded.)
3. **Ledger + memo** — every real call records its cost (ceiling observable); one call
   per VAT per process (never pay twice for one company).
4. **Errors not silent** — auth/rate/5xx throw (breaker/ledger see them), like serper.

## What the ACTIVATION LAYER must add (NEXT — not built)
1. **TOP-company eligibility predicate** (`isTopCompany(lead)`) — the gate on WHICH
   companies may be enriched. PROPOSED default (to confirm): a real legal entity worth
   the spend — e.g. società di capitali OR a checksum-valid/VIES-confirmed VAT OR a
   revenue signal — NOT ditte individuali by default. Marco confirms the exact predicate.
2. **On-request only** — Openapi NEVER fires inside the free/automatic enrich. It is a
   SEPARATE, explicit action (a dashboard "deep enrich / + Openapi" button per company,
   or a curated request list). The free cascade must not auto-escalate to it.
3. **€ ceiling + confirmation** — a per-request and per-session cap (PROPOSED: IT-advanced
   €0.10 + IT-pec €0.03 ≈ €0.13/company at base price, ~€0.04 at best/subscription).
   Above the cap → require explicit operator confirmation. Bounded + reported, like the
   proven €0.02 free-tier ceiling.
4. **Free IT-search separate lane** — `searchByAtecoProvince(dryRun)` is free (≤100/day)
   and is the COVERAGE/official-VAT enumerator; it can have a lighter gate than the paid
   by-VAT calls, but stays operator-on-request (not automatic).

## TWO DECISIONS for Marco (the rules to nail before the activation layer)
- **What is a "top" company?** → the `isTopCompany` predicate (società-di-capitali? a
  revenue/employee threshold? operator-whitelist per request? a manual per-row pick?).
- **The € ceiling** per request and per session (and whether to wire IT-advanced €0.10 +
  IT-pec €0.03, or IT-advanced only first).

## Endpoints (the base wired them; shapes from docs, per-VAT response PENDING verification)
- `IT-search` (free ≤100/day, `dryRun` = count): ATECO+province → official VAT + identity
  + address(province). The legal-universe enumerator (also fixes the footer-VAT collision
  class at the root — official VAT by identity, no footer scrape).
- `IT-advanced` (€0.10 / ~€0.028 best) by VAT: revenue, employees, **legal representative**,
  REA, ATECO. Response field paths PENDING — confirm + golden on the FIRST real call.
- `IT-pec` (€0.03 / ~€0.015 best) by VAT: certified email. Response PENDING.
- License gate (unchanged): redistribution-in-a-sold-product is a separate ToS question;
  the ENRICHMENT model (enrich the customer's own leads) is the cleared use — see
  docs/coverage_planB_official_sources.md.

## Activation checklist (when Marco says go)
1. Key in `.env` (`OPENAPI_API_KEY`, `OPENAPI_ENABLED=true`). Sandbox first via `OPENAPI_BASE_URL=https://test.company.openapi.com`.
2. ONE real `IT-advanced` + `IT-pec` call on a known top company → capture the response →
   finalise `mapAdvanced` field paths → write the REAL-data golden.
3. Implement `isTopCompany` + the on-request action + the ceiling (the activation layer).
4. Bounded slice on real AXEND leads → measure precision lift vs the free path → report.
5. Never at scale without the operator. No push without the source-check.
