/**
 * Conservative text cleanup for parsed lead fields.
 *
 * The Phase 4.3 Belluno canary surfaced at least one address rendered as
 *   "Piazza Libert��, 15"
 *   "Piazza Libert¿¿, 15"
 * — replacement-looking mojibake produced when the upstream HTML decoder
 * hits bytes that can't be mapped cleanly (typically a latin-1 byte
 * `\xe0` for `à` mis-decoded as UTF-8). The CSV / JSONL then carry the
 * garbage into downstream consumers.
 *
 * Goal of this module: remove obviously-corrupted replacement runs in a
 * way that NEVER damages valid Italian content.
 *
 * Rules:
 *   1. Drop `�` / `¿` runs (they're already corrupted in Italian PG
 *      fields; no recoverable info).
 *   2. Tighten whitespace introduced by drops (no double spaces, no
 *      space-before-comma).
 *   3. Do nothing else. Apostrophes (`d'Ampezzo`), accented letters
 *      (`Libertà`, `Forlì`, `Sant'Egidio`), capitalisation and Italian
 *      punctuation all pass through unchanged.
 *
 * Wired only at the parser-field boundary (PG + Maps card extractors).
 * NOT applied to raw HTML or to URL fields.
 */

const REPLACEMENT_RUN = /[�¿]+/g;
// Whitespace that ended up wrapped around a stripped `�` run, e.g.
// "Libert , 15" or "Libert ,15" → "Libert, 15".
const SPACE_BEFORE_PUNCT = /[\t ]+([,.;:!?])/g;
const MULTI_SPACE = /[\t ]{2,}/g;

/**
 * Returns the input unchanged when it has no replacement-like chars, so callers
 * never pay an alloc on the happy path.
 */
export function cleanMojibake(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return value === null ? undefined : undefined;
  if (!value.includes('�') && !value.includes('¿')) return value;
  let out = value.replace(REPLACEMENT_RUN, '');
  out = out.replace(SPACE_BEFORE_PUNCT, '$1');
  out = out.replace(MULTI_SPACE, ' ').trim();
  return out;
}

/**
 * Apply `cleanMojibake` to a record's string-valued fields, in-place.
 * Non-string values pass through. Useful for cleaning a parsed Lead
 * card right before handing it back to the orchestrator.
 *
 * Pure with respect to the type — only the listed fields are touched.
 */
export function cleanMojibakeFields<T extends Record<string, unknown>>(record: T, fields: ReadonlyArray<keyof T>): T {
  for (const f of fields) {
    const v = record[f];
    if (typeof v === 'string') {
      const cleaned = cleanMojibake(v);
      if (cleaned !== v) (record as Record<string, unknown>)[f as string] = cleaned;
    }
  }
  return record;
}
