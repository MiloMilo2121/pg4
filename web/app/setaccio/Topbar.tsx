import type { Nav } from './data';
import { useMarkets } from './queries';
import type { ViewProps } from './ctx';
import { navItem } from './nav';
import { Button } from '../ds/components/Button';
import { Tag } from '../ds/components/Tag';
import { Icon } from '../ds/components/Icon';
import { Logo } from '../ds/components/Logo';
import { MarketSelect, marketLabel } from './ui/MarketSelect';

/**
 * Views whose panels still render the design prototype's illustrative figures
 * (market trends, national map totals, credits, saved lists, enrichment
 * prices, eval KPIs) instead of live API data.
 * Flagged in the UI so a demo never passes sample numbers off as measured.
 */
const PROTOTYPE_DATA_VIEWS: ReadonlySet<Nav> = new Set<Nav>(['analytics', 'italia', 'sistema', 'liste', 'raff', 'val']);

const slug = (s: string) => s.replace(/\s*·\s*/g, '·').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9·]+/g, '-').replace(/^-|-$/g, '');

interface TopbarProps extends Pick<ViewProps, 'st' | 'set'> {
  menuOpen: boolean;
  onMenu: () => void;
}

/** Night chrome: path, active market, the one primary action. */
export default function Topbar({ st, set, menuOpen, onMenu }: TopbarProps) {
  const markets = useMarkets();
  const mkt = markets.find((m) => m.id === st.market) ?? markets[0];

  return (
    <header className="sx-topbar night">
      <button type="button" className="sx-menu-btn" aria-label="Menu" aria-expanded={menuOpen} aria-controls="sx-sidebar" onClick={onMenu}>
        <Icon name="menu" size={16} />
        <Logo size={26} />
      </button>
      <nav className="sx-path" aria-label="Posizione">
        <span className="sx-path__root">setaccio</span>
        <span className="sx-path__sep" aria-hidden="true">/</span>
        <span aria-current="page">{navItem(st.nav).path}</span>
        <span className="sx-path__sep" aria-hidden="true">/</span>
        <span className="sx-path__leaf">{slug(marketLabel(mkt))}</span>
      </nav>
      <div className="sx-topbar__actions">
        {PROTOTYPE_DATA_VIEWS.has(st.nav) && (
          <Tag variant="dashed" title="Alcuni pannelli di questa vista mostrano cifre illustrative del prototipo di design, non dati misurati.">
            dati di esempio
          </Tag>
        )}
        <MarketSelect markets={markets} value={mkt?.id} onChange={(id) => set({ market: id })} />
        <Button glyph="→" size="sm" onClick={() => set({ wizardOpen: true, wStep: 0 })}>Mappa il mercato</Button>
      </div>
    </header>
  );
}
