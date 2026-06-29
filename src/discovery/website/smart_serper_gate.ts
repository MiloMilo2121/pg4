import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';
import { isCommonBareStem } from './semantic_evidence';
import { buildCompanyQueries, type QueryVariant } from './query_variants';

/**
 * R4 — SmartSerperGate.
 *
 * Decides whether a lead has earned a paid SERP call. The contract is
 * SIGNAL-BASED, not budget-based: budget is enforced separately by
 * `ProviderRouter` (per-lead cap + run-level cap with atomic
 * reservation, both already in place after G.1). This module is the
 * EARLIER veto layer — "Serper deve diventare un bisturi, non una rete
 * da pesca".
 *
 * Rules (priority order):
 *
 *   DENY if the company name reduces to a `COMMON_BARE_STEM` audit
 *     entry — these are single-token homonym-prone names (`bloom`,
 *     `master`, `area`, `europa`, …) that systematically produce FPs
 *     even when corroborating signals look strong. The audit denylist
 *     is the cheapest surgical filter we have for that family.
 *
 *   DENY if the lead has NO deterministic signal beyond the name —
 *     no vat_code, no phone (≥8 digits), no email domain, no pg_url,
 *     no address-with-locality. A name-only paid SERP call dominantly
 *     returns global homonyms; pg3 fired these and bled budget on
 *     "Camelot Sas" / "Fusion S.a.s." style queries.
 *
 *   ALLOW otherwise. The decision returns the subset of R2 query
 *     variants the lead actually has signal for, ordered by priority.
 *     The caller picks the top-N (default 1, configurable).
 *
 * The gate is PURE: no I/O, no router calls, no side effects. Tests
 * stay 0-network.
 */

export type SerperGateSignal =
  | 'vat'
  | 'phone'
  | 'email_domain'
  | 'pg_url'
  | 'address_with_locality';

export interface SerperGateDecision {
  /** Final verdict — true = paid SERP earned, false = skip paid pass. */
  allow: boolean;
  /** Human-readable trail (used in logs, ledger, audit reports). */
  reasons: string[];
  /** Which positive signals were observed (subset; informational). */
  signals: SerperGateSignal[];
  /** R2 variants compatible with the signals available. Empty when allow=false. */
  recommendedQueries: QueryVariant[];
}

export interface SmartSerperGateOpts {
  /**
   * Max number of variants to surface in `recommendedQueries`. The
   * caller decides how many to actually fire — having a small bounded
   * list lets the SerpStage stay simple while leaving the door open
   * for parallel paid queries later (R6 benchmark may want this).
   * Default 3.
   */
  maxQueries?: number;
}

/**
 * Run the gate for one lead. Pure function — `lead` is read-only.
 */
export function evaluateSerperGate(
  normalized: NormalizedLead,
  lead: Lead,
  opts: SmartSerperGateOpts = {},
): SerperGateDecision {
  const reasons: string[] = [];
  const signals: SerperGateSignal[] = [];

  // ---- Signal probe -------------------------------------------------------
  const vat = (normalized.vat_code ?? lead.vat_code ?? '').replace(/\D/g, '');
  const hasVat = vat.length === 11;

  const phoneDigits = (normalized.phone ?? lead.phone ?? '').replace(/\D/g, '');
  const hasPhone = phoneDigits.length >= 8;

  const emailDomain =
    normalized.email_domain ??
    extractDomainFromEmail(normalized.email ?? lead.email);
  const hasEmailDomain = !!emailDomain && emailDomain.length > 0;

  const pgUrl = (lead.pg_url ?? '').trim();
  const hasPgUrl = pgUrl.length > 0;

  const street = (normalized.address ?? lead.address ?? '').split(',')[0]?.trim() ?? '';
  const hasLocality = !!(normalized.city || normalized.province);
  const hasAddrLocality = street.length >= 6 && hasLocality;

  if (hasVat) signals.push('vat');
  if (hasPhone) signals.push('phone');
  if (hasEmailDomain) signals.push('email_domain');
  if (hasPgUrl) signals.push('pg_url');
  if (hasAddrLocality) signals.push('address_with_locality');

  // ---- Veto: common bare stem --------------------------------------------
  // Use the same denylist PreVerifyGate uses. A lead whose distinctive
  // brand token is a known FP-prone stem doesn't get to spend paid
  // budget — even with corroborating signals, the audit history says
  // these systematically produce FPs.
  const compactStem = compactDistinctiveStem(normalized.company_name);
  if (compactStem && isCommonBareStem(compactStem)) {
    reasons.push(`deny:common_bare_stem:${compactStem}`);
    return { allow: false, reasons, signals, recommendedQueries: [] };
  }

  // ---- Veto: no deterministic signal -------------------------------------
  if (signals.length === 0) {
    reasons.push('deny:no_signal_beyond_name');
    return { allow: false, reasons, signals, recommendedQueries: [] };
  }

  // ---- Veto: empty / stop-word-only name ---------------------------------
  // R2 returns [] for those — if the variant builder can't produce a
  // single variant, the gate has nothing to fire.
  const variants = buildCompanyQueries(normalized);
  if (variants.length === 0) {
    reasons.push('deny:name_is_stopwords_only');
    return { allow: false, reasons, signals, recommendedQueries: [] };
  }

  // ---- Filter variants by signal availability ----------------------------
  // R2 already skips variants whose required signal is missing (e.g.
  // no phone → no `phone` variant). We additionally drop the weakest
  // fallbacks (`official`, `fallback_contact`) when stronger vectors
  // exist, on the basis that paid SERP burns money on those generic
  // queries. The bisturi rule.
  const strongVectors = variants.filter(
    (v) => v.vector !== 'official' && v.vector !== 'fallback_contact',
  );
  const recommended = (strongVectors.length > 0 ? strongVectors : variants).slice(
    0,
    opts.maxQueries ?? 3,
  );

  reasons.push(`allow:signals=${signals.join(',')}`);
  return { allow: true, reasons, signals, recommendedQueries: recommended };
}

/* --------------------------- helpers ------------------------------------ */

function extractDomainFromEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at >= email.length - 1) return undefined;
  return email.substring(at + 1).replace(/^www\./i, '').trim().toLowerCase() || undefined;
}

/**
 * Reduce a company name to its compact distinctive stem the same way
 * pg4's PreVerifyGate does — strip legal forms / sector descriptors,
 * concatenate the remaining tokens, lowercased and alphanumeric only.
 *
 * This is intentionally a thin local approximation: the full brand-
 * extraction lives in `semantic_evidence.compactFullName`, but that
 * keeps too much of the legal tail (`agenziaimmobiliarefoo`). Here
 * we only need the ONE distinctive token that drives the bare-stem
 * veto, so we strip a small descriptor set and keep the longest
 * remaining alphanumeric chunk.
 */
function compactDistinctiveStem(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  const stripped = lower.replace(
    /\b(s\.?r\.?l\.?s?|s\.?p\.?a\.?|s\.?n\.?c\.?|s\.?a\.?s\.?|scarl|s\.?c\.?r\.?l\.?|srls?|spa|snc|sas|di|e|il|la|le|i|un|una|da|per|con|su|agenzia|immobiliare|studio|gruppo|impresa|costruzioni|edilizia)\b/gi,
    ' ',
  );
  const tokens = stripped
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return undefined;
  if (tokens.length === 1) return tokens[0];
  // Multi-token brand → no single distinctive stem to veto on. Return
  // undefined so the bare-stem rule doesn't fire (multi-token brands
  // are already specific enough for paid SERP).
  return undefined;
}
