import { useId, type CSSProperties } from 'react';
import { WIZ_CATS, WIZ_PROV, WIZ_SOURCES, WIZ_DEPTH } from './data';
import { fmt } from './helpers';
import type { ViewProps } from './ctx';
import { useScrapeJob } from './jobs';
import { MiloAvatar } from '../ds/components/MiloAvatar';
import { Button } from '../ds/components/Button';
import { Kicker } from '../ds/components/Kicker';
import { Dialog, CloseButton } from './ui/Dialog';
import { Chip, OptionCard } from './ui/Choice';
import { Bar } from './ui/Bar';
import { Stat } from './ui/Stat';
import { Pill } from './ui/Pill';
import { Callout } from './ui/Callout';
import { cx } from '../ds/components/cx';

export const MILO_SEEN_KEY = 'ag_milo_seen';

// ============================ MILO FAB ============================
export function MiloFab({ set, isNew }: Pick<ViewProps, 'set'> & { isNew: boolean }) {
  return (
    <button
      type="button"
      className="sx-fab"
      onClick={() => set({ miloOpen: true, miloStep: 0 })}
      aria-label={isNew ? 'Apri Milo, la guida: tour non ancora visto' : 'Apri Milo, la guida'}
      title="Milo"
    >
      <MiloAvatar size={40} interactive decorative />
      {isNew && <span className="sx-fab__new" aria-hidden="true" />}
    </button>
  );
}

// ============================ MILO TOUR ============================
export function MiloModal({ st, set, onSeen }: Pick<ViewProps, 'st' | 'set'> & { onSeen: () => void }) {
  const titleId = useId();
  const closeMilo = () => {
    try {
      localStorage.setItem(MILO_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    onSeen();
    set({ miloOpen: false });
  };
  const miloNext = () => set({ miloStep: Math.min(3, st.miloStep + 1) });
  const miloPrev = () => set({ miloStep: Math.max(0, st.miloStep - 1) });

  const steps = [
    { rail: 'Benvenuto', title: 'Come funziona Setaccio', t: 'Ciao, sono Milo. Ti porto via un minuto: questo sistema trasforma un territorio grezzo in una lista di aziende che vale davvero la pena chiamare.', cta: 'Andiamo', act: miloNext },
    { rail: 'Territorio', title: 'Parti dalla mappa', t: 'Si parte dal territorio. Scegli settore e provincia e vedi subito quante aziende esistono. Il Veneto è già acquisito: prova a cliccarlo.', cta: 'Apri la mappa', act: () => set({ nav: 'italia', miloStep: Math.min(3, st.miloStep + 1) }) },
    { rail: 'Raffinazione', title: 'Raffina, non accumulare', t: 'Poi raffini: aggiungi solo i dati che servono, taglia il rumore con l’imbuto e lascia che il giudice trovi i veri target. Niente sprechi.', cta: 'Vedi la raffinazione', act: () => set({ nav: 'raff', miloStep: Math.min(3, st.miloStep + 1) }) },
    { rail: 'Crediti e liste', title: 'Tieni il controllo', t: 'Ai crediti dei provider ci penso io: ti avviso quando qualcosa sta per finire. Le liste pronte le trovi in Sistema. Mi trovi sempre qui in basso a destra.', cta: 'Ho capito, inizia', act: closeMilo },
  ];
  const c = steps[st.miloStep] || steps[0];
  const last = st.miloStep === steps.length - 1;

  return (
    <Dialog onClose={closeMilo} labelledBy={titleId} width={680} split>
      <div className="sx-milo-rail" style={{ background: 'var(--accent-wash)' }}>
        <div className="sx-milo-id">
          <MiloAvatar size={48} decorative />
          <div>
            <div className="sx-milo-id__name">Milo</div>
            <span className="kicker kicker--muted">La tua guida</span>
          </div>
        </div>
        <ol className="sx-steps" aria-label="Tappe del tour" style={{ listStyle: 'none' }}>
          {steps.map((s, i) => (
            <li key={s.rail}>
              <button
                type="button"
                className={cx('sx-step', i < st.miloStep && 'sx-step--done')}
                aria-current={i === st.miloStep ? 'step' : undefined}
                onClick={() => set({ miloStep: i })}
              >
                <span className="sx-step__num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                <span>{s.rail}</span>
              </button>
            </li>
          ))}
        </ol>
        <Button variant="ghost" size="sm" onClick={closeMilo} className="sx-milo-skip">Salta il tour</Button>
      </div>
      <div className="sx-milo-main">
        <div className="sx-panelhead">
          <Kicker>{`Tappa ${st.miloStep + 1} di ${steps.length}`}</Kicker>
          <CloseButton onClick={closeMilo} label="Chiudi il tour" />
        </div>
        <h2 id={titleId} className="sx-dialog__title" style={{ fontSize: 'var(--fs-ui-2xl)', margin: '0.4rem 0 0.9rem' }}>{c.title}</h2>
        <p className="sx-milo-text" aria-live="polite">{c.t}</p>
        <div style={{ margin: '0.5rem 0 1.1rem' }}>
          <Bar value={(st.miloStep / (steps.length - 1)) * 100} size="thin" label="Avanzamento del tour" />
        </div>
        <div className="sx-row-flex" style={{ marginTop: 'auto' }}>
          {st.miloStep > 0 && <Button variant="outline" glyph="←" onClick={miloPrev}>Indietro</Button>}
          <Button glyph={last ? undefined : '→'} onClick={c.act} data-autofocus style={{ flex: 1 }}>{c.cta}</Button>
        </div>
      </div>
    </Dialog>
  );
}

// ============================ WIZARD ============================
const STEP_LABELS = ['Cosa', 'Dove', 'Fonti', 'Profondità', 'Preflight'];

export function WizardModal({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const titleId = useId();
  const scrapeJob = useScrapeJob();
  const toggleArr = (field: 'wCats' | 'wProv' | 'wSrc', val: string) => {
    const a = st[field];
    scrapeJob.reset(); // a changed selection gets a fresh verdict from the engine
    set({ [field]: a.includes(val) ? a.filter((x) => x !== val) : [...a, val] } as Partial<ViewProps['st']>);
  };
  const closeWizard = () => set({ wizardOpen: false });
  const wNext = () => {
    if (st.wStep < 4) {
      set({ wStep: st.wStep + 1 });
      return;
    }
    // Final step → launch the REAL scrape: one engine run per category × province,
    // with the selected sources. A refusal (e.g. a paid source) keeps the wizard
    // open with the engine's reason, so the operator can change the selection.
    if (!st.wCats.length || !st.wProv.length) {
      set({ wizardOpen: false, nav: 'mercati' });
      return;
    }
    scrapeJob.mutate(
      { categories: st.wCats, provinces: st.wProv, sources: st.wSrc, depth: st.wDepth },
      { onSuccess: (r) => set({ activeJob: { id: r.jobId, kind: 'scrape' }, jobModalOpen: true, wizardOpen: false }) },
    );
  };
  const wBack = () => set({ wStep: Math.max(0, st.wStep - 1) });

  const nicheN = Math.max(1, st.wCats.length);
  const provN = Math.max(1, st.wProv.length);
  const qpn = { rapido: 1, completo: 3, esteso: 5 }[st.wDepth];
  const dmult = { rapido: 0.6, completo: 1, esteso: 1.7 }[st.wDepth];
  const depthObj = WIZ_DEPTH.find((d) => d.id === st.wDepth)!;
  const queries = st.wCats.flatMap((c) => st.wProv.map((p) => c + ' · ' + p)).slice(0, 8);
  const pfSources = WIZ_SOURCES.filter((s) => st.wSrc.includes(s.id));
  // rapido is one PagineGialle page per capital: ~20 companies per search, ~40
  // with Maps (measured on live runs). The other depths keep the prototype's
  // province-scale estimate.
  const rapido = st.wDepth === 'rapido';
  const perSearch = st.wSrc.includes('maps') ? 40 : 20;
  const pf = {
    aziende: rapido ? '~' + fmt(nicheN * provN * perSearch) : fmt(Math.round(nicheN * provN * 1850 * dmult)),
    queries: fmt(nicheN * provN * qpn),
    comuni: rapido ? provN : Math.round(provN * (st.wDepth === 'esteso' ? 11 : 7)),
    fonti: pfSources.length,
    overlap: '~12%',
    dur: depthObj.dur,
  };

  const STEP_HEAD: [string, string, string?][] = [
    ['01 · Cosa vuoi mappare?', 'Settore, categoria, parole chiave', 'Niente fatturato o dimensione adesso. Prima costruisci il perimetro grezzo.'],
    ['02 · Dove?', 'Regione, provincia, comuni', 'Seleziona i territori da intercettare. I comuni satellite si attivano da soli oltre 200 risultati.'],
    ['03 · Da quali fonti?', 'Sorgenti da interrogare'],
    ['04 · Quanto in profondità?', 'Profondità della raccolta'],
    ['05 · Preflight', 'Prima di mappare'],
  ];
  const [kick, title, lead] = STEP_HEAD[st.wStep];

  return (
    <Dialog onClose={closeWizard} labelledBy={titleId} width={780} dismissOnScrim={false}>
      <div className="sx-dialog__head">
        <ol className="sx-wizrail" aria-label="Passi" style={{ listStyle: 'none' }}>
          {STEP_LABELS.map((label, i) => (
            <li key={label} className="sx-row-flex" style={{ gap: '0.45rem' }}>
              <span className={cx('sx-wizrail__step', st.wStep > i && 'sx-wizrail__step--done')} aria-current={st.wStep === i ? 'step' : undefined}>
                <span className="sx-wizrail__num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                <span>{label}</span>
              </span>
              {i !== STEP_LABELS.length - 1 && <span className="sx-wizrail__sep" aria-hidden="true" />}
            </li>
          ))}
        </ol>
        <CloseButton onClick={closeWizard} label="Chiudi la mappatura" />
      </div>

      <div className="sx-dialog__body sx-enter" key={st.wStep}>
        <Kicker>{kick}</Kicker>
        <h2 id={titleId} className="sx-dialog__title" style={{ margin: '0.5rem 0 0.4rem' }}>{title}</h2>
        {lead && <p className="sx-note" style={{ marginBottom: '1.25rem' }}>{lead}</p>}
        {!lead && <div style={{ height: '0.85rem' }} />}

        {st.wStep === 0 && (
          <div className="sx-chips" role="group" aria-label="Categorie">
            {WIZ_CATS.map((c) => <Chip key={c} pressed={st.wCats.includes(c)} onClick={() => toggleArr('wCats', c)}>{c}</Chip>)}
          </div>
        )}
        {st.wStep === 1 && (
          <div className="sx-chips" role="group" aria-label="Province">
            {WIZ_PROV.map((p) => <Chip key={p} pressed={st.wProv.includes(p)} onClick={() => toggleArr('wProv', p)}>{p}</Chip>)}
          </div>
        )}
        {st.wStep === 2 && (
          <div className="sx-grid sx-grid--2" role="group" aria-label="Fonti">
            {WIZ_SOURCES.map((s) => (
              <OptionCard
                key={s.id}
                selected={st.wSrc.includes(s.id)}
                onClick={() => toggleArr('wSrc', s.id)}
                title={s.nome}
                aside={<Pill tone={s.costo === 'Gratis' ? 'outline' : 'muted'}>{s.costo}</Pill>}
                description={s.tipo}
              >
                <span className="sx-meta" style={{ display: 'block', marginTop: '0.35rem' }}>Copertura prevista: {s.cov}</span>
              </OptionCard>
            ))}
          </div>
        )}
        {st.wStep === 3 && (
          <div className="sx-stack" role="radiogroup" aria-label="Profondità" style={{ '--gap': '0.7rem' } as CSSProperties}>
            {WIZ_DEPTH.map((d) => (
              <OptionCard key={d.id} kind="radio" selected={st.wDepth === d.id} onClick={() => set({ wDepth: d.id })} title={d.nome} description={d.desc} />
            ))}
          </div>
        )}
        {st.wStep === 4 && (
          <>
            <div className="sx-grid sx-grid--kpi sx-grid--joined" style={{ marginBottom: '1.25rem' }}>
              <Stat variant="value-top" size="sm" tone="raised" value={pf.aziende} label="aziende stimate" />
              <Stat variant="value-top" size="sm" tone="raised" value={pf.queries} label="query" />
              <Stat variant="value-top" size="sm" tone="raised" value={pf.comuni} label="comuni" />
              <Stat variant="value-top" size="sm" tone="raised" value={pf.fonti} label="fonti" />
            </div>
            <div style={{ marginBottom: '1.1rem' }}>
              <Kicker muted>Strategia generata</Kicker>
              <div className="sx-chips" style={{ marginTop: '0.6rem' }}>
                {queries.length
                  ? queries.map((t, i) => <Pill key={t + i} tone="wash">{t}</Pill>)
                  : <span className="sx-meta">Nessuna query: scegli almeno una categoria e una provincia.</span>}
              </div>
            </div>
            <div className="mm-card mm-card--raised mm-card--tight sx-row-flex" style={{ justifyContent: 'space-between', gap: '1rem' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="sx-meta" style={{ marginBottom: '0.35rem' }}>Durata relativa · sovrapposizione database {pf.overlap}</div>
                <Bar value={pf.dur} label="Durata relativa" />
              </div>
              <div className="sx-meta" style={{ whiteSpace: 'nowrap' }}>Costo scraping <strong className="num">€0</strong></div>
            </div>
          </>
        )}
      </div>

      {scrapeJob.error && (
        <div style={{ padding: '0 1.5rem 1rem' }}>
          <Callout tone="error" role="alert">Mappatura non avviata: {scrapeJob.error.message}</Callout>
        </div>
      )}

      <div className="sx-dialog__foot">
        <Button variant="ghost" glyph="←" onClick={wBack} style={{ visibility: st.wStep === 0 ? 'hidden' : undefined }}>Indietro</Button>
        <span className="sx-meta num">Passo {st.wStep + 1} di 5</span>
        <Button glyph="→" onClick={wNext} disabled={scrapeJob.isPending}>{st.wStep >= 4 ? 'Mappa il mercato' : 'Continua'}</Button>
      </div>
    </Dialog>
  );
}
