import type { ReactNode } from 'react';
import { Card } from '../../ds/components/Card';
import { cx } from '../../ds/components/cx';

interface StatProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** label-top: KPI tile · value-top: compact figure with caption · hero: one big number. */
  variant?: 'label-top' | 'value-top' | 'hero';
  size?: 'md' | 'sm';
  /** Render inside a card (default) or bare, inside a parent surface. */
  boxed?: boolean;
  tone?: 'paper' | 'raised';
}

/** A measured figure: DM Mono value, mono caps label, optional context line. */
export function Stat({ label, value, sub, variant = 'label-top', size = 'md', boxed = true, tone = 'paper' }: StatProps) {
  const labelEl = <span className="sx-stat__label">{label}</span>;
  const valueEl = <span className="sx-stat__value">{value}</span>;
  const body = (
    <span className={cx(`sx-stat sx-stat--${variant}`, size === 'sm' && 'sx-stat--sm')}>
      {variant === 'value-top' ? (
        <>
          {valueEl}
          {labelEl}
        </>
      ) : (
        <>
          {labelEl}
          {valueEl}
        </>
      )}
      {sub && <span className="sx-stat__sub">{sub}</span>}
    </span>
  );
  return boxed ? (
    <Card pad="tight" tone={tone}>
      {body}
    </Card>
  ) : (
    body
  );
}
