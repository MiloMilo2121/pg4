// Pure formatters and map helpers. Ports the `DCLogic` helper methods of the
// Antigravity prototype into typed functions.
import type { ItMode } from './data';

/** 1234567 → "1.234.567" (Italian thousands separator). */
export function fmt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** 18420 → "18k", 4200 → "4,2k". */
export function short(n: number): string {
  return n >= 1000
    ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',') + 'k'
    : '' + n;
}

/** Derive a 0–100 intensity for a region/province under the chosen map mode. */
export function modeVal(r: { cov: number; az?: number; rec?: number }, mode: ItMode): number {
  const c = r.cov;
  switch (mode) {
    case 'copertura':
      return c;
    case 'profondita':
      return Math.round(c * 0.72);
    case 'fatturato':
      return Math.round(c * 0.6);
    case 'target':
      return Math.round(c * 0.46);
    case 'settori':
      return c > 0 ? Math.min(100, Math.round(c * 0.9 + 10)) : 0;
    case 'recenza':
      return r.rec ?? 0;
    case 'opportunita':
      return (r.az ?? 0) === 0
        ? 0
        : Math.min(100, Math.round((100 - c) * 0.55 + (r.az ?? 0) / 1400));
    default:
      return c;
  }
}

/** Shown wherever a value is missing. The DS bans the em dash, so it is "n/d". */
export const EMPTY = 'n/d';

/** Graphite fill at an intensity-driven alpha (sequential, one hue). */
export function fillFor(v: number): string {
  const op = v === 0 ? 0.045 : 0.1 + (v / 100) * 0.78;
  return 'rgba(var(--accent-rgb),' + op.toFixed(3) + ')';
}
/** Map labels flip to light text once the fill is dark enough. */
export function isDarkFill(v: number): boolean {
  return v > 52;
}
