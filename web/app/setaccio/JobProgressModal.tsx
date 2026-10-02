'use client';

import { useId, type CSSProperties } from 'react';
import type { ViewProps } from './ctx';
import { useJobPolling } from './jobs';
import type { EnrichJob, JudgmentJob, ScrapeJob } from '../../lib/api';
import { EMPTY } from './helpers';
import { Button } from '../ds/components/Button';
import { Kicker } from '../ds/components/Kicker';
import { Dialog, CloseButton } from './ui/Dialog';
import { Pill, type PillTone } from './ui/Pill';
import { Stat } from './ui/Stat';
import { Bar } from './ui/Bar';
import { EmptyState } from './ui/Callout';

const KIND_LABEL: Record<string, string> = {
  enrich: 'Arricchimento',
  scrape: 'Mappatura territorio',
  discovery: 'Scoperta footprint',
  collect_signals: 'Raccolta segnali',
  judge: 'Giudizio',
  validate_export: 'Validazione e export',
};

/** Per-cell / per-run engine state → pill tone. Failures read in status red. */
const STATE_TONE: Record<string, PillTone> = {
  queued: 'muted',
  running: 'wash',
  filled: 'solid',
  done: 'solid',
  partial: 'outline',
  failed: 'ko',
  error: 'ko',
  not_found: 'muted',
  not_applicable: 'muted',
};
const toneOf = (s: string): PillTone => STATE_TONE[s] ?? 'muted';

/**
 * Live progress for the active job (mounted whenever st.activeJob is set, so
 * polling + cache-invalidation continue even if the operator hides the modal).
 * A single GET /api/jobs/:id drives every kind; the body shape differs by kind.
 */
export default function JobProgressModal({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const titleId = useId();
  const { job, status, terminal } = useJobPolling(st.activeJob);
  const kind = st.activeJob?.kind ?? 'enrich';
  if (!st.jobModalOpen) return null; // keep polling mounted upstream; just hide UI

  const hide = () => set({ jobModalOpen: false });
  const done = () => set({ jobModalOpen: false, activeJob: null });

  const statusLabel = status === 'done' ? 'Completato' : status === 'partial' ? 'Parziale' : terminal ? 'Errore' : 'In corso';
  const statusTone: PillTone = status === 'done' ? 'solid' : status === 'partial' ? 'outline' : terminal ? 'ko' : 'wash';

  // enrich/judgment carry per-item rows; scrape carries one row per CLI run.
  const enrich = kind === 'enrich' ? (job as EnrichJob | undefined) : undefined;
  const judg = kind !== 'enrich' && kind !== 'scrape' ? (job as JudgmentJob | undefined) : undefined;
  const scrape = kind === 'scrape' ? (job as ScrapeJob | undefined) : undefined;
  const scrapeAdded = scrape?.added ?? 0;
  const scraped = scrape?.runs?.reduce((s, r) => s + (r.scraped ?? 0), 0) ?? 0;
  const enriched = scrape?.runs?.reduce((s, r) => s + (r.enriched ?? 0), 0) ?? 0;
  // null = a cost this server cannot measure; show it as unknown, never as €0.
  const jobCost = kind === 'scrape' ? scrape?.costEur : enrich ? enrich.costEur : judg?.totalCostEur;

  const scrapeText = terminal
    ? status === 'done'
      ? `Mappatura completata: ${scrapeAdded} aziende aggiunte al database.`
      : status === 'partial'
        ? `Mappatura parziale: ${scrapeAdded} aziende aggiunte con i dati raccolti prima dell'interruzione.`
        : 'La mappatura si è interrotta. Riprova dal wizard.'
    : scraped === 0
      ? 'Sto avviando il browser e interrogando le fonti. Le aziende compaiono nel database man mano che arrivano; puoi chiudere questa finestra, il lavoro continua.'
      : enriched === 0
        ? 'Raccolta in corso: le aziende trovate entrano nel database mentre leggo le pagine.'
        : 'Arricchimento in corso: verifico il sito di ogni azienda e ne estraggo i contatti.';

  return (
    <Dialog onClose={hide} labelledBy={titleId} width={720}>
      <div className="sx-dialog__head">
        <div style={{ flex: 1 }}>
          <Kicker>{`Job · ${st.activeJob?.id?.slice(0, 8) ?? EMPTY}`}</Kicker>
          <h2 id={titleId} className="sx-dialog__title">{KIND_LABEL[kind] ?? kind}</h2>
        </div>
        <span role="status" aria-live="polite"><Pill tone={statusTone}>{statusLabel}</Pill></span>
        <CloseButton onClick={hide} label="Nascondi (il job continua)" />
      </div>

      <div className="sx-dialog__body">
        {/* SCRAPE: opaque, indeterminate */}
        {kind === 'scrape' && (
          <div className="sx-stack">
            <p className="sx-callout__text" style={{ marginTop: 0 }} aria-live="polite">{scrapeText}</p>
            {scraped > 0 && (
              <div className="sx-grid sx-grid--3 sx-grid--joined">
                <Stat variant="value-top" size="sm" value={scraped} label="trovate" />
                <Stat variant="value-top" size="sm" value={enriched} label="arricchite" />
                <Stat variant="value-top" size="sm" value={scrapeAdded} label="nuove nel database" />
              </div>
            )}
            {(scrape?.runs?.length ?? 0) > 1 && (
              <div className="sx-list">
                {scrape!.runs.map((r) => (
                  <div key={`${r.category}·${r.province}`} className="sx-list__item">
                    <Pill tone={toneOf(r.status)}>{r.status}</Pill>
                    <span className="sx-list__main sx-note">{r.category} · {r.province}</span>
                    {r.added !== undefined && <span className="sx-meta num">{r.added} nuove</span>}
                  </div>
                ))}
              </div>
            )}
            {terminal && scrape?.error && <p className="sx-meta">{scrape.error}</p>}
            {!terminal && <Bar label="Mappatura in corso" />}
            {terminal && (status === 'done' || (status === 'partial' && scrapeAdded > 0)) && (
              <div>
                <Button glyph="→" onClick={() => set({ jobModalOpen: false, activeJob: null, nav: 'aziende' })}>Vedi le nuove aziende</Button>
              </div>
            )}
          </div>
        )}

        {/* ENRICH: per-company × per-field cells */}
        {enrich && (
          <JobItems
            items={(enrich.items ?? []).map((it) => ({
              id: it.companyId,
              cells: Object.entries(it.cells).map(([field, c]) => ({
                key: field,
                state: c.status,
                title: c.value ? `${field}: ${c.value}${c.source ? ` (${c.source})` : ''}` : `${field}: ${c.status}`,
              })),
            }))}
          />
        )}

        {/* JUDGMENT: per-company × per-section chips */}
        {judg && (
          <JobItems
            items={(judg.items ?? []).map((it) => ({
              id: it.companyId,
              cells: Object.entries(it.sections).map(([name, s]) => ({ key: name, state: s.state, title: s.summary ?? `${name}: ${s.state}` })),
            }))}
          />
        )}
      </div>

      <div className="sx-dialog__foot">
        <span className="sx-meta">
          {kind === 'scrape' ? 'CLI di scraping' : `${(enrich ?? judg)?.items?.length ?? 0} aziende`} · costo{' '}
          <span className="num">{/* undefined = job not polled yet; null = the server cannot measure it. Neither is €0. */}
            {jobCost === undefined ? 'in attesa' : jobCost === null ? 'non misurato' : `€${jobCost.toFixed(3).replace('.', ',')}`}</span>
        </span>
        {terminal ? (
          <Button onClick={done} data-autofocus>Chiudi</Button>
        ) : (
          <Button variant="ghost" onClick={hide}>Continua in background</Button>
        )}
      </div>
    </Dialog>
  );
}

interface JobItem {
  id: string;
  cells: { key: string; state: string; title: string }[];
}

function JobItems({ items }: { items: JobItem[] }) {
  if (items.length === 0) return <EmptyState title="In coda" />;
  return (
    <div className="sx-stack" style={{ '--gap': '0.5rem' } as CSSProperties}>
      {items.slice(0, 60).map((it) => (
        <div key={it.id} className="mm-card mm-card--raised sx-row-flex" style={{ padding: '0.55rem 0.7rem', flexWrap: 'nowrap' }}>
          <span className="sx-meta num" style={{ width: 74, flex: 'none' }}>{it.id.slice(0, 8)}</span>
          <span className="sx-chips" style={{ gap: '0.35rem', flex: 1 }}>
            {it.cells.map((c) => (
              <Pill key={c.key} tone={toneOf(c.state)} title={c.title}>
                {c.key}
                <span className="sr-only">: {c.state}</span>
              </Pill>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
