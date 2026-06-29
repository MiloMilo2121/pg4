import { type Nav } from './data';
import { useMarkets } from './queries';
import type { ViewProps } from './ctx';

const CRUMB_A: Record<Nav, string> = {
  home: 'Cockpit',
  mercati: 'Mercati',
  aziende: 'Archivio',
  italia: 'Italia',
  raff: 'Raffinazione',
  val: 'Valutazione',
  analytics: 'Intelligence',
  liste: 'Output',
  sistema: 'Sistema',
};

export default function Topbar({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const markets = useMarkets();
  const mkt = markets.find((m) => m.id === st.market) ?? markets[0];
  const label = mkt ? mkt.settore + ' · ' + mkt.territorio.replace('Provincia di ', '') : 'Tutti i mercati';

  const cycleMarket = () => {
    if (markets.length === 0) return;
    const i = markets.findIndex((m) => m.id === st.market);
    set({ market: markets[(i + 1) % markets.length].id });
  };

  return (
    <header
      style={{
        flex: 'none',
        height: 64,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 30px',
        borderBottom: '1px solid var(--line)',
        background: 'rgba(250,247,242,.82)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '.82rem', color: 'var(--ink-3)' }}>
        <span style={{ fontWeight: 600, letterSpacing: '.04em' }}>{CRUMB_A[st.nav]}</span>
        <span style={{ color: 'var(--ink-3)' }}>→</span>
        <span style={{ color: 'var(--ink-2)' }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          onClick={cycleMarket}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 14px',
            border: '1px solid var(--line)',
            borderRadius: 999,
            background: 'var(--paper)',
            fontSize: '.82rem',
            cursor: 'pointer',
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: mkt?.dot ?? 'var(--ink-3)' }} />
          <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{label}</span>
          <span style={{ color: 'var(--ink-3)' }}>▾</span>
        </div>
        <button className="btn btn-solid" onClick={() => set({ wizardOpen: true, wStep: 0 })}>
          <span>Mappa il mercato</span>
          <span className="gl">→</span>
        </button>
      </div>
    </header>
  );
}
