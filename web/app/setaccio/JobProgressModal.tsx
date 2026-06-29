'use client';

import type { CSSProperties } from 'react';
import type { ViewProps } from './ctx';
import { useJobPolling } from './jobs';
import type { EnrichJob, JudgmentJob } from '../../lib/api';

const KIND_LABEL: Record<string, string> = {
  enrich: 'Arricchimento',
  scrape: 'Mappatura territorio',
  discovery: 'Scoperta footprint',
  collect_signals: 'Raccolta segnali',
  judge: 'Giudizio',
  validate_export: 'Validazione & export',
};

const STATE_STYLE: Record<string, CSSProperties> = {
  queued: { background: 'var(--paper-3)', color: 'var(--ink-3)' },
  running: { background: 'var(--accent-wash)', color: 'var(--accent)' },
  filled: { background: 'var(--accent)', color: 'var(--white)' },
  partial: { background: 'var(--accent-wash)', color: 'var(--accent)' },
  failed: { background: 'var(--paper-2)', color: 'var(--ink-3)' },
  not_found: { background: 'var(--paper-2)', color: 'var(--ink-3)' },
  not_applicable: { background: 'var(--paper-2)', color: 'var(--ink-3)' },
};
const cellStyle = (s: string): CSSProperties => ({
  fontSize: '.62rem', fontWeight: 600, padding: '3px 8px', borderRadius: 999,
  textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap',
  ...(STATE_STYLE[s] ?? STATE_STYLE.queued),
});

/**
 * Live progress for the active job (mounted whenever st.activeJob is set, so
 * polling + cache-invalidation continue even if the operator hides the modal).
 * A single GET /api/jobs/:id drives every kind; the body shape differs by kind.
 */
export default function JobProgressModal({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const { job, status, terminal } = useJobPolling(st.activeJob);
  const kind = st.activeJob?.kind ?? 'enrich';
  if (!st.jobModalOpen) return null; // keep polling mounted upstream; just hide UI

  const hide = () => set({ jobModalOpen: false });
  const done = () => set({ jobModalOpen: false, activeJob: null });

  const statusPill = (
    <span style={cellStyle(terminal ? (status === 'done' ? 'filled' : 'failed') : 'running')}>
      {status === 'done' ? 'Completato' : terminal ? 'Errore' : 'In corso…'}
    </span>
  );

  // enrich/judgment carry per-item rows; scrape is an opaque CLI (no items).
  const enrich = kind === 'enrich' ? (job as EnrichJob | undefined) : undefined;
  const judg = kind !== 'enrich' && kind !== 'scrape' ? (job as JudgmentJob | undefined) : undefined;
  const scrapeAdded = kind === 'scrape' ? (job as { added?: number } | undefined)?.added : undefined;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 210, background: 'rgba(33,27,20,.34)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <div className="agfade ag-scroll" style={{ width: '100%', maxWidth: 720, maxHeight: '86vh', overflowY: 'auto', background: 'var(--paper)', borderRadius: 18, boxShadow: 'var(--shadow-modal)', display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div style={{ padding: '20px 26px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <span className="kicker">Job · {st.activeJob?.id?.slice(0, 8) ?? '—'}</span>
            <h3 style={{ fontFamily: 'var(--serif)', fontSize: '1.4rem', fontWeight: 500, margin: '4px 0 0' }}>{KIND_LABEL[kind] ?? kind}</h3>
          </div>
          {statusPill}
          <button onClick={hide} title="Chiudi (il job continua)" style={{ fontSize: '1.05rem', color: 'var(--ink-3)', padding: '4px 8px', cursor: 'pointer' }}>✕</button>
        </div>

        {/* body */}
        <div style={{ padding: '22px 26px', flex: 1 }}>
          {/* SCRAPE — opaque, indeterminate */}
          {kind === 'scrape' && (
            <div>
              <p style={{ fontFamily: 'var(--serif)', fontSize: '1.02rem', color: 'var(--ink-2)', lineHeight: 1.6, marginBottom: 16 }}>
                {terminal
                  ? status === 'done'
                    ? `Mappatura completata — ${scrapeAdded ?? 0} aziende aggiunte al database.`
                    : 'La mappatura si è interrotta. Riprova dal wizard.'
                  : 'Sto avviando il browser e interrogando le fonti. Può richiedere alcuni minuti; puoi chiudere questa finestra, il lavoro continua.'}
              </p>
              {!terminal && (
                <div style={{ height: 7, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden' }}>
                  <div className="ag-indeterminate" style={{ height: '100%', width: '40%', background: 'var(--accent)', borderRadius: 999 }} />
                </div>
              )}
              {terminal && status === 'done' && (
                <button className="btn btn-solid" onClick={() => set({ jobModalOpen: false, activeJob: null, nav: 'aziende' })} style={{ marginTop: 6 }}>
                  <span>Vedi le nuove aziende</span><span className="gl">→</span>
                </button>
              )}
            </div>
          )}

          {/* ENRICH — per-company × per-field cells */}
          {enrich && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(enrich.items ?? []).slice(0, 60).map((it) => (
                <div key={it.companyId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, background: 'var(--paper-2)', border: '1px solid var(--line)' }}>
                  <span style={{ fontSize: '.72rem', color: 'var(--ink-3)', fontFamily: 'var(--mono, monospace)', flex: 'none', width: 74 }}>{it.companyId.slice(0, 8)}</span>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                    {Object.entries(it.cells).map(([field, c]) => (
                      <span key={field} style={cellStyle(c.status)} title={c.value ? `${field}: ${c.value}${c.source ? ` (${c.source})` : ''}` : field}>
                        {field}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
              {(enrich.items?.length ?? 0) === 0 && <Empty label="In coda…" />}
            </div>
          )}

          {/* JUDGMENT — per-company × per-section chips */}
          {judg && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(judg.items ?? []).slice(0, 60).map((it) => (
                <div key={it.companyId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, background: 'var(--paper-2)', border: '1px solid var(--line)' }}>
                  <span style={{ fontSize: '.72rem', color: 'var(--ink-3)', fontFamily: 'var(--mono, monospace)', flex: 'none', width: 74 }}>{it.companyId.slice(0, 8)}</span>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                    {Object.entries(it.sections).map(([name, s]) => (
                      <span key={name} style={cellStyle(s.state)} title={s.summary ?? name}>{name}</span>
                    ))}
                  </span>
                </div>
              ))}
              {(judg.items?.length ?? 0) === 0 && <Empty label="In coda…" />}
            </div>
          )}
        </div>

        {/* footer */}
        <div style={{ padding: '14px 26px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '.74rem', color: 'var(--ink-3)' }}>
            {kind === 'scrape' ? 'CLI di scraping' : `${(job as { items?: unknown[] } | undefined)?.items?.length ?? 0} aziende`} · costo €{(((job as { costEur?: number; totalCostEur?: number } | undefined)?.costEur ?? (job as { totalCostEur?: number } | undefined)?.totalCostEur) ?? 0).toFixed(3)}
          </span>
          {terminal ? (
            <button className="btn btn-solid" onClick={done}><span>Chiudi</span></button>
          ) : (
            <button onClick={hide} style={{ fontSize: '.86rem', fontWeight: 600, color: 'var(--ink-2)', padding: '8px 12px', cursor: 'pointer' }}>Continua in background</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div style={{ padding: '28px 0', textAlign: 'center', fontSize: '.86rem', color: 'var(--ink-3)' }}>{label}</div>;
}
