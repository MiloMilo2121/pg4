'use client';

import { useRef, type KeyboardEvent } from 'react';
import { cx } from '../../ds/components/cx';

interface TabsProps<T extends string> {
  items: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (id: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Prefix for tab / panel ids, so a TabPanel can point back at its tab. */
  idBase: string;
  variant?: 'underline' | 'pill';
}

/** WAI-ARIA tabs: roving tabindex, arrow keys, Home/End. */
export function Tabs<T extends string>({ items, value, onChange, label, idBase, variant = 'underline' }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const last = items.length - 1;
    const next = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1)
      : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next][0]);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={cx('sx-tabs', variant === 'pill' && 'sx-tabs--pill')}>
      {items.map(([id, text], i) => {
        const selected = id === value;
        return (
          <button
            key={id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${id}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel`}
            tabIndex={selected ? 0 : -1}
            className="sx-tab"
            onClick={() => onChange(id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a Tabs list controls. */
export function TabPanel({ idBase, value, children, className }: { idBase: string; value: string; children: React.ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-tab-${value}`} className={cx('sx-enter', className)} key={value}>
      {children}
    </div>
  );
}
