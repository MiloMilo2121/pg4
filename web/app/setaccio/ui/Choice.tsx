import type { ReactNode } from 'react';
import { cx } from '../../ds/components/cx';

/** Toggle chip (aria-pressed). Solid graphite when on. */
export function Chip({ pressed, onClick, count, children }: { pressed: boolean; onClick: () => void; count?: number; children: ReactNode }) {
  return (
    <button type="button" className="sx-chip" aria-pressed={pressed} onClick={onClick}>
      <span>{children}</span>
      {count !== undefined && <span className="sx-chip__count">{count}</span>}
    </button>
  );
}

interface OptionCardProps {
  selected: boolean;
  onClick: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned marker next to the title (cost tag, badge). */
  aside?: ReactNode;
  /** checkbox: many can be on · radio: one of a group (use inside role="radiogroup"). */
  kind?: 'checkbox' | 'radio';
  children?: ReactNode;
}

/** Large selectable option for wizard choices. */
export function OptionCard({ selected, onClick, title, description, aside, kind = 'checkbox', children }: OptionCardProps) {
  const ariaState = kind === 'radio' ? { role: 'radio' as const, 'aria-checked': selected } : { 'aria-pressed': selected };
  return (
    <button type="button" className="sx-option" onClick={onClick} {...ariaState}>
      {kind === 'checkbox' && <Check on={selected} />}
      <span className="sx-option__body">
        <span className="sx-option__top">
          <span className="sx-option__title">{title}</span>
          {aside}
        </span>
        {description && <span className="sx-option__desc">{description}</span>}
        {children}
      </span>
    </button>
  );
}

/** Visual checkbox mark; the state lives on the owning control. */
export function Check({ on }: { on: boolean }) {
  return <span className={cx('sx-check', on && 'sx-check--on')} aria-hidden="true" />;
}
