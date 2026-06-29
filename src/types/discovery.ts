import type { Lead } from './lead';

/**
 * Normalized version of a Lead's input fields, ready for the discovery
 * ladder. Produced by `discovery/input_normalizer.ts`.
 */
export interface NormalizedLead {
  company_name: string;
  company_name_variants: string[];
  city?: string;
  province?: string;
  address?: string;
  phone?: string;
  email?: string;
  email_source?: 'input' | 'paginegialle';
  email_domain?: string;
  website?: string;
  vat_code?: string;
  quality_score: number; // 0..1
  raw: Lead; // back-pointer to the original row
}

/** What InputWebsiteCandidate.assess returns. */
export type WebsiteClassification = 'VALID' | 'INVALID' | 'DIRECTORY_OR_SOCIAL' | 'MESSAGING_OR_REDIRECT';

export interface AssessedWebsite {
  classification: WebsiteClassification;
  normalized_url?: string;
  candidates: string[];
  reason_code?: string;
}

/** Result of a single PreVerifyGate check. */
export type GateStatus = 'VERIFIED' | 'VERIFIED_SEMANTIC' | 'NEEDS_BROWSER' | 'REJECTED';

export interface GateResult {
  status: GateStatus;
  url: string;
  evidence?:
    | 'piva_match'
    | 'phone_match'
    | 'name_semantic'
    | 'title_match'
    | 'strong_full_name'
    | 'strong_brand'
    | 'multi_token_anchor';
  detail?: string;
}
