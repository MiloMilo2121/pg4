// Pure formatters + style builders. Ports the `DCLogic` helper methods of the
// Antigravity prototype into typed functions returning React.CSSProperties.
import type { CSSProperties } from 'react';
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

/** Terracotta fill at an intensity-driven alpha. */
export function fillFor(v: number): string {
  const op = v === 0 ? 0.045 : 0.1 + (v / 100) * 0.78;
  return 'rgba(151,88,47,' + op.toFixed(3) + ')';
}
export function tcFor(v: number): string {
  return v > 52 ? 'var(--white)' : 'var(--ink)';
}
export function tc2For(v: number): string {
  return v > 52 ? 'rgba(255,255,255,.8)' : 'var(--ink-3)';
}

// ---------- style builders ----------

export function navItemStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    width: '100%',
    textAlign: 'left',
    padding: '8px 11px 8px 16px',
    borderRadius: 9,
    fontSize: '.85rem',
    fontWeight: active ? 600 : 500,
    color: active ? 'var(--accent)' : 'var(--ink-2)',
    background: active ? 'var(--accent-wash)' : 'transparent',
    borderLeft: '2px solid ' + (active ? 'var(--accent)' : 'transparent'),
    transition: 'all .2s',
    marginBottom: 1,
  };
}

export function tabStyle(active: boolean): CSSProperties {
  return {
    padding: '10px 16px',
    fontSize: '.86rem',
    fontWeight: 600,
    color: active ? 'var(--accent)' : 'var(--ink-3)',
    borderBottom: '2px solid ' + (active ? 'var(--accent)' : 'transparent'),
    marginBottom: -1,
    transition: 'color .2s, border-color .2s',
  };
}

export function modeBtnStyle(active: boolean): CSSProperties {
  return {
    textAlign: 'left',
    padding: '9px 13px',
    borderRadius: 9,
    fontSize: '.84rem',
    fontWeight: active ? 600 : 500,
    color: active ? 'var(--white)' : 'var(--ink-2)',
    background: active ? 'var(--accent)' : 'transparent',
    border: '1px solid ' + (active ? 'var(--accent)' : 'var(--line)'),
    transition: 'all .2s',
  };
}

export function chipStyle(active: boolean): CSSProperties {
  return {
    padding: '7px 14px',
    borderRadius: 999,
    fontSize: '.8rem',
    fontWeight: 600,
    color: active ? 'var(--white)' : 'var(--ink-2)',
    background: active ? 'var(--accent)' : 'var(--paper)',
    border: '1px solid ' + (active ? 'var(--accent)' : 'var(--line)'),
    transition: 'all .2s',
  };
}

export function statePillStyle(stato: string): CSSProperties {
  let bg = 'var(--paper-3)';
  let c = 'var(--ink-3)';
  if (stato.includes('arricchito')) {
    bg = 'var(--accent-wash-2)';
    c = 'var(--accent)';
  } else if (stato.includes('raffinare')) {
    bg = 'var(--accent-wash)';
    c = 'var(--accent-2)';
  }
  return {
    fontSize: '.68rem',
    fontWeight: 600,
    letterSpacing: '.04em',
    padding: '5px 10px',
    borderRadius: 999,
    background: bg,
    color: c,
    whiteSpace: 'nowrap',
  };
}

export function tierPillStyle(tier: string): CSSProperties {
  const m: Record<string, string> = {
    'Tier A': 'var(--accent)',
    'Tier B': 'var(--accent-2)',
    'Tier C': 'var(--ink-3)',
    'Tier D': 'var(--ink-3)',
    '—': 'var(--ink-3)',
  };
  const solid = tier === 'Tier A';
  return {
    justifySelf: 'start',
    whiteSpace: 'nowrap',
    fontSize: '.7rem',
    fontWeight: 600,
    padding: '4px 11px',
    borderRadius: 999,
    background: solid ? 'var(--accent)' : 'var(--paper-3)',
    color: solid ? 'var(--white)' : m[tier] || 'var(--ink-3)',
  };
}

export function prioPillStyle(prio: string): CSSProperties {
  const high = prio === 'Alta';
  return {
    justifySelf: 'start',
    fontSize: '.68rem',
    fontWeight: 600,
    padding: '3px 9px',
    borderRadius: 999,
    background: high ? 'var(--accent-wash)' : 'var(--paper-3)',
    color: high ? 'var(--accent)' : 'var(--ink-3)',
  };
}
