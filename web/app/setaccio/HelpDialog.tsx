'use client';

import { useId } from 'react';
import { NAV_ITEMS } from './nav';
import { Dialog, CloseButton } from './ui/Dialog';
import { Kicker } from '../ds/components/Kicker';
import { Kbd } from '../ds/components/Kbd';

const GENERAL: [string[], string][] = [
  [['⌘', 'K'], 'Cerca o comanda (anche Ctrl K)'],
  [['/'], 'Cerca nell’archivio aziende'],
  [['?'], 'Questo elenco'],
  [['esc'], 'Chiudi la finestra aperta'],
];

/** The keyboard map, opened with "?" or from the status bar. */
export default function HelpDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  return (
    <Dialog onClose={onClose} labelledBy={titleId} width={560}>
      <div className="sx-dialog__head">
        <div style={{ flex: 1 }}>
          <Kicker>Tastiera</Kicker>
          <h2 id={titleId} className="sx-dialog__title">Scorciatoie</h2>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      <div className="sx-dialog__body sx-keys">
        <dl className="sx-keys__list">
          {GENERAL.map(([keys, label]) => (
            <div key={label} className="sx-keys__row">
              <dt>{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
        <Kicker muted>Vai a</Kicker>
        <dl className="sx-keys__list">
          {NAV_ITEMS.map((n) => (
            <div key={n.id} className="sx-keys__row">
              <dt><Kbd>g</Kbd><Kbd>{n.key}</Kbd></dt>
              <dd>{n.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Dialog>
  );
}
