/**
 * R13 — financial enrichment provenance contract.
 *
 * Every financial field pg4 emits must carry WHERE it came from and HOW
 * confident we are. pg3 stored bare strings (`revenue?: string`) with the
 * source buried in a free-text `source` field; pg4 makes provenance a
 * first-class, structured concern so the operator can audit any number.
 *
 * These types are PURE — no runtime, no network. They are the shared shape
 * for the pure parsers (`vat`, `revenue_parser`, `fatturato_italia_parser`)
 * and the (disabled-by-default) `financial_stage`.
 */

/**
 * Where a financial signal originated. Ordered loosely by trust:
 * an authoritative directory/registry > website self-declaration >
 * SERP snippet > heuristic estimate.
 */
export type FinancialSource =
  | 'input' // came in on the source CSV/row
  | 'website' // scraped from the company's own site
  | 'fatturatoitalia' // fatturatoitalia.it company page
  | 'registroimprese' // official business registry
  | 'serp' // search-result snippet
  | 'vies' // EU VIES VAT validation
  | 'estimate' // heuristic / LLM estimate (never authoritative)
  | 'unknown';

/** Trust banding for a source, mirroring pg3's `source_trust`. */
export type FinancialSourceTrust = 'high' | 'medium' | 'low';

/**
 * One provenance record. A `FinancialResult` carries an array of these so
 * each field (revenue, vat, employees) can point at the exact match that
 * produced it.
 */
export interface FinancialEvidence {
  /** Which field this evidence supports. */
  field: 'vat_code' | 'revenue' | 'revenue_year' | 'employees' | 'utile' | 'company_name';
  source: FinancialSource;
  /** 0..1 confidence that this evidence is correct for this company. */
  confidence: number;
  /** Page/document URL when known. */
  source_url?: string;
  /** Trust band of the source, when computed. */
  source_trust?: FinancialSourceTrust;
  /** The raw matched text, kept verbatim for audit. */
  raw?: string;
  /** Optional human-readable note. */
  detail?: string;
}

/**
 * The fused financial result for a single company. Mirrors the optional
 * `Lead` financial fields (`vat_code_final`, `revenue`, `revenue_year`,
 * `employees`, `employees_is_estimated`) and adds the provenance contract.
 *
 * Invariant: an absent signal is `undefined`, never a thrown error. A
 * result with no signal at all is still a valid, empty `FinancialResult`.
 */
export interface FinancialResult {
  /** Normalized 11-digit P.IVA that passed checksum (and later VIES). */
  vat_code_final?: string;
  /** Display form, e.g. "€ 1.500.000". */
  revenue?: string;
  /** Numeric EUR when parseable. */
  revenue_amount?: number;
  /** Bilancio year, e.g. "2023". */
  revenue_year?: string;
  /** Headcount or band, e.g. "12" or "10-20". */
  employees?: string;
  /** True only for heuristic/LLM estimates. */
  employees_is_estimated?: boolean;
  /** The source that "won" for the headline fields. */
  financial_source?: FinancialSource;
  /** 0..1 confidence of the chosen result. */
  financial_confidence?: number;
  /** Non-fatal notes (e.g. "vies_unreachable"). Never breaks lead output. */
  financial_errors?: string[];
  /** Per-field provenance trail. */
  evidence: FinancialEvidence[];
}

/** A fresh, empty result. Helper so callers never hand-build `{ evidence: [] }`. */
export function emptyFinancialResult(): FinancialResult {
  return { evidence: [] };
}
