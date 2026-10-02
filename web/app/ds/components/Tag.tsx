import type { ReactNode } from 'react';
import { cx } from './cx';

interface TagProps {
  /** category: bare mono caps · muted: same in ink · pill: outlined capsule · dashed: "sample data" marker. */
  variant?: 'category' | 'muted' | 'pill' | 'dashed';
  title?: string;
  className?: string;
  children: ReactNode;
}

/** Small mono label. */
export function Tag({ variant = 'category', title, className, children }: TagProps) {
  return (
    <span className={cx('mm-tag', `mm-tag--${variant}`, className)} title={title}>
      {children}
    </span>
  );
}
