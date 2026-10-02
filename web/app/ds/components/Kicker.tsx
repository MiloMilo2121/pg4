import type { ReactNode } from 'react';
import { cx } from './cx';

interface KickerProps {
  /** Section number ("01"), set before the label behind a hairline rule. */
  number?: string;
  muted?: boolean;
  className?: string;
  children: ReactNode;
}

/** The DS mono caps eyebrow label. */
export function Kicker({ number, muted, className, children }: KickerProps) {
  return (
    <span className={cx('mm-kicker kicker', muted && 'kicker--muted', className)}>
      {number && <span className="knum">{number}</span>}
      <span>{children}</span>
    </span>
  );
}
