# PRODUCTION ACTIVATION CHECKLIST

*The single gate between "SaaS foundation in neutral" and "production-live".
Nothing in this list is satisfied by code alone — each item needs an operator
or legal decision. Do NOT flip any switch below until its row is GREEN.*

This pass deliberately built the complete machine and left it in neutral:
multi-tenant schema as migrations (no live DB), paid providers triple-gated
(€0.02 test only), compliance mechanics built but legal basis NOT flipped,
billing schema present but Stripe NOT wired, no deploy. This checklist is how
you turn it on, in order.

---

## 0. LEGAL — must be GREEN before ANY real third-party data is processed at scale

| # | Item | Owner | Evidence required | Status |
|---|------|-------|-------------------|--------|
| 0.1 | **Lawful basis decided** for processing company contact data (legitimate interest is the working default). | DPO / legal | Signed LIA per `LIA_template.md`, dated, naming the controller. | ☐ |
| 0.2 | **Art. 14 notice published** (data not collected from the subject) + the route to deliver/host it. | DPO / legal | Live notice URL per `art14_notice_template.md`; the URL wired into outreach. | ☐ |
| 0.3 | **RPO registered** (Registro Pubblico delle Opposizioni) IF any phone calling will occur — obligatory in Italy incl. cell numbers and sole proprietors. | Operator | RPO operator credentials; the RPO feed importing into `suppression`. | ☐ |
| 0.4 | **DPA signed** with each data sub-processor actually used (Supabase, paid enrichment APIs, email-finders). | Legal | Countersigned DPAs on file. | ☐ |
| 0.5 | **Retention period chosen** per tenant + documented as a GDPR decision. | DPO | Retention policy doc; the window set in tenant settings. | ☐ |
| 0.6 | **Registry/PEC data source licensing** confirmed (INI-PEC / Registro Imprese ToS permit the intended use). | Legal | Licence / ToS review note. | ☐ |

**Gate A (from the roadmap): email enrichment must not reach a real subject
until 0.1 + 0.2 are GREEN.** The free-gold extractor already infers emails; do
not *send* to them before the notice + LIA exist.

---

## 1. PERSISTENCE — activate the multi-tenant database

| # | Step | How |
|---|------|-----|
| 1.1 | Pick the Supabase project/org (region eu-central-1). | Operator decision — NOT done in this pass on purpose. |
| 1.2 | Apply the schema. | `supabase` MCP `apply_migration` with `db/migrations/0001_multitenant_init.sql`, OR `supabase db push`. |
| 1.3 | Verify RLS is ON + FORCED on every tenant table. | `select relname, relrowsecurity, relforcerowsecurity from pg_class where relrowsecurity;` — all listed tables true/true. |
| 1.4 | **Run the cross-tenant leakage test against the LIVE DB** (Gate C). | Seed two tenants + two memberships; assert a tenant-A JWT cannot `select` tenant-B rows on EVERY table. This is the one isolation proof that needs a real DB — the in-memory tests prove the app layer; RLS needs Postgres. |
| 1.5 | Implement `SqlExecutor` with the Supabase/pg client; construct `PgTenantDb`. | `src/persistence/pg_tenant_db.ts` is ready; the executor is the only missing piece. |
| 1.6 | Migrate existing `_runs.jsonl` / `suppression.csv` / cost-ledger JSONL → rows. | One-shot loader using `readRunHistory()` + the row mappers. |

---

## 2. ENRICHMENT — activate paid tiers (only when the money-guard is proven live)

| # | Step | How |
|---|------|-----|
| 2.1 | **Run the live €0.02 ceiling test.** | Provide `SERPER_API_KEY`; run the command in `docs/saas_foundation_report.md §A4`. Confirm the ledger never exceeds €0.02 and the latched `run_cost_ceiling_hit` fired. This is the ONE real spend that proves the guard end-to-end. |
| 2.2 | Wire the official-data providers (INI-PEC, VIES, fatturatoitalia) and flip their `enabled` in `field_registry.ts`. | Phase 3 of the roadmap. Each is already declared as a disabled step. |
| 2.3 | Enable paid field steps (email-finder, people-finder) per tenant plan. | Flip `enabled` + provide the provider; the per-field ceiling already gates them. |
| 2.4 | Prove the cross-worker run ceiling (DB advisory lock + ledger SUM) before scale (Gate B). | Multi-worker version of 2.1. |

---

## 3. BILLING — activate Stripe (schema is present; not wired)

| # | Step | How |
|---|------|-----|
| 3.1 | Connect Stripe metered billing keyed to `cost_ledger` aggregates → `usage`. | The `usage` table is ready; populate it from `cost_ledger` per period. |
| 3.2 | Enforce plan quotas in the API (reject jobs over quota). | Add the check in `ControlPlane.createEnrichJob`. |

---

## 4. DEPLOY

| # | Step | How |
|---|------|-----|
| 4.1 | Build the Next.js frontend per `docs/frontend_spec.md`; wire it to the API + a dev tenant. | Separate app (intentionally not built this pass). |
| 4.2 | Deploy with a preview environment + Lighthouse CI gate. | Vercel. |
| 4.3 | Wire the worker pool (lease queue) + n8n scheduling. | Phase 7 of the roadmap. |

---

## What is SAFE to do today (no checklist gate)
- Run scrape/enrich locally with the **free** tiers (free-gold + the engine) —
  €0, no paid providers, no real subject contacted.
- Persist to the **in-memory** TenantDb for local/dev runs.
- Exercise the API control plane + per-field framework against dev data.

These produce no outward-facing effect and process no data at scale, so they
sit below every gate above.
