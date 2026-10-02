import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../ds/components/Icon';

export type PillTone = 'solid' | 'wash' | 'outline' | 'muted' | 'ok' | 'ko';

/** Status capsule in mono caps. Tone carries meaning; the text always says it too. */
export function Pill({ tone = 'muted', title, children }: { tone?: PillTone; title?: string; children: ReactNode }) {
  return (
    <span className={`sx-pill sx-pill--${tone}`} title={title}>
      {children}
    </span>
  );
}

export type DotTone = 'ok' | 'ko' | 'warn' | 'run' | 'idle' | 'muted';

const NODE: Record<DotTone, IconName> = {
  ok: 'node-ok', ko: 'node-ko', warn: 'node-run', run: 'node-run', idle: 'node-wait', muted: 'node-wait',
};

/** Status node followed by its label. Shape and colour both carry the state. */
export function StatusDot({ tone, children }: { tone: DotTone; children: ReactNode }) {
  return (
    <span className="sx-dot">
      <span className={`sx-dot__mark sx-dot__mark--${tone}`}><Icon name={NODE[tone]} size={12} /></span>
      {children}
    </span>
  );
}
