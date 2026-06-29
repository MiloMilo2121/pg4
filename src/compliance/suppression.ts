import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { logger } from '../runtime/logger';
import type { Lead } from '../types/lead';

/**
 * Phase D.1 — suppression list (do-not-contact / GDPR right-to-objection).
 *
 * Format: CSV with header `phone,vat,reason,date` — any subset of the
 * key columns may be filled per row:
 *
 *   phone,vat,reason,date
 *   +390422000177,,operator_request,2026-06-01
 *   ,01234567897,gdpr_deletion,2026-05-20
 *
 * Matching:
 *   - phone: digit-normalized (country prefix stripped) — "+39 0422 000177",
 *     "0422000177" and "0039 0422-000177" all match the same entry.
 *   - vat: 11-digit P.IVA, compared against both `vat_code` and
 *     `vat_code_final`.
 *
 * Resolution order for the list path:
 *   1. `--suppression-list <path>` CLI flag
 *   2. `SUPPRESSION_LIST` env var
 *   3. `suppression.csv` next to the run's output (auto-discovered)
 *   4. none → suppression disabled (logged at debug)
 *
 * Suppressed leads are DROPPED from outputs entirely (not written as
 * SKIPPED rows): a do-not-contact subject must not keep appearing in
 * delivered files. The drop count lands in the run summary + run record.
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
    return this.phones.size > 0 || this.vats.size > 0;
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
