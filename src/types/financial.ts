/**
 * Financial provenance vocabulary shared by the whole codebase.
 *
 * `FinancialSource` used to live in `enrichment/financial/financial_types.ts`,
 * which forced `types/lead.ts` (layer L0) to import from `enrichment/`
 * (layer L2) — an upward edge against the layering enforced in
 * `eslint.config.mjs`. The vocabulary is pure (no runtime, no network), so it
 * belongs here with the other L0 contracts.
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
