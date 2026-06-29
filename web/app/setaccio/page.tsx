'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import './setaccio.css';
import { INITIAL_STATE, type State } from './data';
import type { ViewProps } from './ctx';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import Home from './views/Home';
import Mercati from './views/Mercati';
import Aziende from './views/Aziende';
import Italia from './views/Italia';
import Raffinazione from './views/Raffinazione';
import Valutazione from './views/Valutazione';
import Analytics from './views/Analytics';
import Liste from './views/Liste';
import Sistema from './views/Sistema';
import { MiloFab, MiloModal, WizardModal } from './Modals';

const PAGE_BG =
  'radial-gradient(120% 80% at 88% -10%, rgba(151,88,47,0.06), transparent 55%), ' +
  'radial-gradient(90% 60% at 0% 100%, rgba(151,88,47,0.04), transparent 55%)';

export default function SetaccioPage() {
  const [st, setSt] = useState<State>(INITIAL_STATE);
  const set = useCallback((patch: Partial<State>) => setSt((s) => ({ ...s, ...patch })), []);

  // animated count-up for the Italia map tooltip (cubic ease-out over 420ms).
  const rafRef = useRef<number | null>(null);
  const startCount = useCallback((target: number) => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const t0 = performance.now();
    const dur = 420;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      setSt((s) => ({ ...s, hoverCount: Math.round(target * (1 - Math.pow(1 - k, 3))) }));
      if (k < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // first-visit onboarding: open Milo unless the tour was already seen.
  useEffect(() => {
    try {
      if (!localStorage.getItem('ag_milo_seen')) setSt((s) => ({ ...s, miloOpen: true }));
    } catch {
      /* ignore */
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const vp: ViewProps = { st, set, startCount };

  function renderView() {
    switch (st.nav) {
      case 'home': return <Home set={set} />;
      case 'mercati': return <Mercati set={set} />;
      case 'aziende': return <Aziende st={st} set={set} />;
      case 'italia': return <Italia {...vp} />;
      case 'raff': return <Raffinazione st={st} set={set} />;
      case 'val': return <Valutazione st={st} set={set} />;
      case 'analytics': return <Analytics st={st} set={set} />;
      case 'liste': return <Liste />;
      case 'sistema': return <Sistema />;
      default: return null;
    }
  }

  // The Italia view manages its own full-height layout (no scroll wrapper).
  const isItalia = st.nav === 'italia';

  return (
    <div className="setaccio-root">
      <div
        style={{
          display: 'flex',
          height: '100%',
          width: '100%',
          overflow: 'hidden',
          background: 'var(--paper)',
          color: 'var(--ink)',
          fontFamily: 'var(--sans)',
          backgroundImage: PAGE_BG,
        }}
      >
        <Sidebar st={st} set={set} />
        <main style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          <Topbar st={st} set={set} />
          {isItalia ? (
            <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>{renderView()}</div>
          ) : (
            <div className="ag-scroll" style={{ flex: 1, overflowY: 'auto' }}>{renderView()}</div>
          )}
        </main>

        <MiloFab set={set} />
        {st.miloOpen && <MiloModal st={st} set={set} />}
        {st.wizardOpen && <WizardModal st={st} set={set} />}
      </div>
    </div>
  );
}
