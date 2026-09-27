import type { LeadStatus, ReasonCode, DiscoveryMethod, StageOutcome, LeadError } from './output';
import type { FinancialSource } from '../enrichment/financial/financial_types';

/**
 * The single canonical Lead shape. Raw fields populated by the scraper;
 * enriched fields populated by the enricher. Every enriched field is optional.
 *
 * No parallel `RawLead` vs `EnrichedLead` types — there is one Lead type and
 * its fullness is a function of which stages have run.
 */
export interface Lead {
  // ---- Identity (raw) ----
  company_name: string;
  category?: string;

  // ---- Address (raw) ----
  city?: string;
  province?: string; // 2-letter code (MI, RM, ...)
  region?: string;
  zip_code?: string;
  address?: string;

  // ---- Contact (raw, may be enriched) ----
  phone?: string;
  /** Phase C.2 — the phone exactly as scraped, before E.164 normalization. */
  phone_raw?: string;
  email?: string;
  website?: string;
  vat_code?: string; // P.IVA (11 digits)

  // ---- Source provenance (raw) ----
  source?: string; // 'PG' | 'MAPS' | 'INPUT_CSV' | 'IMMOBILIARE' (primary)
  /**
   * All sources that contributed to this record. Phase 3.7 audit found
   * pg3 collapsed multi-source records into a single delimited string
   * (e.g. `"PG + Maps"`); pg4 keeps the structured array and joins on
   * CSV serialization.
   */
  sources?: string[];
  source_url?: string;
  pg_url?: string;
  maps_url?: string;
  confidence?: number; // 0..1 — raw discovery confidence (scraper)
  discovery_notes?: string;
  /**
   * The query under which this record was scraped (e.g. comune used in
   * the PG search URL). pg3 confused this with `city` — many records
   * carried the query comune even when the parsed business city was
   * different, leading to under-deduplication across queries. pg4 keeps
   * the two distinct.
   */
  query_location?: string;
  /**
   * Optional business-city alias when the parser is confident the
   * card's address is in a city different from the query location.
   */
  business_city?: string;
  /**
   * Maps-specific: signals the feed query likely hit the ~120 result
   * cap and may be incomplete. The orchestrator should split the query
   * into smaller geo grids when this is true.
   */
  cap_likely?: boolean;
  /**
   * Whether the Maps card type-string matches the requested category.
   *  - 'confirmed' → the card's category-tag span matches an expected token
   *  - 'unknown'   → no category-tag span present
   *  - 'mismatch'  → card present, but its tag does NOT match the requested
   *                  category (kept, not silently dropped, but flagged)
   */
  category_match?: 'confirmed' | 'unknown' | 'mismatch';
  /**
   * Phase C.4 — Maps marks businesses as "Chiuso definitivamente" in the
   * card status span. Captured at parse time; enrich skips these leads by
   * default (`--include-closed` overrides).
   */
  permanently_closed?: boolean;
  /** Phase C.1 — stamped on every output row. */
  _schema_version?: number;

  // ---- Enrichment fields (all optional) ----
  status?: LeadStatus;
  reason_code?: ReasonCode;

  official_website?: string;
  website_confidence?: number; // 0..1
  website_discovery_method?: DiscoveryMethod;

  vat_code_final?: string;

  pec?: string;
  email_inferred?: string;
  email_type?: 'pec' | 'business' | 'public' | 'unknown';

  /**
   * Phase 1 (free-gold, schema v2) — social profile URLs mined from the
   * firm's already-fetched website footer at zero marginal cost.
   */
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  /** Schema v3 — extra socials + reputation, mined free from JSON-LD/body. */
  tiktok?: string;
  youtube?: string;
  /** schema.org aggregateRating — reputation signal (judgment A-axis). */
  rating?: string;
  reviews_count?: string;
  /** schema.org foundingDate year — firmographic. */
  founding_year?: string;

  revenue?: string;
  revenue_year?: string;
  employees?: string;
  employees_is_estimated?: boolean;

  /**
   * Schema v4 — Italian business-register firmographics (Apify regdata, by
   * P.IVA). `net_profit` is utile (NET PROFIT), deliberately distinct from
   * `revenue` (fatturato) which it must never be confused with.
   */
  net_profit?: string;
  net_profit_year?: string;
  share_capital?: string;
  legal_form?: string;
  ateco?: string;
  rea?: string;

  /**
   * R13.1 — financial provenance. Every financial field above is paired
   * with WHERE it came from and HOW confident we are, so the operator can
   * audit any number. Populated by `FinancialStage`. In R13.1 safe mode
   * the only source is `'input'` (a checksum-valid P.IVA promoted to
   * `vat_code_final`); later phases add `fatturatoitalia` / `vies`.
   */
  financial_source?: FinancialSource;
  financial_confidence?: number; // 0..1
  /** Number of individual evidence records in the provenance trail. */
  financial_evidence_count?: number;
  /** Compact, human-readable provenance trail (e.g. "vat:italian_piva_checksum_ok"). */
  financial_notes?: string;

  decision_maker_name?: string;
  decision_maker_role?: string;
  decision_maker_linkedin?: string;

  lead_score?: number; // 0..1 final composite score

  /**
   * Schema v5 (ENRICH-3) — email deliverability verdict. Set by the
   * email-verify pass; a run-style field (recomputed, not fill-only) so a
   * re-verify can change it. `invalid` never deletes `email_inferred`
   * (non-destructive) — consumers filter on this column instead.
   */
  email_status?: 'deliverable' | 'catch_all' | 'invalid' | 'unknown' | 'pec';
  /**
   * Schema v5 (ENRICH-3) — real-estate portal signals, joined OFFLINE from
   * bulk per-province portal scrapes by phone/name key. Portal URLs are
   * directories and never become official_website; these columns carry the
   * portal-only facts. `portal_source` lists the portals that contributed
   * ≥1 field (';'-joined).
   */
  portal_source?: string;
  portal_listings_count?: string;
  portal_is_paid?: string; // 'true' | 'false' — paid/premium subscription on the portal
  portal_fiaip?: string; // 'true' | 'false' — FIAIP membership per the portal

  // ---- Run metadata ----
  cost_eur?: number;
  duration_ms?: number;
  providers_used?: string[];
  errors?: LeadError[];
  stage_outcomes?: Record<string, StageOutcome>;

  // ---- Catch-all for raw CSV columns we don't enumerate ----
  [extra: string]: unknown;
}

/**
 * Phase C.1 — output schema version, stamped as the LAST column of every
 * CSV row and as `_schema_version` in every JSONL line. Bump when columns
 * are appended so downstream consumers can detect capability without
 * sniffing headers.
 *
 * Version history:
 *   1 — adds _schema_version itself, phone_raw, permanently_closed
 *       (everything before v1 is the unversioned pre-June-2026 layout).
 *   2 — adds instagram, facebook, linkedin (Phase 1 free-gold body mining).
 *   3 — adds tiktok, youtube, rating, reviews_count, founding_year
 *       (JSON-LD sameAs/aggregateRating + Open Graph extraction).
 *   4 — adds net_profit, net_profit_year, share_capital, legal_form, ateco,
 *       rea (Apify regdata Italian business-register firmographics by P.IVA).
 *   5 — adds email_status, portal_source, portal_listings_count,
 *       portal_is_paid, portal_fiaip (ENRICH-3: email deliverability +
 *       real-estate portal join).
 */
export const SCHEMA_VERSION = 5;

/**
 * The original (pre-versioning) raw column set. Frozen — appending here
 * would INSERT columns in the middle of the enriched CSV (which spreads
 * this array first). New raw-side columns go in APPENDED_COLUMNS_V1.
 */
const RAW_BASE_COLUMNS = [
  'company_name',
  'category',
  'city',
  'province',
  'region',
  'address',
  'phone',
  'website',
  'source',
  'source_url',
  'pg_url',
  'maps_url',
  'vat_code',
  'confidence',
  'discovery_notes',
  'query_location',
  'business_city',
  'category_match',
] as const;

/**
 * The original enriched-only column set (Phase 1 + R13.1). Frozen for the
 * same reason as RAW_BASE_COLUMNS.
 */
const ENRICHED_BASE_COLUMNS = [
  'status',
  'reason_code',
  'official_website',
  'website_confidence',
  'website_discovery_method',
  'vat_code_final',
  'pec',
  'email_inferred',
  'email_type',
  'revenue',
  'revenue_year',
  'employees',
  'employees_is_estimated',
  'decision_maker_name',
  'decision_maker_role',
  'decision_maker_linkedin',
  'lead_score',
  'cost_eur',
  'duration_ms',
  'providers_used',
  'errors',
  // R13.1 — APPENDED ONLY (never reorder the columns above). Financial
  // provenance trails the existing enriched columns so older readers that
  // index by position are unaffected.
  'financial_source',
  'financial_confidence',
  'financial_evidence_count',
  'financial_notes',
] as const;

/**
 * Phase C — columns appended in schema v1. They trail BOTH flavors so
 * positional readers of either CSV are unaffected:
 *   raw      = RAW_BASE + V1
 *   enriched = RAW_BASE + ENRICHED_BASE + V1
 * (Appending to RAW_BASE directly would shift every enriched column —
 * that is why the bases are frozen and additions live here.)
 */
const APPENDED_COLUMNS_V1 = [
  'phone_raw',
  'permanently_closed',
  '_schema_version',
] as const;

/**
 * Phase 1 (schema v2) — social columns appended AFTER the v1 appendix on
 * the enriched flavor only (they are enrichment output, never raw scrape).
 * Trailing position keeps positional readers of v1 outputs unaffected.
 */
const APPENDED_COLUMNS_V2 = [
  'instagram',
  'facebook',
  'linkedin',
] as const;

/** Schema v3 — extra socials + reputation + firmographic (JSON-LD/OG mining). */
const APPENDED_COLUMNS_V3 = [
  'tiktok',
  'youtube',
  'rating',
  'reviews_count',
  'founding_year',
] as const;

/** Schema v4 — Italian business-register firmographics (Apify regdata by P.IVA). */
const APPENDED_COLUMNS_V4 = [
  'net_profit',
  'net_profit_year',
  'share_capital',
  'legal_form',
  'ateco',
  'rea',
] as const;

/** Schema v5 — ENRICH-3: email deliverability + portal-join signals. */
const APPENDED_COLUMNS_V5 = [
  'email_status',
  'portal_source',
  'portal_listings_count',
  'portal_is_paid',
  'portal_fiaip',
] as const;

/**
 * Stable column order for the RAW CSV emitted by the scraper.
 * Phase 3.7 extended with `query_location`, `business_city`, and
 * `category_match` for cross-query dedupe and off-category flagging.
 * (No v2 social columns here — they are enrichment-only.)
 */
export const RAW_CSV_COLUMNS = [...RAW_BASE_COLUMNS, ...APPENDED_COLUMNS_V1] as const;

/**
 * Stable column order for the ENRICHED CSV emitted by the enricher.
 * Includes all RAW base columns plus enriched fields plus the v1 + v2
 * appendices. Locked from Phase 1; append-only via APPENDED_COLUMNS_V*.
 */
export const ENRICHED_CSV_COLUMNS = [
  ...RAW_BASE_COLUMNS,
  ...ENRICHED_BASE_COLUMNS,
  ...APPENDED_COLUMNS_V1,
  ...APPENDED_COLUMNS_V2,
  ...APPENDED_COLUMNS_V3,
  ...APPENDED_COLUMNS_V4,
  ...APPENDED_COLUMNS_V5,
] as const;

export type RawCsvColumn = (typeof RAW_CSV_COLUMNS)[number];
export type EnrichedCsvColumn = (typeof ENRICHED_CSV_COLUMNS)[number];
