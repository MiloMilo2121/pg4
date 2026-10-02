'use client';

import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ViewProps } from './ctx';
import { useCompanies, useMarkets } from './queries';
import { NAV_ITEMS } from './nav';
import { Dialog } from './ui/Dialog';
import { Icon, type IconName } from '../ds/components/Icon';
import { Kbd } from '../ds/components/Kbd';
import { cx } from '../ds/components/cx';

interface Command {
  id: string;
  group: 'Vai a' | 'Azioni' | 'Mercati' | 'Aziende';
  label: string;
  hint?: string;
  icon: IconName;
  /** Extra words the filter matches (VAT, city, shortcut). */
  keywords?: string;
  run: () => void;
}

/** Lowercase, no accents: "Città" matches "citta". */
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

interface PaletteProps extends Pick<ViewProps, 'set'> {
  onClose: () => void;
  onHelp: () => void;
}

/**
 * ⌘K: one input to go anywhere and do anything. Views, actions, markets and,
 * from the second character, companies by name, city or VAT number.
 * WAI-ARIA combobox: focus stays in the input, arrows move the active option.
 */
export default function CommandPalette({ set, onClose, onHelp }: PaletteProps) {
  const titleId = useId();
  const listId = useId();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { raw } = useCompanies();
  const markets = useMarkets();

  const run = (fn: () => void) => () => { onClose(); fn(); };

  const base: Command[] = useMemo(() => [
    ...NAV_ITEMS.map((n) => ({
      id: 'nav-' + n.id, group: 'Vai a' as const, label: n.label, hint: `g ${n.key}`, icon: n.icon, keywords: n.path,
      run: () => set({ nav: n.id }),
    })),
    { id: 'act-map', group: 'Azioni', label: 'Mappa il mercato', hint: 'wizard', icon: 'map', keywords: 'scrape nuovo territorio', run: () => set({ wizardOpen: true, wStep: 0 }) },
    { id: 'act-enrich', group: 'Azioni', label: 'Arricchisci i campi gratuiti', icon: 'funnel', keywords: 'enrich email pec piva', run: () => set({ nav: 'raff', raffTab: 'enrichment' }) },
    { id: 'act-judge', group: 'Azioni', label: 'Giudica le aziende', icon: 'matrix', keywords: 'valutazione judge tier', run: () => set({ nav: 'val', valTab: 'matrice' }) },
    { id: 'act-milo', group: 'Azioni', label: 'Apri il tour di Milo', icon: 'cockpit', keywords: 'guida aiuto', run: () => set({ miloOpen: true, miloStep: 0 }) },
    { id: 'act-help', group: 'Azioni', label: 'Scorciatoie da tastiera', hint: '?', icon: 'keyboard', keywords: 'shortcut tasti', run: onHelp },
    ...markets.map((m) => ({
      id: 'mkt-' + m.id, group: 'Mercati' as const, label: m.settore, hint: m.territorio.replace('Provincia di ', ''), icon: 'dataset' as IconName,
      run: () => set({ market: m.id }),
    })),
  ], [markets, set, onHelp]);

  const needle = norm(q.trim());
  const companies: Command[] = needle.length >= 2
    ? raw
        .filter((c) => norm(`${c.company_name ?? ''} ${c.city ?? ''} ${c.vat_code_final ?? ''}`).includes(needle))
        .slice(0, 8)
        .map((c) => ({
          id: 'co-' + c.id, group: 'Aziende' as const, label: c.company_name ?? c.id, hint: c.city ?? undefined, icon: 'companies' as IconName,
          run: () => set({ nav: 'aziende', selectedCompanyId: c.id }),
        }))
    : [];
  const items = [...base.filter((c) => !needle || norm(`${c.label} ${c.hint ?? ''} ${c.keywords ?? ''}`).includes(needle)), ...companies];
  const current = Math.min(active, Math.max(0, items.length - 1));

  const move = (to: number) => {
    setActive(to);
    listRef.current?.querySelector(`[data-i="${to}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(Math.min(items.length - 1, current + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(Math.max(0, current - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = items[current]; if (c) run(c.run)(); }
  };

  const groups = (['Vai a', 'Azioni', 'Mercati', 'Aziende'] as const)
    .map((g) => ({ g, rows: items.map((c, i) => ({ c, i })).filter((r) => r.c.group === g) }))
    .filter((x) => x.rows.length > 0);
  return (
    <Dialog onClose={onClose} labelledBy={titleId} width={600} className="sx-palette">
      <h2 id={titleId} className="sr-only">Cerca o comanda</h2>
      <div className="sx-palette__field">
        <Icon name="search" size={16} />
        <input
          data-autofocus
          className="sx-palette__input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items[current] ? `${listId}-${current}` : undefined}
          aria-autocomplete="list"
          aria-label="Cerca viste, azioni, mercati o aziende"
          placeholder="Vai a, fai, cerca un’azienda o una P.IVA"
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={onKey}
          autoComplete="off"
          spellCheck={false}
        />
        <Kbd>esc</Kbd>
      </div>
      <div id={listId} ref={listRef} role="listbox" aria-label="Risultati" className="sx-palette__list">
        {groups.map(({ g, rows }) => (
          <div key={g} role="group" aria-label={g}>
            <div className="sx-palette__group kicker kicker--muted" aria-hidden="true">{g}</div>
            {rows.map(({ c, i }) => (
              <div
                key={c.id}
                id={`${listId}-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === current}
                className={cx('sx-palette__opt', i === current && 'sx-palette__opt--active')}
                onMouseMove={() => i !== current && setActive(i)}
                onClick={run(c.run)}
              >
                <Icon name={c.icon} size={15} />
                <span className="sx-palette__label">{c.label}</span>
                {c.hint && <span className="sx-palette__hint num">{c.hint}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
      {items.length === 0 && <p className="sx-palette__empty" role="status">Nessun risultato per «{q}».</p>}
      <div className="sx-palette__foot sx-meta" aria-hidden="true">
        <span><Kbd>↑</Kbd><Kbd>↓</Kbd> scegli</span>
        <span><Kbd>↵</Kbd> apri</span>
        <span>{needle.length < 2 ? 'Scrivi 2 lettere per cercare le aziende' : `${companies.length} aziende`}</span>
      </div>
    </Dialog>
  );
}
