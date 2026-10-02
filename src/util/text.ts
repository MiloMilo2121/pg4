/**
 * Tiny text folds shared by matchers, slugs and dedup keys. One definition
 * each, so "compare ignoring accents" means the same thing in SERP relevance,
 * dedupe, URL slugs, NER and coverage.
 */

/**
 * Strip diacritics via NFD decomposition ("città" → "citta"). Only the
 * combining-mark run U+0300–U+036F is removed: letters without a decomposition
 * (ß, ø) survive. Case is NOT folded — callers decide where lowercasing goes.
 */
export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
