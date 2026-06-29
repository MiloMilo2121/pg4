import type { CSSProperties } from 'react';
import { WIZ_CATS, WIZ_PROV, WIZ_SOURCES, WIZ_DEPTH } from './data';
import { fmt, chipStyle } from './helpers';
import type { ViewProps } from './ctx';
import MiloAvatar from './MiloAvatar';

const MILO_SEEN_KEY = 'ag_milo_seen';

// ============================ MILO FAB ============================
export function MiloFab({ set }: Pick<ViewProps, 'set'>) {
  return (
    <button
      onClick={() => set({ miloOpen: true, miloStep: 0 })}
      title="Milo"
      style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 150, width: 60, height: 60, borderRadius: '50%', background: 'var(--paper)', border: '1px solid var(--accent-line)', boxShadow: 'var(--shadow-pop)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
    >
      <MiloAvatar size={36} />
    </button>
  );
}

// ============================ MILO MODAL ============================
export function MiloModal({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const closeMilo = () => {
    try {
      localStorage.setItem(MILO_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    set({ miloOpen: false });
  };
  const miloNext = () => set({ miloStep: Math.min(3, st.miloStep + 1) });
  const miloPrev = () => set({ miloStep: Math.max(0, st.miloStep - 1) });

  const steps = [
    { rail: 'Benvenuto', title: 'Come funziona Setaccio', t: 'Ciao, sono Milo. Ti porto via un minuto: questo sistema trasforma un territorio grezzo in una lista di aziende che vale davvero la pena chiamare.', cta: 'Andiamo →', act: miloNext },
    { rail: 'Territorio', title: 'Parti dalla mappa', t: 'Si parte dal territorio. Scegli settore e provincia e vedi subito quante aziende esistono — il Veneto è già acquisito, prova a cliccarlo.', cta: 'Apri la mappa →', act: () => { set({ nav: 'italia', miloStep: Math.min(3, st.miloStep + 1) }); } },
    { rail: 'Raffinazione', title: 'Raffina, non accumulare', t: 'Poi raffini: aggiungi solo i dati che servono, taglia il rumore con l’imbuto e lascia che il giudice trovi i veri target. Niente sprechi.', cta: 'Vedi la raffinazione →', act: () => { set({ nav: 'raff', miloStep: Math.min(3, st.miloStep + 1) }); } },
    { rail: 'Crediti & liste', title: 'Tieni il controllo', t: 'Ai crediti dei provider ci penso io: ti avviso quando qualcosa sta per finire. Le liste pronte le trovi in Sistema. Mi trovi sempre qui in basso a destra.', cta: 'Ho capito, inizia', act: closeMilo },
  ];
  const c = steps[st.miloStep] || steps[0];
  const prog = (st.miloStep / (steps.length - 1)) * 100;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 220, background: 'rgba(33,27,20,.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <div className="agfade" style={{ width: '100%', maxWidth: 662, background: 'var(--paper)', borderRadius: 20, boxShadow: 'var(--shadow-modal)', overflow: 'hidden', display: 'flex', border: '1px solid var(--accent-line)' }}>
        {/* rail */}
        <div style={{ width: 230, flex: 'none', background: 'var(--accent-wash)', borderRight: '1px solid var(--line)', padding: '24px 18px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 24 }}>
            <MiloAvatar size={48} />
            <div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '1.25rem', fontWeight: 500, lineHeight: 1 }}>Milo</div>
              <div style={{ fontSize: '.62rem', color: 'var(--ink-3)', letterSpacing: '.14em', textTransform: 'uppercase', marginTop: 5 }}>La tua guida</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {steps.map((s, i) => {
              const state = i < st.miloStep ? 'done' : i === st.miloStep ? 'active' : 'todo';
              const dotBg = state === 'done' ? 'var(--accent)' : state === 'active' ? 'var(--accent-wash)' : 'transparent';
              const dotCol = state === 'done' ? '#FBF8F3' : state === 'active' ? 'var(--accent)' : 'var(--ink-3)';
              const dotStyle: CSSProperties = { flex: 'none', width: 23, height: 23, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '.72rem', fontWeight: 700, background: dotBg, border: '1.5px solid ' + (state === 'todo' ? 'var(--line)' : 'var(--accent)'), color: dotCol };
              return (
                <button key={s.rail} onClick={() => set({ miloStep: i })} style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 10, background: state === 'active' ? 'var(--paper)' : 'transparent', cursor: 'pointer', transition: 'background .2s' }}>
                  <span style={dotStyle}>{state === 'done' ? '✓' : String(i + 1)}</span>
                  <span style={{ fontSize: '.85rem', fontWeight: state === 'active' ? 600 : 500, color: state === 'todo' ? 'var(--ink-3)' : 'var(--ink)' }}>{s.rail}</span>
                </button>
              );
            })}
          </div>
          <button onClick={closeMilo} style={{ marginTop: 'auto', fontSize: '.74rem', color: 'var(--ink-3)', textAlign: 'left', padding: 9, cursor: 'pointer' }}>Salta il tour</button>
        </div>
        {/* content */}
        <div style={{ flex: 1, padding: '26px 28px 24px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
            <span className="kicker">Tappa {st.miloStep + 1} di {steps.length}</span>
            <button onClick={closeMilo} style={{ color: 'var(--ink-3)', fontSize: '1rem', padding: '2px 6px', cursor: 'pointer' }}>✕</button>
          </div>
          <h3 style={{ fontFamily: 'var(--serif)', fontSize: '1.62rem', fontWeight: 500, lineHeight: 1.15, margin: '7px 0 14px', color: 'var(--ink)' }}>{c.title}</h3>
          <p style={{ fontFamily: 'var(--serif)', fontSize: '1.08rem', color: 'var(--ink-2)', lineHeight: 1.62, minHeight: 120 }}>{c.t}</p>
          <div style={{ height: 4, borderRadius: 3, background: 'var(--line)', margin: '8px 0 18px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: prog + '%', background: 'var(--accent)', borderRadius: 3, transition: 'width .45s cubic-bezier(.16,1,.3,1)' }} />
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 'auto' }}>
            {st.miloStep > 0 && <button onClick={miloPrev} style={{ padding: '12px 17px', borderRadius: 11, border: '1px solid var(--line)', fontSize: '.9rem', fontWeight: 600, color: 'var(--ink-2)', cursor: 'pointer' }}>← Indietro</button>}
            <button className="btn btn-solid" onClick={c.act} style={{ flex: 1, justifyContent: 'center' }}><span>{c.cta}</span></button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================ WIZARD MODAL ============================
const STEP_LABELS = ['Cosa', 'Dove', 'Fonti', 'Profondità', 'Preflight'];

export function WizardModal({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const toggleArr = (field: 'wCats' | 'wProv' | 'wSrc', val: string) => {
    const a = st[field];
    set({ [field]: a.includes(val) ? a.filter((x) => x !== val) : [...a, val] } as Partial<ViewProps['st']>);
  };
  const closeWizard = () => set({ wizardOpen: false });
  const wNext = () => {
    if (st.wStep >= 4) set({ wizardOpen: false, nav: 'mercati' });
    else set({ wStep: st.wStep + 1 });
  };
  const wBack = () => set({ wStep: Math.max(0, st.wStep - 1) });

  const nicheN = Math.max(1, st.wCats.length);
  const provN = Math.max(1, st.wProv.length);
  const qpn = { rapido: 1, completo: 3, esteso: 5 }[st.wDepth];
  const dmult = { rapido: 0.6, completo: 1, esteso: 1.7 }[st.wDepth];
  const depthObj = WIZ_DEPTH.find((d) => d.id === st.wDepth)!;
  const queries = st.wCats.flatMap((c) => st.wProv.map((p) => c + ' · ' + p)).slice(0, 8);
  const pfSources = WIZ_SOURCES.filter((s) => st.wSrc.includes(s.id));
  const pf = {
    aziende: fmt(Math.round(nicheN * provN * 1850 * dmult)),
    queries: fmt(nicheN * provN * qpn),
    comuni: Math.round(provN * (st.wDepth === 'esteso' ? 11 : st.wDepth === 'completo' ? 7 : 4)),
    fonti: pfSources.length,
    overlap: '~12%',
    durW: depthObj.dur + '%',
  };
  const queryTags = queries.length ? queries : ['—'];

  const stat = (value: string | number, label: string, accent = false) => (
    <div style={{ background: 'var(--paper-2)', border: '1px solid var(--line)', borderRadius: 12, padding: 14 }}>
      <div style={{ fontFamily: 'var(--serif)', fontSize: '1.5rem', fontWeight: 500, color: accent ? 'var(--accent)' : undefined }}>{value}</div>
      <div style={{ fontSize: '.66rem', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 3 }}>{label}</div>
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(33,27,20,.34)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <div className="agfade ag-scroll" style={{ width: '100%', maxWidth: 780, maxHeight: '90vh', overflowY: 'auto', background: 'var(--paper)', borderRadius: 18, boxShadow: 'var(--shadow-modal)', display: 'flex', flexDirection: 'column' }}>
        {/* header: step rail */}
        <div style={{ padding: '20px 26px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7 }}>
            {STEP_LABELS.map((label, i) => {
              const active = st.wStep === i;
              const done = st.wStep > i;
              const dotStyle: CSSProperties = { width: 24, height: 24, flex: 'none', borderRadius: '50%', fontSize: '.66rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', background: active || done ? 'var(--accent)' : 'var(--paper-3)', color: active || done ? 'var(--white)' : 'var(--ink-3)' };
              return (
                <span key={label} style={{ display: 'contents' }}>
                  <span style={dotStyle}>{done ? '✓' : '0' + (i + 1)}</span>
                  <span style={{ fontSize: '.78rem', fontWeight: 600, color: active ? 'var(--ink)' : 'var(--ink-3)' }}>{label}</span>
                  {i !== 4 && <span style={{ width: 18, height: 1, background: 'var(--line)' }} />}
                </span>
              );
            })}
          </div>
          <button onClick={closeWizard} style={{ fontSize: '1.05rem', color: 'var(--ink-3)', padding: '4px 8px', flex: 'none' }}>✕</button>
        </div>

        {/* body */}
        <div style={{ padding: '28px 30px', flex: 1 }}>
          {st.wStep === 0 && (
            <div className="agfade">
              <span className="kicker">01 · Cosa vuoi mappare?</span>
              <h2 style={{ fontFamily: 'var(--serif)', fontSize: '1.5rem', fontWeight: 500, margin: '8px 0 6px' }}>Settore, categoria, parole chiave</h2>
              <p style={{ fontSize: '.9rem', color: 'var(--ink-2)', marginBottom: 20 }}>Niente fatturato o dimensione adesso. Prima costruisci il perimetro grezzo.</p>
              <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                {WIZ_CATS.map((c) => <button key={c} onClick={() => toggleArr('wCats', c)} style={chipStyle(st.wCats.includes(c))}>{c}</button>)}
              </div>
            </div>
          )}
          {st.wStep === 1 && (
            <div className="agfade">
              <span className="kicker">02 · Dove?</span>
              <h2 style={{ fontFamily: 'var(--serif)', fontSize: '1.5rem', fontWeight: 500, margin: '8px 0 6px' }}>Regione, provincia, comuni</h2>
              <p style={{ fontSize: '.9rem', color: 'var(--ink-2)', marginBottom: 20 }}>Seleziona i territori da intercettare. I comuni satellite si attivano da soli oltre 200 risultati.</p>
              <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                {WIZ_PROV.map((p) => <button key={p} onClick={() => toggleArr('wProv', p)} style={chipStyle(st.wProv.includes(p))}>{p}</button>)}
              </div>
            </div>
          )}
          {st.wStep === 2 && (
            <div className="agfade">
              <span className="kicker">03 · Da quali fonti?</span>
              <h2 style={{ fontFamily: 'var(--serif)', fontSize: '1.5rem', fontWeight: 500, margin: '8px 0 18px' }}>Sorgenti da interrogare</h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {WIZ_SOURCES.map((s) => {
                  const sel = st.wSrc.includes(s.id);
                  const free = s.costo === 'Gratis';
                  return (
                    <button key={s.id} onClick={() => toggleArr('wSrc', s.id)} style={{ textAlign: 'left', padding: '16px 18px', borderRadius: 13, background: sel ? 'var(--accent-wash)' : 'var(--paper)', border: '1.6px solid ' + (sel ? 'var(--accent)' : 'var(--line)'), transition: 'all .2s', display: 'flex', gap: 13, alignItems: 'flex-start' }}>
                      <span style={{ width: 20, height: 20, flex: 'none', borderRadius: 6, border: '1.5px solid ' + (sel ? 'var(--accent)' : 'var(--line)'), background: sel ? 'var(--accent)' : 'transparent', color: 'var(--white)', fontSize: '.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{sel ? '✓' : ''}</span>
                      <span style={{ flex: 1 }}>
                        <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                          <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{s.nome}</span>
                          <span style={{ fontSize: '.66rem', fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: free ? 'var(--accent-wash)' : 'var(--paper-3)', color: free ? 'var(--accent)' : 'var(--ink-3)' }}>{s.costo}</span>
                        </span>
                        <span style={{ display: 'block', fontSize: '.78rem', color: 'var(--ink-2)', lineHeight: 1.4 }}>{s.tipo}</span>
                        <span style={{ display: 'block', fontSize: '.72rem', color: 'var(--ink-3)', marginTop: 5 }}>Copertura prevista: {s.cov}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {st.wStep === 3 && (
            <div className="agfade">
              <span className="kicker">04 · Quanto in profondità?</span>
              <h2 style={{ fontFamily: 'var(--serif)', fontSize: '1.5rem', fontWeight: 500, margin: '8px 0 18px' }}>Profondità della raccolta</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {WIZ_DEPTH.map((d) => {
                  const sel = st.wDepth === d.id;
                  return (
                    <button key={d.id} onClick={() => set({ wDepth: d.id })} style={{ textAlign: 'left', padding: '18px 20px', borderRadius: 14, background: sel ? 'var(--accent-wash)' : 'var(--paper)', border: '1.6px solid ' + (sel ? 'var(--accent)' : 'var(--line)'), transition: 'all .2s' }}>
                      <span style={{ fontFamily: 'var(--serif)', fontSize: '1.15rem', fontWeight: 500, color: sel ? 'var(--accent)' : 'var(--ink)', marginBottom: 5, display: 'block' }}>{d.nome}</span>
                      <span style={{ display: 'block', fontSize: '.84rem', color: 'var(--ink-2)', lineHeight: 1.5 }}>{d.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {st.wStep === 4 && (
            <div className="agfade">
              <span className="kicker">05 · Preflight</span>
              <h2 style={{ fontFamily: 'var(--serif)', fontSize: '1.5rem', fontWeight: 500, margin: '8px 0 18px' }}>Prima di mappare</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 20 }}>
                {stat(pf.aziende, 'aziende stimate', true)}
                {stat(pf.queries, 'query')}
                {stat(pf.comuni, 'comuni')}
                {stat(pf.fonti, 'fonti')}
              </div>
              <div style={{ marginBottom: 18 }}>
                <span className="kicker kicker--muted">Strategia generata</span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  {queryTags.map((t, i) => <span key={t + i} style={{ fontSize: '.78rem', padding: '5px 12px', borderRadius: 999, background: 'var(--accent-wash)', color: 'var(--accent)', fontWeight: 600 }}>{t}</span>)}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, background: 'var(--paper-2)', border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '.72rem', color: 'var(--ink-3)', marginBottom: 5 }}>Durata relativa · sovrapposizione database {pf.overlap}</div>
                  <div style={{ height: 7, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: pf.durW, background: 'var(--accent)', borderRadius: 999 }} />
                  </div>
                </div>
                <div style={{ fontSize: '.78rem', color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>Costo scraping <strong style={{ color: 'var(--accent)' }}>€0</strong></div>
              </div>
            </div>
          )}
        </div>

        {/* footer */}
        <div style={{ padding: '16px 26px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={wBack} style={{ fontSize: '.86rem', fontWeight: 600, color: 'var(--ink-2)', padding: '8px 4px', visibility: st.wStep === 0 ? 'hidden' : undefined }}>← Indietro</button>
          <span style={{ fontSize: '.76rem', color: 'var(--ink-3)' }}>Passo {st.wStep + 1} di 5</span>
          <button className="btn btn-solid" onClick={wNext}><span>{st.wStep >= 4 ? 'Mappa il mercato' : 'Continua'}</span><span className="gl">→</span></button>
        </div>
      </div>
    </div>
  );
}
