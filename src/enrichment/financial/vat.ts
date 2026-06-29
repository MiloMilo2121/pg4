/**
 * R13 — Italian VAT (Partita IVA) utilities. PURE: no network, no I/O.
 *
 * Ported from pg3's `enricher/core/financial/vies.ts` checksum and
 * `patterns.ts` VAT regexes, re-expressed as standalone pure functions so
 * they can be unit-tested with zero network and reused by the parser and
 * the (disabled) financial stage.
 *
 * An Italian P.IVA is exactly 11 digits. The last digit is a Luhn-style
 * check digit defined by the Agenzia delle Entrate. The checksum is a
 * free, deterministic gate that rejects most false positives (phone
 * numbers, IDs) before any paid/live validation (VIES) is considered.
 */

/**
 * Strip everything that is not a P.IVA digit: removes an `IT` country
 * prefix (case-insensitive), spaces, dots, and any other separators.
 * Returns the digit string as-is (may be <>11 digits — callers decide).
 */
export function normalizeVatCode(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^it/i, '') // drop leading country code only
    .replace(/\D/g, ''); // then keep digits
}

/** True iff `raw` normalizes to exactly 11 digits (format only, no checksum). */
export function isItalianVatCode(raw: string | null | undefined): boolean {
  return /^\d{11}$/.test(normalizeVatCode(raw));
}

/**
 * Validate the Italian P.IVA check digit (Luhn-like, odd/even split).
 * Accepts a raw or normalized value; normalizes internally.
 * Returns false for anything that is not 11 digits.
 */
export function validateItalianVatChecksum(raw: string | null | undefined): boolean {
  const vat = normalizeVatCode(raw);
  if (!/^\d{11}$/.test(vat)) return false;

  const digits = vat.split('').map((d) => Number(d));
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    if (i % 2 === 0) {
      sum += digits[i];
    } else {
      const doubled = digits[i] * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    }
  }
  return sum % 10 === 0;
}

/** Labeled P.IVA: "P.IVA 12345678901", "Partita IVA: IT123…", "C.F./P.IVA …". */
const VAT_LABELED =
  /(?:P\.?\s*I\.?\s*V\.?\s*A\.?|Partita\s*Iva|C\.?\s*F\.?\s*(?:\/|\s*e\s*)\s*P\.?\s*I\.?\s*V\.?\s*A\.?)[:\s]*(?:IT)?\s*(\d{11})/gi;
/** `IT`-prefixed: "IT 12345678901". */
const VAT_IT_PREFIXED = /\bIT\s?(\d{11})\b/gi;
/** Bare 11-digit run on word boundaries. */
const VAT_STANDALONE = /\b(\d{11})\b/g;

/**
 * Extract all *checksum-valid* Italian VAT codes from free text, in order
 * of first appearance, de-duplicated.
 *
 * Strategy: gather candidates from the labeled / IT-prefixed / standalone
 * patterns, then keep only those whose check digit is valid. The checksum
 * filter is what makes the bare-11-digit pattern safe to use — a random
 * 11-digit phone number will almost never pass it.
 */
export function extractVatCodesFromText(text: string | null | undefined): string[] {
  if (!text) return [];

  // Record the EARLIEST index each distinct VAT appears at, across all
  // patterns. (The same code can match under several patterns at different
  // offsets — e.g. a bare run early and a labeled run later — so we keep
  // the minimum to preserve true first-appearance order.)
  const firstIndex = new Map<string, number>();

  const collect = (re: RegExp): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const candidate = m[1];
      if (!candidate) continue;
      const vat = normalizeVatCode(candidate);
      if (!validateItalianVatChecksum(vat)) continue;
      const prev = firstIndex.get(vat);
      if (prev === undefined || m.index < prev) firstIndex.set(vat, m.index);
    }
  };

  collect(VAT_LABELED);
  collect(VAT_IT_PREFIXED);
  collect(VAT_STANDALONE);

  return [...firstIndex.entries()].sort((a, b) => a[1] - b[1]).map(([vat]) => vat);
}
