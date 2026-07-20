/**
 * Phase 1 (free-gold) — apply the pure body extraction onto a Lead.
 *
 * Discipline (matches PgDetailStage.backfill + FinancialStage): fill ONLY
 * empty fields — input always wins, we never overwrite. Never throws (the
 * caller wraps it too, defence-in-depth). Makes ZERO provider calls, so
 * `lead.cost_eur` and every budget gate are untouched.
 */
import type { Lead } from '../../types/lead';
import { extractFromBody } from './extract_from_body';
import type { BodyExtraction } from './extract_from_body';

export interface FreeGoldResult {
  applied: boolean;
  filled: string[]; // which fields this populated (for observability/tests)
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

/**
 * Apply an already-computed `BodyExtraction` onto a Lead (fill-only-empty).
 * Shared by the single-page pass (`applyFreeGoldExtraction`) and the deepened
 * multipage pass (`deepExtractFromSite` → merged extraction), so both write the
 * lead identically. Pure. Returns the list of fields it populated.
 */
export function applyBodyExtraction(lead: Lead, ex: BodyExtraction): string[] {
  const filled: string[] = [];

  if (isEmpty(lead.email_inferred) && ex.email) {
    lead.email_inferred = ex.email;
    // email_type describes email_inferred: set it, and UPGRADE a 'pec' label
    // left by an earlier PEC-only pass (homepage had only the PEC; the deep
    // pass then found the business address on /contatti).
    if (isEmpty(lead.email_type) || lead.email_type === 'pec') lead.email_type = 'business';
    filled.push('email_inferred');
  }
  if (isEmpty(lead.pec) && ex.pec) {
    lead.pec = ex.pec;
    // Only label the lead's email_type as pec if there is no business email.
    if (isEmpty(lead.email_inferred) && isEmpty(lead.email_type)) lead.email_type = 'pec';
    filled.push('pec');
  }
  if (isEmpty(lead.instagram) && ex.instagram) { lead.instagram = ex.instagram; filled.push('instagram'); }
  if (isEmpty(lead.facebook) && ex.facebook) { lead.facebook = ex.facebook; filled.push('facebook'); }
  if (isEmpty(lead.linkedin) && ex.linkedin) { lead.linkedin = ex.linkedin; filled.push('linkedin'); }
  // Schema v3 — extra socials + reputation + firmographic from JSON-LD/OG (€0).
  if (isEmpty(lead.tiktok) && ex.tiktok) { lead.tiktok = ex.tiktok; filled.push('tiktok'); }
  if (isEmpty(lead.youtube) && ex.youtube) { lead.youtube = ex.youtube; filled.push('youtube'); }
  if (isEmpty(lead.rating) && ex.rating) { lead.rating = ex.rating; filled.push('rating'); }
  if (isEmpty(lead.reviews_count) && ex.reviews_count) { lead.reviews_count = ex.reviews_count; filled.push('reviews_count'); }
  if (isEmpty(lead.founding_year) && ex.founding_year) { lead.founding_year = ex.founding_year; filled.push('founding_year'); }
  // schema.org founder/legalName is a high-precision decision-maker hint.
  if (isEmpty(lead.decision_maker_name) && ex.founder) { lead.decision_maker_name = ex.founder; filled.push('decision_maker_name'); }

  // VAT from the firm's own page is high-quality; promote to vat_code_final
  // only if empty. FinancialStage / VIES later hardens its confidence.
  if (isEmpty(lead.vat_code_final) && ex.vat_candidates.length > 0) {
    lead.vat_code_final = ex.vat_candidates[0];
    filled.push('vat_code_final');
  }

  // Phone: promote only when the lead has none (input phone wins).
  if (isEmpty(lead.phone) && ex.phones.length > 0) {
    lead.phone = ex.phones[0];
    filled.push('phone');
  }

  return filled;
}

/**
 * Run `extractFromBody` over an already-fetched website body and backfill the
 * lead's empty contact fields. Returns which fields were filled. `body` is the
 * HTML captured at the verify seam (ctx.verifiedBody); when absent (no strong
 * website match happened) this is a no-op. Never throws.
 */
export function applyFreeGoldExtraction(lead: Lead, body: string | undefined): FreeGoldResult {
  if (!body) return { applied: false, filled: [] };
  try {
    const ex = extractFromBody(body, lead);
    const filled = applyBodyExtraction(lead, ex);
    return { applied: filled.length > 0, filled };
  } catch {
    // Never break a lead row over free extraction.
    return { applied: false, filled: [] };
  }
}
