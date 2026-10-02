import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

interface CardProps extends HTMLAttributes<HTMLElement> {
  tone?: 'paper' | 'raised';
  pad?: 'md' | 'tight' | 'flush';
  /** Graphite border and soft shadow: the one card on a screen that carries the action. */
  emphasis?: boolean;
  /** Lift on hover. Only for cards that do something on click. */
  interactive?: boolean;
  as?: 'div' | 'section' | 'article';
  children: ReactNode;
}

/** The DS base surface: hairline border, 14px corners, paper fill. */
export function Card({ tone = 'paper', pad = 'md', emphasis, interactive, as: Tag = 'div', className, children, ...rest }: CardProps) {
  return (
    <Tag
      className={cx(
        'mm-card',
        tone === 'raised' && 'mm-card--raised',
        pad === 'tight' && 'mm-card--tight',
        pad === 'flush' && 'mm-card--flush',
        emphasis && 'mm-card--emphasis',
        interactive && 'mm-card--interactive',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
