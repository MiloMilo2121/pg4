/**
 * Tiny value predicates shared across parsers and passes. One definition each,
 * so "is this field filled?" means the same thing in scoring, joins and exports.
 */

/** A filled value: not undefined/null and not blank once stringified. */
export function has(v: unknown): boolean {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * Defensive read of a scalar from third-party JSON: a trimmed non-empty
 * string, or a finite number as a string; `undefined` for anything else.
 */
export function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}
