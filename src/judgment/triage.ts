import type { Lead } from '../types/lead';
import type { JudgmentConfig } from './config/types';

/**
 * §16 two-stage funnel — Stage-0 cheap triage. DETERMINISTIC, uses ONLY data
 * already on the lead (no scraping, no LLM). Drops companies that are near-certain
 * non-targets BEFORE the expensive L3 collection + L4 judging. Applies the
 * §4.5 disqualifier subset marked `cheaplyCheckable`. CONSERVATIVE: a drop must
 * be a clear knock-out, never a borderline judgment (else it re-creates the
 * single-axis false-negative the system exists to avoid).
 */

export interface TriageResult {
  pass: boolean;
  /** disqualifier id from §4.5 when dropped */
  disqualifier?: string;
  reason?: string;
}

export function triage(lead: Lead, config: JudgmentConfig): TriageResult {
  const cheap = new Set(config.gap.disqualifiers.filter((d) => d.cheaplyCheckable).map((d) => d.id));

  if (cheap.has('permanently_closed') && lead.permanently_closed === true) {
    return { pass: false, disqualifier: 'permanently_closed', reason: 'attività cessata' };
  }

  const cat = `${(lead.category as string | undefined) ?? ''}`.toLowerCase();
  if (cheap.has('pure_reseller') && /rivendit|dropship|intermediazion|grossist/.test(cat)) {
    return { pass: false, disqualifier: 'pure_reseller', reason: 'puro arbitraggio/rivendita senza marca' };
  }

  // no resolvable identity at all → nothing to judge (parcheggia, motivo esplicito).
  const hasIdentity =
    !!(lead.official_website || lead.website || lead.vat_code_final || lead.vat_code || lead.company_name);
  if (!hasIdentity) {
    return { pass: false, disqualifier: 'no_identity', reason: 'nessuna identità risolvibile (no sito/VAT/nome)' };
  }

  return { pass: true };
}
