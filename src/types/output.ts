/**
 * Canonical taxonomy of statuses, reason codes, and discovery methods.
 * All values are typed `const` so the compiler catches typos.
 */

export const LeadStatus = {
  FOUND_COMPLETE: 'FOUND_COMPLETE',
  FOUND_WEBSITE_ONLY: 'FOUND_WEBSITE_ONLY',
  ENRICHMENT_ONLY_NO_WEBSITE: 'ENRICHMENT_ONLY_NO_WEBSITE',
  NOT_FOUND: 'NOT_FOUND',
  ERROR: 'ERROR',
  SKIPPED: 'SKIPPED',
} as const;

export type LeadStatus = (typeof LeadStatus)[keyof typeof LeadStatus];

export const ReasonCode = {
  // Success
  FOUND_COMPLETE: 'FOUND_COMPLETE',
  FOUND_WEBSITE_ONLY: 'FOUND_WEBSITE_ONLY',
  ENRICHMENT_ONLY_NO_WEBSITE: 'ENRICHMENT_ONLY_NO_WEBSITE',
  OK_LIKELY_NAME_CITY_MATCH: 'OK_LIKELY_NAME_CITY_MATCH',

  // Input quality
  INPUT_QUALITY_TOO_LOW: 'INPUT_QUALITY_TOO_LOW',
  ERROR_INVALID_INPUT_ROW: 'ERROR_INVALID_INPUT_ROW',

  // Discovery exhausted
  DISCOVERY_EXHAUSTED: 'DISCOVERY_EXHAUSTED',
  DISCOVERY_EXHAUSTED_BLEEDING_MODE: 'DISCOVERY_EXHAUSTED_BLEEDING_MODE',
  NOT_FOUND_NO_CANDIDATES: 'NOT_FOUND_NO_CANDIDATES',

  // URL classification rejection
  INPUT_WEBSITE_INVALID: 'INPUT_WEBSITE_INVALID',
  INPUT_WEBSITE_DIRECTORY_OR_SOCIAL: 'INPUT_WEBSITE_DIRECTORY_OR_SOCIAL',
  INPUT_WEBSITE_MESSAGING_OR_REDIRECT: 'INPUT_WEBSITE_MESSAGING_OR_REDIRECT',
  REJECTED_DIRECTORY: 'REJECTED_DIRECTORY',

  // Verification failed
  INPUT_WEBSITE_TIMEOUT: 'INPUT_WEBSITE_TIMEOUT',
  INPUT_WEBSITE_NOT_VERIFIED: 'INPUT_WEBSITE_NOT_VERIFIED',
  PHONE_ENTITY_TIMEOUT: 'PHONE_ENTITY_TIMEOUT',
  PHONE_ENTITY_NOT_VERIFIED: 'PHONE_ENTITY_NOT_VERIFIED',
  PHONE_ENTITY_DIRECTORY_ONLY: 'PHONE_ENTITY_DIRECTORY_ONLY',

  // Network / blocking
  ERROR_TIMEOUT_FETCH: 'ERROR_TIMEOUT_FETCH',
  ERROR_BLOCKED_403: 'ERROR_BLOCKED_403',
  ERROR_DNS: 'ERROR_DNS',
  ERROR_PROVIDER_RATE_LIMIT: 'ERROR_PROVIDER_RATE_LIMIT',
  ERROR_FETCH: 'ERROR_FETCH',

  // Phase 4.5 (Phase D) — SerpStage reason-code split, replacing the
  // single REJECTED_DIRECTORY catch-all with operator-actionable signals.
  // REJECTED_DIRECTORY is preserved for back-compat (still emitted by the
  // shared content_filter when the input website itself is a directory).
  SERP_EMPTY_ALL_PROVIDERS: 'SERP_EMPTY_ALL_PROVIDERS',
  SERP_DIRECTORY_ONLY: 'SERP_DIRECTORY_ONLY',
  SERP_REJECTED_BY_VERIFY: 'SERP_REJECTED_BY_VERIFY',

  // Phase D — semantic gate rejection sub-reasons. Surfaced when
  // PreVerifyGate refuses a candidate that would have been accepted by
  // the previous (looser) version. Each reason maps to an audit pattern.
  SEMANTIC_REJECTED_COMMON_STEM: 'SEMANTIC_REJECTED_COMMON_STEM',
  SEMANTIC_REJECTED_MISSING_CITY: 'SEMANTIC_REJECTED_MISSING_CITY',
  SEMANTIC_REJECTED_SECTOR_CONFLICT: 'SEMANTIC_REJECTED_SECTOR_CONFLICT',
  SEMANTIC_REJECTED_TINY_OR_PARKED: 'SEMANTIC_REJECTED_TINY_OR_PARKED',
  SEMANTIC_REJECTED_RDAP_MISMATCH: 'SEMANTIC_REJECTED_RDAP_MISMATCH',
  SEMANTIC_REJECTED_NO_DISTINCTIVE_TOKENS: 'SEMANTIC_REJECTED_NO_DISTINCTIVE_TOKENS',

  // Phase C.4 — Maps marked the business "Chiuso definitivamente"; enrich
  // skips it by default (--include-closed overrides). The row is still
  // written (status SKIPPED) so CSV/JSONL row parity holds.
  SKIPPED_PERMANENTLY_CLOSED: 'SKIPPED_PERMANENTLY_CLOSED',

  // Phase D.1 — lead matched the operator's suppression list (GDPR
  // right-to-objection / do-not-contact). Dropped from outputs entirely;
  // counted in the run summary.
  SUPPRESSED: 'SUPPRESSED',

  // Internal
  ERROR_INTERNAL: 'ERROR_INTERNAL',
} as const;

export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

export const DiscoveryMethod = {
  INPUT_VERIFIED: 'INPUT_VERIFIED',
  INPUT_PIVA_MATCH: 'INPUT_PIVA_MATCH',
  INPUT_SEMANTIC: 'INPUT_SEMANTIC',
  /** Input website accepted because a distinctive company-name token is embedded
   *  in its registrable domain (content-verify failed). Free, flag-gated. */
  INPUT_DOMAIN_NAME_MATCH: 'INPUT_DOMAIN_NAME_MATCH',
  PG_PHONE_SOURCE_TRUST: 'PG_PHONE_SOURCE_TRUST',
  EMAIL_DOMAIN: 'EMAIL_DOMAIN',
  HYPER_GUESSER: 'HYPER_GUESSER',
  SERP_PIVA_SNIPPET: 'SERP_PIVA_SNIPPET',
  SERP_COMPANY: 'SERP_COMPANY',
  SERP_REGISTRY: 'SERP_REGISTRY',
  SERP_PAID: 'SERP_PAID',
  RDAP_BINGO: 'RDAP_BINGO',
  RDAP_NAME_MATCH: 'RDAP_NAME_MATCH',
  BEST_LOSER_RESCUE: 'BEST_LOSER_RESCUE',
  LLM_ORACLE_SEMANTIC: 'LLM_ORACLE_SEMANTIC',
  MAPS_APIFY: 'MAPS_APIFY',
  PERPLEXITY_RESOLVED: 'PERPLEXITY_RESOLVED',
} as const;

export type DiscoveryMethod = (typeof DiscoveryMethod)[keyof typeof DiscoveryMethod];

/** Per-stage outcome carried in JSONL for full debug observability. */
export interface StageOutcome {
  stage: string;
  status: 'success' | 'not_found' | 'skipped' | 'error';
  duration_ms: number;
  reason_code?: ReasonCode;
  detail?: string;
  evidence_count?: number;
  cost_eur?: number;
  provider?: string;
}

/** Structured error attached to a lead when something fails. */
export interface LeadError {
  stage: string;
  message: string;
  provider?: string;
  reason_code?: ReasonCode;
}
