import type { Nav } from './data';
import { navItemStyle } from './helpers';
import type { ViewProps } from './ctx';

type Item = [Nav, string, string]; // id, label, badge
const GROUPS: [string, string, Item[]][] = [
  ['01', 'Cockpit', [['home', 'Panoramica', '']]],
  ['02', 'Mercati & territorio', [['mercati', 'Dataset', '4'], ['aziende', 'Aziende', ''], ['italia', 'Mappa Italia', '']]],
  ['03', 'Raffinazione', [['raff', 'Arricchimento & imbuto', ''], ['val', 'Valutazione', '']]],
  ['04', 'Intelligence', [['analytics', 'Analytics', '']]],
  ['05', 'Sistema', [['sistema', 'Run & crediti', ''], ['liste', 'Liste finali', '7']]],
];

export default function Sidebar({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  return (
    <aside
      style={{
        width: 246,
        flex: 'none',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--paper-2)',
        borderRight: '1px solid var(--line)',
      }}
    >
      {/* brand */}
      <div style={{ padding: '22px 22px 18px', display: 'flex', alignItems: 'center', gap: 11, borderBottom: '1px solid var(--line-soft)' }}>
        <svg width="30" height="30" viewBox="0 0 32 32" className="sketch" style={{ overflow: 'visible' }}>
          <path className="ink" d="M5 26 L13 9 L16 17 L19 9 L27 26" />
          <circle className="node" cx="16" cy="6" r="2.4" />
          <path className="ink" d="M16 8.4 L16 14" />
        </svg>
        <div>
          <div style={{ fontFamily: 'var(--serif)', fontSize: '1.06rem', fontWeight: 500, letterSpacing: '-.01em', lineHeight: 1 }}>Setaccio</div>
          <div style={{ fontSize: '.62rem', fontWeight: 600, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--ink-3)', marginTop: 3 }}>
            Intelligence Commerciale
          </div>
        </div>
      </div>

      {/* nav */}
      <nav className="ag-scroll" style={{ flex: 1, overflowY: 'auto', padding: '12px 12px' }}>
        {GROUPS.map(([num, label, items]) => (
          <div key={num} style={{ marginBottom: 2 }}>
            <div style={{ display: 'flex', gap: 7, fontSize: '.6rem', fontWeight: 700, letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--ink-3)', padding: '13px 11px 6px' }}>
              <span style={{ color: 'var(--accent-line)' }}>{num}</span>
              <span>{label}</span>
            </div>
            {items.map(([id, lab, badge]) => {
              const active = st.nav === id;
              return (
                <button key={id} className="ag-nav" onClick={() => set({ nav: id })} style={navItemStyle(active)}>
                  <span>{lab}</span>
                  <span style={{ marginLeft: 'auto', fontSize: '.64rem', fontWeight: 600, color: 'var(--ink-3)', display: badge ? undefined : 'none' }}>{badge}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* footer stats */}
      <div style={{ padding: '14px 18px', borderTop: '1px solid var(--line-soft)', fontSize: '.72rem', color: 'var(--ink-3)', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ whiteSpace: 'nowrap' }}>Nodi attivi</span>
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>6</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ whiteSpace: 'nowrap' }}>Coda di lavoro</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', boxShadow: '0 0 8px var(--ok)' }} />
            12%
          </span>
        </div>
      </div>
    </aside>
  );
}
