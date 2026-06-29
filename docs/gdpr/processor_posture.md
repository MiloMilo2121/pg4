# Processor / controller posture — notes

*Working notes for the DPA + roles, not legal advice. Confirm with legal before
production (checklist 0.4).*

## Who is what

pg4-as-SaaS can operate in two roles depending on the deal shape — be explicit
per tenant, because it changes the obligations:

1. **Tenant is the controller, the SaaS is a processor.** The client decides the
   purpose (who to prospect, why) and uses the platform as a tool. The SaaS
   processes company data on the client's documented instructions.
   → Requires an **Art. 28 DPA** between the SaaS and each tenant, with the SaaS
   as processor and its own sub-processors (Supabase, enrichment APIs) as
   sub-processors (flow-down terms + the client's right to object to new ones).

2. **The operator is the controller** (running prospecting for its own AXEND
   business). Then the SaaS infrastructure providers are the processors, and the
   operator owns the LIA, the Art. 14 notice, retention, and RPO.

**Multi-tenant isolation is the technical backbone of the processor posture:** a
processor must ensure one client's data cannot leak to another. That is enforced
by Postgres RLS (migration 0001) + the app-layer tenant scoping (every sink/API
bound to a tenant) + the cross-tenant leakage test (checklist 1.4). Document
this as a technical + organisational measure (Art. 32) in the DPA.

## Sub-processors to list in the DPA (only those actually used)

| Sub-processor | Role | Data | Region |
|---|---|---|---|
| Supabase (Postgres/Auth/Storage) | hosting + database | all tenant data | eu-central-1 |
| Serper / paid SERP | website discovery | company names + queries | — |
| Email-finder API (if enabled) | email enrichment | company domain + name | — |
| People-finder API (if enabled) | decision-maker | company domain + name | — |
| INI-PEC / Registro Imprese | official registry | P.IVA lookups | IT/EU |

Keep this table current; the DPA's sub-processor list must match what is
actually `enabled` in `field_registry.ts` + `provider_catalog.ts`.

## Art. 32 measures already in place (cite in the DPA)

- Tenant isolation: RLS (enabled + FORCED) + app-layer scoping + leakage test.
- Least data: free-first, field-level provenance, append-only audit trail.
- Suppression + retention mechanics (Art. 21 + Art. 5(1)(e)).
- Cost/abuse guard: triple-gated paid providers + run-cost ceiling (proven).
- Self-reporting: dead-provider detector + yield-anomaly + output validation.

## What is NOT yet a measure (build before claiming it)

- Encryption-at-rest beyond Supabase defaults / field-level encryption of PII.
- Access logging per operator action (only run-level audit exists today).
- A formal breach-notification runbook (72h, Art. 33).
