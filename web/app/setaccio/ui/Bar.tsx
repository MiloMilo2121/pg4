import { cx } from '../../ds/components/cx';

interface BarProps {
  /** 0–100. Omit for an indeterminate bar. */
  value?: number;
  size?: 'thin' | 'md' | 'thick';
  sand?: boolean;
  /** Accessible name; when set the bar is exposed as a progressbar. */
  label?: string;
}

/** Track + graphite fill. Width is the only inline style: it is the data. */
export function Bar({ value, size = 'md', sand, label }: BarProps) {
  const indeterminate = value === undefined;
  const pct = indeterminate ? undefined : Math.max(0, Math.min(100, value));
  const a11y = label
    ? { role: 'progressbar' as const, 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, ...(pct !== undefined ? { 'aria-valuenow': Math.round(pct) } : {}) }
    : { 'aria-hidden': true };
  return (
    <span className={cx('sx-bar', size !== 'md' && `sx-bar--${size}`, indeterminate && 'sx-bar--indeterminate')} {...a11y}>
      <span className={cx('sx-bar__fill', sand && 'sx-bar__fill--sand')} style={pct !== undefined ? { width: `${pct}%` } : undefined} />
    </span>
  );
}

/** In-cell bar with its value: tables. */
export function MiniBar({ value, text }: { value: number; text: string }) {
  return (
    <span className="sx-minibar">
      <Bar value={value} size="thin" />
      <span className="sx-cell-sub">{text}</span>
    </span>
  );
}

export interface BarRow {
  k: string;
  v: string;
  /** 0–100 */
  w: number;
}

/** Labelled horizontal bars, one per row. */
export function Bars({ rows, size = 'md' }: { rows: BarRow[]; size?: 'thin' | 'md' | 'thick' }) {
  return (
    <div className="sx-bars">
      {rows.map((r) => (
        <div key={r.k}>
          <div className="sx-bars__head">
            <span className="sx-bars__k">{r.k}</span>
            <span className="sx-bars__v">{r.v}</span>
          </div>
          <Bar value={r.w} size={size} />
        </div>
      ))}
    </div>
  );
}

/** "62%" → 62 (static rows carry widths as strings). */
export function pctOf(w: string): number {
  const n = parseFloat(w);
  return Number.isFinite(n) ? n : 0;
}
