import type { Lead } from '../types/lead';
import { has } from '../util/values';

/**
 * Composite lead quality score (0..1). Single source for the `lead_score`
 * column.
 *
 * Semantics: contactability + qualification signal for outreach. Fixed
 * weights summing to 1.0; a MISSING component contributes 0 (no
 * renormalization) — a lead with more verified data must monotonically
 * outscore a thinner one, so scores stay comparable across the whole list.
 *
 * Recomputed on every run (a run-style field like status/cost_eur, NOT
 * fill-only-empty): enrichment that adds data or a verify that downgrades
 * an email must move the score.
 *
 * Weights:
 *   email 0.30 (× deliverability factor) · website 0.15 · firmographics 0.15
 *   phone 0.10 · reputation 0.10 · social 0.10 · pec 0.05 · portal 0.05
 */

const EMAIL_STATUS_FACTOR: Record<NonNullable<Lead['email_status']>, number> = {
  deliverable: 1.0,
  pec: 0.9,
  unknown: 0.5,
  catch_all: 0.55,
  invalid: 0.05,
};


/**
 * Parse the first number in an Italian- or English-formatted string:
 * "4,7" / "4.7" → 4.7 · "1.234" / "1.234.567" → thousands · "1.234,5" → 1234.5
 * · "(1.234 recensioni)" → 1234. No digit at all ("N/A", "—") → undefined, so
 * a placeholder never earns credit as if it were a real 0.
 */
export function parseNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const token = v.match(/-?(?:\d[\d.,]*|[.,]\d+)/)?.[0].replace(/[.,]$/, '');
  if (!token) return undefined;
  let normalized: string;
  if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(token)) normalized = token.replace(/\./g, '').replace(',', '.'); // IT thousands
  else if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token)) normalized = token.replace(/,/g, ''); // EN thousands
  else normalized = token.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export function computeLeadScore(lead: Partial<Lead>): number {
  // ---- email 0.30 — presence × deliverability factor ----
  const emailVal = has(lead.email_inferred) ? lead.email_inferred : lead.email;
  let email = 0;
  if (has(emailVal)) {
    email = EMAIL_STATUS_FACTOR[lead.email_status ?? 'unknown'] ?? EMAIL_STATUS_FACTOR.unknown;
  }

  // ---- website 0.15 — verified site full credit, unverified input 0.4 ----
  const website = has(lead.official_website) ? 1 : has(lead.website) ? 0.4 : 0;

  // ---- firmographics 0.15 — four equal quarters ----
  const firmo =
    0.25 * (has(lead.vat_code_final) ? 1 : 0) +
    0.25 * (has(lead.revenue) ? 1 : 0) +
    0.25 * (has(lead.employees) || has(lead.share_capital) || has(lead.legal_form) ? 1 : 0) +
    0.25 * (has(lead.decision_maker_name) ? 1 : 0);

  // ---- phone 0.10 ----
  const phone = has(lead.phone) ? 1 : 0;

  // ---- reputation 0.10 — rating quality dampened by review volume ----
  // Base 0.3 for merely having a rating; quality ramps 3★→5★; volume ramps
  // log10 so 10 reviews ≈ half credit, 100+ ≈ full.
  let reputation = 0;
  const rating = parseNum(lead.rating);
  if (rating !== undefined && rating >= 0 && rating <= 5) {
    const reviews = parseNum(lead.reviews_count) ?? 0;
    reputation = 0.3 + 0.7 * clamp01((rating - 3) / 2) * Math.min(1, Math.log10(1 + reviews) / 2);
  }

  // ---- social 0.10 — 3 distinct channels = full credit ----
  const socialCount = [lead.instagram, lead.facebook, lead.linkedin, lead.tiktok, lead.youtube].filter(has).length;
  const social = Math.min(3, socialCount) / 3;

  // ---- pec 0.05 ----
  const pec = has(lead.pec) ? 1 : 0;

  // ---- portal activity 0.05 — listings volume + premium + FIAIP ----
  const listings = parseNum(lead.portal_listings_count);
  const portal =
    0.5 * (listings !== undefined ? Math.min(1, Math.log10(1 + listings) / 2) : 0) +
    0.25 * (lead.portal_is_paid === 'true' ? 1 : 0) +
    0.25 * (lead.portal_fiaip === 'true' ? 1 : 0);

  const score =
    0.3 * email + 0.15 * website + 0.15 * firmo + 0.1 * phone + 0.1 * reputation + 0.1 * social + 0.05 * pec + 0.05 * portal;
  return Math.round(clamp01(score) * 1000) / 1000;
}

/**
 * Leads sorted by descending score (stable), optionally truncated to `top`.
 * Scores are computed ONCE per lead — never inside the sort comparator.
 */
export function rankByLeadScore<T extends Partial<Lead>>(leads: readonly T[], top?: number): T[] {
  const ranked = leads
    .map((lead, i) => ({ lead, i, score: computeLeadScore(lead) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.lead);
  return top !== undefined && top > 0 ? ranked.slice(0, top) : ranked;
}
