-- ============================================================================
-- pg4 judgment layer — schema extension (migration 0002)
-- ============================================================================
-- Extends migration 0001 ADDITIVELY (every change is ADD COLUMN / CREATE TABLE
-- / CREATE INDEX — never a reorder, honoring 0001 invariant #3). NOT live until
-- the PRODUCTION_ACTIVATION_CHECKLIST is satisfied.
--
-- Cardinal rule (plan §0 — "cemento vs creta"): this schema stores judgment
-- OUTPUTS and their PROVENANCE only. The judgment LOGIC (weights, prompts,
-- signal mix, thresholds, causes, disqualifiers, levers) lives in the versioned
-- `judgment_config` artifact and NEVER in columns interrogated by queries.
--
-- Storage decisions (plan §4):
--   * Evidence atoms  → REUSE field_evidence (append-only); namespaces in the
--                       `field` column: 'footprint:*', 'signal_a:*', 'signal_b:*',
--                       'verdict:snapshot'. No new evidence table.
--   * Roll-up sections→ JSONB columns on `companies` (a PURE PROJECTION of the
--                       latest atoms per (company, section) — never edited apart).
--   * Freshness/TTL   → REUSE enrichment_cache.
--   * A/B separation  → two physically separate columns + two field_evidence
--                       namespaces. No column ever fuses the axes.
-- ============================================================================

-- ---- Roll-up sections on companies (append-only ADD COLUMN) -----------------
alter table companies add column if not exists footprint           jsonb;  -- L2 discovery (3-state/surface)
alter table companies add column if not exists segnali_a            jsonb;  -- L3a third-party signals (SEPARATE)
alter table companies add column if not exists segnali_b            jsonb;  -- L3b owned-channel signals (SEPARATE)
alter table companies add column if not exists valutazione_a        jsonb;  -- L4 axis-A assessment (intrinsic strength)
alter table companies add column if not exists valutazione_b        jsonb;  -- L4 axis-B assessment (self-expression)
alter table companies add column if not exists contesto_categoria   jsonb;  -- category benchmark used for this verdict
alter table companies add column if not exists verdetto_gap         jsonb;  -- L4 quadrant/gap/cause/disqualifiers/target
alter table companies add column if not exists leva                 jsonb;  -- L4 intervention lever(s) + sequence
alter table companies add column if not exists validazione          jsonb;  -- L5 agentic validation score + human gate
alter table companies add column if not exists judgment_meta        jsonb;  -- ontology/config/prompt/model versions + timestamps

-- Cheap "qualified targets" listing without scanning blobs.
create index if not exists companies_target_idx on companies(tenant_id)
  where (verdetto_gap->>'target') = 'yes';

-- Make the evidence_log slice (per company, per judgment namespace) cheap.
create index if not exists field_evidence_company_field_idx on field_evidence(company_id, field);

-- ---- CRETA as DATA (reproducibility) — NOT logic-in-query -------------------
-- The ACTIVE judgment_config is a versioned file artifact loaded by L4. This
-- table keeps an append-only SNAPSHOT of each version purely so a past verdict
-- can be reproduced. No query ever reads weights/thresholds from here to make a
-- decision; it is an audit/repro ledger.
create table if not exists judgment_config_versions (
  version          text primary key,            -- e.g. '2026.06-a'
  ontology_version text not null,               -- e.g. 'v2'
  blob             jsonb not null,              -- full config snapshot (rubrics, weights, prompts, taxonomies)
  created_at       timestamptz not null default now()
);

-- ---- Job kinds note --------------------------------------------------------
-- `enrichment_jobs.kind` is a free `text` column in 0001 (no CHECK constraint),
-- so the new kinds are accepted with NO DDL change:
--   'discovery' | 'collect_signals' | 'judge' | 'validate_export'
-- (alongside the existing 'scrape_run' | 'enrich_fields'). Enforcement of the
-- allowed set stays in app code (api/types.ts), preserving the append-only,
-- migration-free extension contract.

-- RLS: every column added above lives on `companies`, already covered by the
-- tenant_isolation policy from 0001. `judgment_config_versions` is global config
-- metadata (not tenant-scoped data): leave RLS off; it holds no tenant rows.
