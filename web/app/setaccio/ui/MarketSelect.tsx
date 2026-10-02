'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Market } from '../data';
import { Icon } from '../../ds/components/Icon';
import { cx } from '../../ds/components/cx';

interface MarketSelectProps {
  markets: Market[];
  value: string | undefined;
  onChange: (id: string) => void;
}

export const marketLabel = (m: Market | undefined): string =>
  m ? m.settore + ' · ' + m.territorio.replace('Provincia di ', '') : 'Tutti i mercati';

/** Active-market picker: a button that opens a keyboard-driven listbox (WAI-ARIA select-only combobox). */
export function MarketSelect({ markets, value, onChange }: MarketSelectProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const current = markets.find((m) => m.id === value) ?? markets[0];
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const openList = () => {
    setActive(Math.max(0, markets.findIndex((m) => m.id === current?.id)));
    setOpen(true);
  };
  const choose = (i: number) => {
    const m = markets[i];
    if (m) onChange(m.id);
    setOpen(false);
    btn.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openList(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(markets.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(markets.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.stopPropagation(); setOpen(false); }
  };

  return (
    <div className="sx-select" ref={box}>
      <button
        ref={btn}
        type="button"
        role="combobox"
        className="sx-market"
        aria-label="Mercato attivo"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={markets.length === 0}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKey}
      >
        <span className="sx-market__label">{marketLabel(current)}</span>
        <Icon name="sort" size={12} className="sx-market__chev" />
      </button>
      {open && (
        <ul id={listId} role="listbox" aria-label="Mercati" className="sx-select__list">
          {markets.map((m, i) => (
            <li
              key={m.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={m.id === current?.id}
              className={cx('sx-select__opt', i === active && 'sx-select__opt--active')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(i); }}
            >
              <span className="sx-select__name">{m.settore}</span>
              <span className="sx-select__meta num">{m.territorio.replace('Provincia di ', '')} · {m.aziende}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
