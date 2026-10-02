'use client';

import { skipToken, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ViewProps } from './ctx';
import { useCost, useHealth, fmtEur } from './queries';
import { StatusDot } from './ui/Pill';
import { Kbd } from '../ds/components/Kbd';

const KIND: Record<string, string> = {
  enrich: 'arricchimento', scrape: 'mappatura', discovery: 'footprint',
  collect_signals: 'segnali', judge: 'giudizio', validate_export: 'validazione',
};

/** Round-trip time of /api/health, measured in the browser every 15 s. */
function useApiLatency() {
  return useQuery({
    queryKey: ['api-latency'],
    queryFn: async () => {
      const t0 = performance.now();
      await api.health();
      return Math.round(performance.now() - t0);
    },
    refetchInterval: 15_000,
    retry: false,
  });
}

interface StatusBarProps extends Pick<ViewProps, 'st' | 'set'> {
  onHelp: () => void;
}

/** IDE-style status line: engine, latency, running job, session cost, dataset size, version. */
export default function StatusBar({ st, set, onHelp }: StatusBarProps) {
  const health = useHealth();
  const latency = useApiLatency();
  const cost = useCost();
  // Reads the job the progress modal polls; never fetches on its own.
  const job = useQuery<{ status?: string }>({ queryKey: ['job', st.activeJob?.id ?? null], queryFn: skipToken });
  const offline = health.isError || latency.isError;
  const engine = offline ? 'motore offline' : 'motore pronto';
  const status = job.data?.status;

  return (
    <footer className="sx-statusbar night" aria-label="Stato del sistema">
      <span role="status"><StatusDot tone={offline ? 'ko' : 'ok'}>{engine}</StatusDot></span>
      <span className="sx-statusbar__item num" title="Tempo di risposta dell’API locale">
        api {latency.data !== undefined ? `${latency.data} ms` : 'n/d'}
      </span>
      {st.activeJob && (
        <button type="button" className="sx-statusbar__job" onClick={() => set({ jobModalOpen: true })}>
          <StatusDot tone={status === 'error' || status === 'failed' ? 'ko' : status === 'done' ? 'ok' : 'run'}>
            job · {KIND[st.activeJob.kind] ?? st.activeJob.kind} · {status ?? 'avvio'}
          </StatusDot>
        </button>
      )}
      <span className="sx-statusbar__spacer" />
      <span className="sx-statusbar__item sx-statusbar__wide num">sessione {fmtEur(cost.data?.liveSessionCostEur)}</span>
      <span className="sx-statusbar__item sx-statusbar__wide num">{health.data?.companies?.toLocaleString('it-IT') ?? 'n/d'} aziende</span>
      <button type="button" className="sx-statusbar__item sx-statusbar__help" onClick={onHelp} aria-keyshortcuts="?">
        <Kbd>?</Kbd> <span className="sx-statusbar__wide">scorciatoie</span>
      </button>
      <span className="sx-statusbar__item sx-statusbar__wide num">web {process.env.NEXT_PUBLIC_APP_VERSION}</span>
    </footer>
  );
}
