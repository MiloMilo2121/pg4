import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'solid' | 'outline' | 'ghost';
  size?: 'sm' | 'md';
  /** Trailing glyph that slides on hover (→ for forward actions, ← renders first). */
  glyph?: '→' | '↗' | '←';
  block?: boolean;
  children: ReactNode;
}

/** The DS pill action. Solid is graphite on paper and light inside `.night`. */
export function Button({ variant = 'solid', size = 'md', glyph, block, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('mm-btn', `mm-btn--${variant}`, size === 'sm' && 'mm-btn--sm', block && 'mm-btn--block', className)}
      {...rest}
    >
      <span>{children}</span>
      {glyph && (
        <span className={cx('mm-btn__gl', glyph === '←' && 'mm-btn__gl--back')} aria-hidden="true">
          {glyph}
        </span>
      )}
    </button>
  );
}
