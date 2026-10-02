import type { CSSProperties } from 'react';
import { cx } from '../../ds/components/cx';
import { fmt } from '../helpers';

export interface FunnelStep {
  label: string;
  value: number;
}

interface FunnelProps {
  steps: FunnelStep[];
  /** Width of each step from its value: max(minPct, value / base × 100). */
  base: number;
  minPct?: number;
  /** Show the drop between steps. */
  deltas?: boolean;
  label: string;
}

/** Narrowing bars, last step solid: from raw to useful. */
export function Funnel({ steps, base, minPct = 18, deltas = true, label }: FunnelProps) {
  const b = base || 1;
  return (
    <ol className="sx-funnel" aria-label={label}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const w = Math.max(minPct, Math.round((100 * s.value) / b));
        const drop = i > 0 ? steps[i - 1].value - s.value : 0;
        return (
          <li key={s.label + i} className={cx('sx-funnel__step', last && 'sx-funnel__step--last')} style={{ '--w': `${w}%` } as CSSProperties}>
            {deltas && i > 0 && <span className="sx-funnel__delta">−{fmt(drop)}</span>}
            <span className="sx-funnel__bar">
              <span className="sx-funnel__label">{s.label}</span>
              <span className="sx-funnel__value">{fmt(s.value)}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
