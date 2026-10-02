import { useEffect, useRef } from 'react';
import type { Nav } from './data';
import type { ViewProps } from './ctx';
import { useHealth, useMarkets } from './queries';
import { NAV_GROUPS } from './nav';
import { Logo } from '../ds/components/Logo';
import { Kicker } from '../ds/components/Kicker';
import { Icon } from '../ds/components/Icon';
import { Kbd } from '../ds/components/Kbd';

interface SidebarProps extends Pick<ViewProps, 'st' | 'set'> {
  /** Off-canvas state below 1100px (ignored on wide screens, where it is always shown). */
  open: boolean;
  onClose: () => void;
  onPalette: () => void;
}

/** Night chrome: brand, command entry, numbered navigation. Engine status lives in the status bar. */
export default function Sidebar({ st, set, open, onClose, onPalette }: SidebarProps) {
  const ref = useRef<HTMLElement>(null);
  // Off-canvas behaviour: focus the current item on open, Escape closes.
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const health = useHealth();
  const markets = useMarkets();
  const companies = health.data?.companies;
  const badges: Partial<Record<Nav, string>> = {
    mercati: markets.length ? String(markets.length) : '',
    aziende: companies ? companies.toLocaleString('it-IT') : '',
  };
  return (
    <>
      {open && <div className="sx-menu-scrim" onClick={onClose} aria-hidden="true" />}
      <aside ref={ref} id="sx-sidebar" className={open ? 'sx-sidebar night sx-sidebar--open' : 'sx-sidebar night'}>
        <div className="sx-brand">
          <Logo size={30} />
          <div>
            <div className="sx-brand__name">Setaccio</div>
            <span className="sx-brand__tag kicker kicker--muted">Intelligence commerciale</span>
          </div>
        </div>

        <div className="sx-sidebar__cmd">
          <button type="button" className="sx-cmd-trigger" onClick={onPalette} aria-keyshortcuts="Meta+K Control+K">
            <Icon name="search" size={14} />
            <span>Cerca o comanda</span>
            <span className="sx-cmd-trigger__keys" aria-hidden="true"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
          </button>
        </div>

        <nav className="sx-nav" aria-label="Sezioni">
          {NAV_GROUPS.map((g) => (
            <div key={g.num} className="sx-nav__group">
              <Kicker number={g.num} muted className="sx-nav__label">{g.label}</Kicker>
              {g.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="sx-nav__item"
                  aria-current={st.nav === item.id ? 'page' : undefined}
                  aria-keyshortcuts={`g ${item.key}`}
                  onClick={() => set({ nav: item.id })}
                >
                  <Icon name={item.icon} size={15} className="sx-nav__icon" />
                  <span>{item.label}</span>
                  {badges[item.id] && <span className="sx-nav__badge num">{badges[item.id]}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
