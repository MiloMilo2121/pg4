'use client';

import { useCallback, useEffect, useState } from 'react';
import './setaccio.css';
import { INITIAL_STATE, type State } from './data';
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
import { MiloFab, MiloModal, WizardModal, MILO_SEEN_KEY } from './Modals';
import JobProgressModal from './JobProgressModal';
import CompanyDrawer from './CompanyDrawer';
import StatusBar from './StatusBar';
import CommandPalette from './CommandPalette';
import HelpDialog from './HelpDialog';
import { useShortcuts } from './useShortcuts';

export default function SetaccioPage() {
  const [st, setSt] = useState<State>(INITIAL_STATE);
  // Below 1100px the sidebar is an off-canvas drawer; navigating closes it.
  const [menuOpen, setMenuOpen] = useState(false);
  const set = useCallback((patch: Partial<State>) => {
    if (patch.nav) setMenuOpen(false);
    setSt((s) => ({ ...s, ...patch }));
  }, []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const openHelp = useCallback(() => { setPaletteOpen(false); setHelpOpen(true); }, []);

  useShortcuts({
    overlayOpen: paletteOpen || helpOpen || menuOpen || st.miloOpen || st.wizardOpen || st.jobModalOpen || !!st.selectedCompanyId,
    go: (nav) => set({ nav }),
    palette: () => { setHelpOpen(false); setPaletteOpen((o) => !o); },
    help: openHelp,
    // "/" jumps to the archive search; the field mounts with the view, so focus it next frame.
    search: () => {
      set({ nav: 'aziende' });
      requestAnimationFrame(() => document.getElementById('sx-azi-search')?.focus());
    },
  });

  // First visit: the Milo button carries a "new" mark until the tour is seen.
  // The tour no longer opens by itself: a dialog that steals focus on arrival
  // hides the product behind it. localStorage exists only in the browser, so it
  // is read after hydration.
  const [miloSeen, setMiloSeen] = useState(true);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- post-hydration read of browser-only storage
      setMiloSeen(localStorage.getItem(MILO_SEEN_KEY) === '1');
    } catch {
      /* storage blocked: treat as seen */
    }
  }, []);

  function renderView() {
    switch (st.nav) {
      case 'home': return <Home set={set} />;
      case 'mercati': return <Mercati set={set} />;
      case 'aziende': return <Aziende st={st} set={set} />;
      case 'italia': return <Italia st={st} set={set} />;
      case 'raff': return <Raffinazione st={st} set={set} />;
      case 'val': return <Valutazione st={st} set={set} />;
      case 'analytics': return <Analytics st={st} set={set} />;
      case 'liste': return <Liste />;
      case 'sistema': return <Sistema />;
      default: return null;
    }
  }

  return (
    <div className="sx-app">
      <Sidebar st={st} set={set} open={menuOpen} onClose={closeMenu} onPalette={() => setPaletteOpen(true)} />
      <main className="sx-main">
        <Topbar st={st} set={set} menuOpen={menuOpen} onMenu={() => setMenuOpen((o) => !o)} />
        {/* The Italia view manages its own full-height layout (no scroll wrapper). */}
        {/* Focusable so keyboard users can scroll views without interactive content. */}
        <div className={st.nav === 'italia' ? 'sx-stage' : 'sx-scroll'} key={st.nav} tabIndex={0} role="region" aria-label="Contenuto della vista">
          {renderView()}
        </div>
        <StatusBar st={st} set={set} onHelp={openHelp} />
      </main>

      <MiloFab set={set} isNew={!miloSeen} />
      {st.miloOpen && <MiloModal st={st} set={set} onSeen={() => setMiloSeen(true)} />}
      {st.wizardOpen && <WizardModal st={st} set={set} />}
      {st.activeJob && <JobProgressModal st={st} set={set} />}
      {st.selectedCompanyId && <CompanyDrawer st={st} set={set} />}
      {paletteOpen && <CommandPalette set={set} onClose={() => setPaletteOpen(false)} onHelp={openHelp} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
