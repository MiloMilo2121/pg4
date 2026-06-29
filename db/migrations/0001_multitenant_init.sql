-- ============================================================================
-- pg4 SaaS foundation — multi-tenant schema (migration 0001)
-- ============================================================================
-- Target: Supabase / Postgres 15+. NOT production-live in this pass — this is
-- the reviewable, irreversible architectural artifact. Apply with the Supabase
-- CLI / MCP `apply_migration` only after the PRODUCTION ACTIVATION CHECKLIST
-- (docs/gdpr/PRODUCTION_ACTIVATION_CHECKLIST.md) is satisfied.
--
-- Design invariants (these are the decisions that are expensive to change later):
--   1. EVERY domain row carries `tenant_id` — multi-tenant from table #1.
--   2. Row-Level Security is enabled + forced on every tenant-scoped table,
--      so isolation is enforced at the DB layer, NEVER by app code alone.
--   3. The lead/company columns mirror src/types/lead.ts RAW + ENRICHED
--      (append-only); new fields are added with ALTER ... ADD COLUMN, never by
--      reordering — same append-only contract as the CSV.
--   4. `field_evidence` + `cost_ledger` are APPEND-ONLY children (audit trail).
--   5. `runs` mirrors src/runtime/run_record.ts RunRecord 1:1.
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Tenancy spine
-- ---------------------------------------------------------------------------
create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  plan        text not null default 'free',     -- billing tier; NOT enforced yet
  created_at  timestamptz not null default now()
);

-- App users mirror Supabase auth.users (id = auth.uid()). We keep a thin local
-- row so memberships + audit can FK to it without reaching into the auth schema.
create table app_users (
  id          uuid primary key,                 -- = auth.uid()
  email       text,
  created_at  timestamptz not null default now()
);

-- The RLS join table: which user belongs to which tenant, and with what role.
create table memberships (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references app_users(id) on delete cascade,
  role        text not null default 'member',   -- owner | admin | member | viewer
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index memberships_user_idx on memberships(user_id);

-- ---------------------------------------------------------------------------
-- Companies — the lead records. One row per (tenant, dedup_key).
-- Columns mirror RAW_CSV_COLUMNS + ENRICHED_CSV_COLUMNS (src/types/lead.ts).
-- Merge semantics (deduper.ts): fill-only-missing → UPSERT a column only when
-- it is currently NULL (see PostgresLeadSink). The unique key is the dedup key.
-- ---------------------------------------------------------------------------
create table companies (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  dedup_key       text not null,                -- computeDedupKey(lead) — see src/persistence/dedup_key.ts
  -- raw (scraped) ---------------------------------------------------------
  company_name    text not null,
  category        text,
  city            text,
  province        text,
  region          text,
  address         text,
  phone           text,
  phone_raw       text,
  website         text,
  source          text,
  source_url      text,
  pg_url          text,
  maps_url        text,
  vat_code        text,
  confidence      numeric,
  discovery_notes text,
  query_location  text,
  business_city   text,
  category_match  text,
  permanently_closed boolean,
  -- enriched --------------------------------------------------------------
  status                  text,
  reason_code             text,
  official_website        text,
  website_confidence      numeric,
  website_discovery_method text,
  vat_code_final          text,
  pec                     text,
  email_inferred          text,
  email_type              text,
  revenue                 text,
  revenue_year            text,
  employees               text,
  employees_is_estimated  boolean,
  decision_maker_name     text,
  decision_maker_role     text,
  decision_maker_linkedin text,
  lead_score              numeric,
  financial_source        text,
  financial_confidence    numeric,
  financial_notes         text,
  -- schema v2 (Phase 1 free-gold) -----------------------------------------
  instagram               text,
  facebook                text,
  linkedin                text,
  -- bookkeeping -----------------------------------------------------------
  cost_eur        numeric not null default 0,
  schema_version  int not null default 2,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, dedup_key)
);
create index companies_tenant_idx        on companies(tenant_id);
create index companies_tenant_vat_idx    on companies(tenant_id, vat_code_final);
create index companies_tenant_status_idx on companies(tenant_id, status);

-- Secondary dedup keys (phone / name+city / name+addr / host) → the canonical
-- company, so the find-existing path is a single indexed lookup (mirrors the
-- in-memory Deduplicator's multi-key index).
create table company_dedup_aliases (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  alias_key   text not null,
  key_type    text not null,                    -- phone | name_city | name_addr | host
  company_id  uuid not null references companies(id) on delete cascade,
  primary key (tenant_id, alias_key)
);
create index company_dedup_aliases_company_idx on company_dedup_aliases(company_id);

-- ---------------------------------------------------------------------------
-- field_evidence — APPEND-ONLY provenance spine (the Q4 precision-audit table).
-- Every enriched value records WHERE it came from, HOW confident, and the cost.
-- ---------------------------------------------------------------------------
create table field_evidence (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  company_id        uuid not null references companies(id) on delete cascade,
  field             text not null,              -- 'official_website' | 'pec' | 'revenue' | ...
  value             text,
  source            text,                       -- provider id / 'input' / 'vies' / 'registry'
  discovery_method  text,
  confidence        numeric,
  cost_eur          numeric not null default 0,
  run_id            uuid,
  job_item_id       uuid,
  evidence_blob     jsonb,                      -- raw snippet / url for audit
  created_at        timestamptz not null default now(),
  unique (company_id, field, source, run_id)    -- idempotent re-runs
);
create index field_evidence_tenant_idx  on field_evidence(tenant_id);
create index field_evidence_company_idx on field_evidence(company_id);

-- ---------------------------------------------------------------------------
-- Jobs — an intent ("scrape X in Y") or a per-field enrichment over a selection.
-- ---------------------------------------------------------------------------
create table enrichment_jobs (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants(id) on delete cascade,
  created_by               uuid references app_users(id),
  kind                     text not null,       -- 'scrape_run' | 'enrich_fields'
  selection                jsonb,               -- {company_ids?:[], filter?:{}} | intent
  fields                   text[],              -- which fields to enrich
  paid_enabled             boolean not null default false,
  per_item_cost_ceiling_eur numeric,
  run_cost_ceiling_eur     numeric,
  status                   text not null default 'queued', -- queued|running|done|failed|cancelled
  total_cost_eur           numeric not null default 0,
  created_at               timestamptz not null default now()
);
create index enrichment_jobs_tenant_idx on enrichment_jobs(tenant_id, status);

-- job_items — the work queue. Workers claim with FOR UPDATE SKIP LOCKED;
-- the lease (lease_owner/lease_until) replaces the single-host PID file lock.
create table job_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  job_id      uuid not null references enrichment_jobs(id) on delete cascade,
  company_id  uuid references companies(id) on delete cascade,
  fields      text[],
  status      text not null default 'queued',   -- queued|running|done|failed|cost_capped
  lease_owner text,
  lease_until timestamptz,
  attempts    int not null default 0,
  cost_eur    numeric not null default 0,
  result      jsonb,
  error       text,
  updated_at  timestamptz not null default now()
);
create index job_items_claim_idx on job_items(status, lease_until);
create index job_items_job_idx   on job_items(job_id);

-- ---------------------------------------------------------------------------
-- runs — mirrors src/runtime/run_record.ts RunRecord 1:1 (the _runs.jsonl audit
-- trail migrated to rows; readRunHistory() is the one-shot loader).
-- ---------------------------------------------------------------------------
create table runs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  record_version int not null default 1,
  run_id         text not null,                 -- the engine's run id
  command        text not null,                 -- scrape | enrich | run
  args           jsonb,
  category       text,
  started_at     timestamptz,
  finished_at    timestamptz,
  duration_ms    bigint,
  status         text,                          -- ok|partial|fatal|interrupted|preflight_failed
  exit_code      int,
  leads_in       int,
  leads_out      int,
  with_website   int,
  row_errors     int,
  suppressed     int,
  total_cost_eur numeric,
  comuni_yield   jsonb,
  suspect        boolean,
  suspect_comuni text[],
  provider_dead  text[],                        -- Gate-0 dead-provider list
  error          text,
  unique (tenant_id, run_id)
);
create index runs_tenant_idx on runs(tenant_id, started_at desc);

-- cost_ledger — mirrors src/runtime/cost_ledger.ts LedgerEntry, per-call,
-- tenant-scoped. The billing/usage source of truth.
create table cost_ledger (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  run_id      text,
  job_item_id uuid,
  provider    text not null,
  family      text,
  cost_eur    numeric not null default 0,
  success     boolean,
  kind        text,
  meta        jsonb,
  ts          timestamptz not null default now()
);
create index cost_ledger_tenant_idx on cost_ledger(tenant_id, ts);

-- usage — billing-ready rollup per tenant per period. POPULATED but NOT billed
-- in this pass (no Stripe). Derivable from cost_ledger; materialized for speed.
create table usage (
  id            bigserial primary key,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  paid_calls    int not null default 0,
  cost_eur      numeric not null default 0,
  leads_enriched int not null default 0,
  created_at    timestamptz not null default now(),
  unique (tenant_id, period_start, period_end)
);

-- suppression — per-tenant do-not-contact (migrates suppression.csv).
create table suppression (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  phone_key   text,
  vat_key     text,
  email_key   text,
  reason      text,                             -- operator | art21_objection | art14 | rpo
  source      text,
  created_at  timestamptz not null default now()
);
create index suppression_tenant_phone_idx on suppression(tenant_id, phone_key);
create index suppression_tenant_vat_idx   on suppression(tenant_id, vat_key);

-- audit_events — Art.30/Art.14/LIA evidence (compliance mechanics).
create table audit_events (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  kind        text not null,                    -- art14_notice | art21_objection | retention_sweep | ...
  subject     jsonb,
  actor       uuid references app_users(id),
  ts          timestamptz not null default now()
);
create index audit_events_tenant_idx on audit_events(tenant_id, ts);

-- enrichment_cache — cross-run, cross-job cache (a blueprint cost principle).
-- A company/field already enriched for this tenant is not re-enriched. P.IVA→PEC
-- never changes, so this collapses repeat-run cost toward €0.
create table enrichment_cache (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  cache_key   text not null,                    -- '<field>:<keytype>:<keyval>' e.g. 'pec:vat:01234567897'
  field       text not null,
  value       jsonb,
  confidence  numeric,
  source      text,
  fetched_at  timestamptz not null default now(),
  ttl_days    int,                              -- null = never expires (registry facts)
  primary key (tenant_id, cache_key)
);

-- ============================================================================
-- Row-Level Security — isolation enforced at the DB layer.
-- Policy: a row is visible/writable iff the caller is a member of its tenant.
-- ENABLE + FORCE so even the table owner is subject to the policy (defence in
-- depth against an app bug that connects as owner). The service-role key
-- bypasses RLS by design — workers MUST set tenant_id explicitly on every
-- write (enforced in app code + the CHECK below) and run scoped queries.
-- ============================================================================
create or replace function current_tenant_ids() returns setof uuid
  language sql stable security definer set search_path = public as $$
  select tenant_id from memberships where user_id = auth.uid()
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'companies','company_dedup_aliases','field_evidence','enrichment_jobs',
    'job_items','runs','cost_ledger','usage','suppression','audit_events',
    'enrichment_cache','memberships'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($f$
      create policy tenant_isolation on %I
        using (tenant_id in (select current_tenant_ids()))
        with check (tenant_id in (select current_tenant_ids()))
    $f$, t);
  end loop;
end $$;

-- tenants + app_users: a user sees the tenants they belong to + their own row.
alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenant_self on tenants
  using (id in (select current_tenant_ids()));

alter table app_users enable row level security;
alter table app_users force row level security;
create policy user_self on app_users
  using (id = auth.uid());
