import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { logger } from '../runtime/logger';
import type { Lead } from '../types/lead';
import { UserError } from '../runtime/errors';

/**
 * Suppression list (do-not-contact / GDPR right-to-objection).
 *
 * Format: CSV with header `phone,vat,email,reason,date`. Every column is
 * optional per row; a row suppresses whatever key columns it fills:
 *
 *   phone,vat,email,reason,date
 *   +390422000177,,,operator_request,2026-06-01
 *   ,01234567897,,gdpr_deletion,2026-05-20
 *   ,,info@example.it,gdpr_objection,2026-06-10
 *
 *   - phone:  digit-normalized (country prefix stripped) — "+39 0422 000177",
 *             "0422000177" and "0039 0422-000177" all match the same entry.
 *             A match drops the whole company.
 *   - vat:    11-digit P.IVA, compared against both `vat_code` and
 *             `vat_code_final`. A match drops the whole company.
 *   - email:  case-insensitive. Channel-specific: the address is removed from
 *             the lead (`email`, `email_inferred`, `pec`) and never synthesised,
 *             but the company stays (it may still be reachable by phone).
 *   - reason, date: audit trail for the operator; not used for matching.
 *
 * Resolution order for the list path (`suppressionForCommand`):
 *   1. `--suppression-list <path>` CLI flag
 *   2. `SUPPRESSION_LIST` env var
 *   3. `suppression.csv` next to the command's output — for the report-only
 *      commands (coverage, benchmark), next to the enriched input they read
 *   4. none → suppression disabled
 *
 * Every command that emits or counts companies applies the list (scrape,
 * enrich, run, judge, coverage, benchmark). Suppressed companies are DROPPED
 * (not written as SKIPPED rows): a do-not-contact subject must not keep
 * appearing in delivered files. The drop count lands in the run summary.
 */

export interface SuppressionEntry {
  phone?: string;
  vat?: string;
  /** Optional do-not-contact email (channel-specific suppression). */
  email?: string;
  reason?: string;
  date?: string;
}

export class SuppressionList {
  private phones = new Set<string>();
  private vats = new Set<string>();
  private emails = new Set<string>();
  readonly sourcePath: string | null;
  readonly entries: number;

  private constructor(sourcePath: string | null, entries: SuppressionEntry[]) {
    this.sourcePath = sourcePath;
    this.entries = entries.length;
    for (const e of entries) {
      const p = normalizePhoneKey(e.phone);
      if (p) this.phones.add(p);
      const v = normalizeVatKey(e.vat);
      if (v) this.vats.add(v);
      const m = normalizeEmailKey(e.email);
      if (m) this.emails.add(m);
    }
  }

  /** An empty list that suppresses nothing (no file found / flag absent). */
  static disabled(): SuppressionList {
    return new SuppressionList(null, []);
  }

  static fromFile(filePath: string): SuppressionList {
    const raw = fs.readFileSync(filePath, 'utf8');
    const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as SuppressionEntry[];
    const list = new SuppressionList(filePath, rows);
    logger.info(
      { path: filePath, entries: rows.length, phones: list.phones.size, vats: list.vats.size, emails: list.emails.size },
      '[suppression] list loaded'
    );
    return list;
  }

  /**
   * Resolve and load per the documented order. Never throws on a missing
   * auto-discovered file; an EXPLICIT path (flag/env) that cannot be read
   * is a hard error — the operator asked for protection they aren't getting.
   */
  static resolve(opts: { flagPath?: string; outCsv: string }): SuppressionList {
    const explicit = opts.flagPath ?? process.env.SUPPRESSION_LIST;
    if (explicit) {
      return SuppressionList.fromFile(explicit); // throws on unreadable — intentional
    }
    const auto = path.join(path.dirname(path.resolve(opts.outCsv)), 'suppression.csv');
    if (fs.existsSync(auto)) {
      return SuppressionList.fromFile(auto);
    }
    return SuppressionList.disabled();
  }

  get active(): boolean {
    return this.phones.size > 0 || this.vats.size > 0 || this.emails.size > 0;
  }

  /** True when the lead matches a suppression entry (phone or P.IVA). */
  matches(lead: Lead): boolean {
    if (!this.active) return false;
    for (const phoneField of [lead.phone, lead.phone_raw]) {
      const p = normalizePhoneKey(phoneField);
      if (p && this.phones.has(p)) return true;
    }
    for (const vatField of [lead.vat_code, lead.vat_code_final]) {
      const v = normalizeVatKey(vatField);
      if (v && this.vats.has(v)) return true;
    }
    return false;
  }

  /**
   * True when an email address is on the do-not-contact list. Channel-specific:
   * unlike `matches`, a suppressed email does NOT drop the whole lead (the firm
   * may still be reachable by phone) — it only stops that address from ever
   * being synthesised by inference (`email_inference_step.ts`).
   */
  matchesEmail(email: string | undefined | null): boolean {
    if (this.emails.size === 0) return false;
    const m = normalizeEmailKey(email);
    return !!m && this.emails.has(m);
  }

  /** Remove every suppressed address from the lead; returns the fields cleared. */
  dropSuppressedEmails(lead: Lead): string[] {
    if (this.emails.size === 0) return [];
    return dropSuppressedEmails(lead, (e) => this.matchesEmail(e));
  }

  /**
   * The filter a command runs before emitting or counting companies: drops the
   * suppressed ones and strips suppressed addresses from the rest (in place).
   */
  apply(leads: Lead[]): { kept: Lead[]; suppressed: number } {
    if (!this.active) return { kept: leads, suppressed: 0 };
    const kept: Lead[] = [];
    for (const lead of leads) {
      if (this.matches(lead)) continue;
      this.dropSuppressedEmails(lead);
      kept.push(lead);
    }
    return { kept, suppressed: leads.length - kept.length };
  }
}

/**
 * The one place a command turns its flags into a suppression list. `anchorPath`
 * is the file the command writes (or reads, for report-only commands): the
 * auto-discovered `suppression.csv` sits next to it.
 */
export function suppressionForCommand(flags: Readonly<Record<string, string | boolean>>, anchorPath: string): SuppressionList {
  const flag = flags['suppression-list'];
  // A bare `--suppression-list` would otherwise fall through to "no list" and
  // run unprotected while the operator believes a list is loaded.
  if (flag === true) throw new UserError('--suppression-list needs a path');
  return SuppressionList.resolve({ flagPath: typeof flag === 'string' ? flag : undefined, outCsv: anchorPath });
}

/**
 * Clear every address on the lead that `isSuppressed` flags — the business
 * email, the inferred one and the PEC — and the fields that describe them.
 * Pure over its inputs; mutates the lead. Returns the fields cleared.
 */
export function dropSuppressedEmails(lead: Lead, isSuppressed: (email: string) => boolean): string[] {
  const cleared: string[] = [];
  for (const field of ['email', 'email_inferred', 'pec'] as const) {
    const v = lead[field];
    if (v && isSuppressed(v)) {
      delete lead[field];
      cleared.push(field);
    }
  }
  if (cleared.includes('email_inferred')) delete lead.email_status; // it described that address
  // email_type labels email_inferred, or the PEC when there is no business email.
  if (cleared.length > 0 && lead.email_type && !lead.email_inferred) {
    if (lead.pec) lead.email_type = 'pec';
    else delete lead.email_type;
  }
  return cleared;
}

/** Digit-only, Italian country prefix stripped — mirrors the deduper's key. */
function normalizePhoneKey(phone: string | undefined | null): string | undefined {
  if (!phone) return undefined;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('0039')) digits = digits.slice(4);
  else if (digits.length >= 11 && digits.startsWith('39')) digits = digits.slice(2);
  return digits.length >= 6 ? digits : undefined;
}

function normalizeVatKey(vat: string | undefined | null): string | undefined {
  if (!vat) return undefined;
  const digits = String(vat).replace(/\D/g, '');
  return digits.length === 11 ? digits : undefined;
}

/** Lowercased, trimmed email. Returns undefined for anything without an `@`. */
function normalizeEmailKey(email: string | undefined | null): string | undefined {
  if (!email) return undefined;
  const e = String(email).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : undefined;
}
