import { fmt, tabStyle } from '../helpers';
import { useJudgmentSummary, useCompanies } from '../queries';
import { useJudgmentJob, type JudgmentKind } from '../jobs';
import type { ViewProps } from '../ctx';

const JUDGE_STEPS: [JudgmentKind, string][] = [
  ['discovery', 'Scopri footprint'], ['collect_signals', 'Raccogli segnali'], ['judge', 'Giudica'], ['validate_export', 'Valida & esporta'],
];

const SECTION = { padding: '30px 36px 60px', maxWidth: 1180, margin: '0 auto' } as const;
const TABS: [ViewProps['st']['valTab'], string][] = [
  ['matrice', 'Matrice A×B'], ['coda', 'Coda giudizio'], ['golden', 'Golden set'],
  ['evals', 'Evals'], ['config', 'Confronto config'], ['validation', 'Validation'],
];

// Structural template of the 3×3 A×B grid (axis level + design tier). The cell
// COUNT is overlaid from the real judgment-summary quadrant histogram: the
// engine emits quadrants as `A{s}B{s}` with s ∈ {+ , - , ?}; the view's three
// buckets per axis map +→A (alta), ?→M (media/indeterminato), -→B (bassa).
const CELLS: { a: 'A' | 'M' | 'B'; b: 'A' | 'M' | 'B'; tier: string }[] = [
  { a: 'B', b: 'A', tier: 'Tier C' }, { a: 'M', b: 'A', tier: 'Tier B' }, { a: 'A', b: 'A', tier: 'Tier A' },
  { a: 'B', b: 'M', tier: 'Tier C' }, { a: 'M', b: 'M', tier: 'Tier C' }, { a: 'A', b: 'M', tier: 'Tier B' },
  { a: 'B', b: 'B', tier: 'Tier D' }, { a: 'M', b: 'B', tier: 'Tier D' }, { a: 'A', b: 'B', tier: 'Tier C' },
];
const AXIS_SYM: Record<'A' | 'M' | 'B', string> = { A: '+', M: '?', B: '-' };
/** real quadrant key for a view cell, e.g. a='A' b='B' → 'A+B-'. */
function cellQuadrant(c: { a: 'A' | 'M' | 'B'; b: 'A' | 'M' | 'B' }): string {
  return `A${AXIS_SYM[c.a]}B${AXIS_SYM[c.b]}`;
}

const EVAL_KPIS = [
  { k: 'Precision', v: '0,89' }, { k: 'Recall', v: '0,82' }, { k: 'F1', v: '0,85' }, { k: 'Quadrant acc.', v: '0,78' },
  { k: 'A-agreement', v: '0,91' }, { k: 'B-agreement', v: '0,86' }, { k: 'Override rate', v: '6,4%' }, { k: 'Costo/valut.', v: '€0,012' },
];

const OTHER: Record<string, [string, string]> = {
  coda: ['Coda di giudizio', "128 aziende in attesa di verdetto. Il giudice processa ~40 record/min; ogni caso incerto viene marcato per l'override umano L5b."],
  golden: ['Gestione golden set', 'Golden v3.2 · 240 campioni rivisti · freeze attivo. 12 conflitti tra reviewer da risolvere, distribuzione bilanciata sui 9 quadranti.'],
  evals: ['Evaluation', 'Metriche per blocco: ATECO, livello L2–L5, confidence e fonte disponibile. Confusion matrix cliccabile per ispezionare i casi.'],
  config: ['Confronto configurazioni', 'Config A vs B · one-pass vs two-pass · critic on/off. Delta precision +4pt, delta costo −18%, 84 record cambiano quadrante.'],
  validation: ['Validation', 'Controllo schema output: campi mancanti, formati non validi, incoerenze tra A, B, quadrante e target, rationale insufficiente, critic disagreement.'],
};

export default function Valutazione({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const js = useJudgmentSummary();
  const { raw, ids } = useCompanies();
  // 4 fixed mutation hooks (stable order) + a launcher that picks the right one.
  const jobHooks: Record<JudgmentKind, ReturnType<typeof useJudgmentJob>> = {
    discovery: useJudgmentJob('discovery'),
    collect_signals: useJudgmentJob('collect_signals'),
    judge: useJudgmentJob('judge'),
    validate_export: useJudgmentJob('validate_export'),
  };
  const anyPending = Object.values(jobHooks).some((h) => h.isPending);
  const launch = (kind: JudgmentKind) => {
    const sel200 = ids.slice(0, 200);
    if (!sel200.length || anyPending) return;
    jobHooks[kind].mutate(sel200, { onSuccess: (r) => set({ activeJob: { id: r.jobId, kind }, jobModalOpen: true }) });
  };

  const quad = js.data?.quadrants ?? {};
  // overlay the real quadrant histogram onto the structural grid (count from data).
  const cells = CELLS.map((c) => ({ ...c, count: quad[cellQuadrant(c)] ?? 0 }));
  const maxCount = cells.reduce((m, c) => Math.max(m, c.count), 0) || 1840;
  const sel = cells[st.cell] || cells[4];
  // real companies in the selected quadrant (replaces the old CASES mock).
  const selQuad = cellQuadrant(sel);
  const selCases = raw.filter((r) => (r.verdetto_gap as { quadrant?: string } | undefined)?.quadrant === selQuad).slice(0, 8);
  const unjudged = js.data?.unjudged ?? 0;
  const codaText = js.data
    ? `${fmt(unjudged)} aziende in attesa di verdetto su ${fmt(js.data.total)} totali. Il giudice processa i casi a due assi; ogni caso incerto viene marcato per l'override umano L5b.`
    : OTHER.coda[1];
  const vo: [string, string] = st.valTab === 'coda' ? ['Coda di giudizio', codaText] : (OTHER[st.valTab] || OTHER.coda);

  return (
    <section className="agfade" style={SECTION}>
      <div style={{ marginBottom: 8 }}><span className="kicker">Valutazione</span></div>
      <h1 style={{ fontSize: '1.95rem', fontWeight: 500, letterSpacing: '-.02em', marginBottom: 18 }}>Il giudice e la sua precisione</h1>
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => set({ valTab: id })} style={tabStyle(st.valTab === id)}>{label}</button>
        ))}
      </div>

      {/* judgment launch — runs the real L2–L5 pipeline on the loaded companies */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 24 }}>
        <span style={{ fontSize: '.74rem', color: 'var(--ink-3)', marginRight: 4 }}>Lancia sul dataset ({fmt(Math.min(ids.length, 200))}):</span>
        {JUDGE_STEPS.map(([kind, label], i) => {
          const primary = kind === 'judge';
          return (
            <button
              key={kind}
              onClick={() => launch(kind)}
              disabled={anyPending || ids.length === 0}
              className={primary ? 'btn btn-solid' : undefined}
              style={primary
                ? { opacity: anyPending || !ids.length ? 0.5 : 1 }
                : { fontSize: '.8rem', fontWeight: 600, padding: '8px 13px', borderRadius: 999, border: '1px solid var(--line)', color: 'var(--ink-2)', background: 'var(--paper)', cursor: anyPending || !ids.length ? 'not-allowed' : 'pointer', opacity: anyPending || !ids.length ? 0.5 : 1 }}
            >
              <span>{i + 1}. {label}</span>
            </button>
          );
        })}
      </div>

      {st.valTab === 'matrice' ? (
        <div className="agfade" style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 30, alignItems: 'start' }}>
          <div>
            <div style={{ display: 'flex', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <span style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: '.7rem', fontWeight: 600, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Asse B · Dimensione &amp; segnali</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                  {cells.map((c, i) => {
                    const seld = st.cell === i;
                    const isTarget = c.tier === 'Tier A';
                    const op = 0.06 + (c.count / maxCount) * 0.5;
                    return (
                      <button
                        key={i}
                        onClick={() => set({ cell: i })}
                        style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start', padding: 18, borderRadius: 12, aspectRatio: '1.4', justifyContent: 'center', background: isTarget ? 'var(--accent)' : 'rgba(151,88,47,' + op.toFixed(2) + ')', border: '2px solid ' + (seld ? 'var(--accent-deep)' : 'transparent'), transition: 'all .2s' }}
                      >
                        <span style={{ fontFamily: 'var(--serif)', fontSize: '1.5rem', fontWeight: 500, color: isTarget ? 'var(--white)' : 'var(--ink)' }}>{fmt(c.count)}</span>
                        <span style={{ fontSize: '.68rem', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: isTarget ? 'rgba(255,255,255,.85)' : 'var(--ink-3)' }}>{c.tier}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ textAlign: 'center', fontSize: '.7rem', fontWeight: 600, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--ink-3)', marginTop: 10 }}>Asse A · Fit prodotto / ICP →</div>
              </div>
            </div>
          </div>
          <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 20 }}>
            <span className="kicker">{sel.tier} · A={sel.a} B={sel.b}</span>
            <div style={{ fontFamily: 'var(--serif)', fontSize: '1.2rem', fontWeight: 500, margin: '8px 0 14px' }}>{fmt(sel.count)} aziende in questo quadrante</div>
            {selCases.length > 0 ? (
              selCases.map((c) => (
                <button
                  key={c.id}
                  onClick={() => set({ selectedCompanyId: c.id })}
                  className="ag-row"
                  style={{ width: '100%', textAlign: 'left', padding: '10px 0', borderTop: '1px solid var(--line-soft)', cursor: 'pointer', background: 'transparent' }}
                >
                  <div style={{ fontSize: '.86rem', fontWeight: 600, color: 'var(--ink)' }}>{c.company_name ?? '—'}</div>
                  <div style={{ fontSize: '.76rem', color: 'var(--ink-3)', marginTop: 2 }}>
                    {[c.city, c.revenue, c.employees ? `${c.employees} dip` : null].filter(Boolean).join(' · ') || c.category}
                  </div>
                </button>
              ))
            ) : (
              <div style={{ padding: '14px 0', borderTop: '1px solid var(--line-soft)', fontSize: '.82rem', color: 'var(--ink-3)', lineHeight: 1.5 }}>
                Nessuna azienda giudicata in questo quadrante. Lancia &quot;Giudica&quot; per popolarlo.
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="agfade">
          <div style={{ display: 'inline-block', fontSize: '.66rem', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink-3)', background: 'var(--paper-2)', border: '1px solid var(--line)', borderRadius: 999, padding: '4px 11px', marginBottom: 16 }}>
            Dati dimostrativi — nessun endpoint metriche evals/golden in questa versione
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
            {EVAL_KPIS.map((k) => (
              <div key={k.k} style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 12, padding: '15px 16px' }}>
                <div style={{ fontSize: '.66rem', fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 8 }}>{k.k}</div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: '1.7rem', fontWeight: 500, color: 'var(--ink)' }}>{k.v}</div>
              </div>
            ))}
          </div>
          <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 22 }}>
            <span className="kicker">{vo[0]}</span>
            <p style={{ fontSize: '.9rem', color: 'var(--ink-2)', marginTop: 10, maxWidth: 560, lineHeight: 1.6 }}>{vo[1]}</p>
          </div>
        </div>
      )}
    </section>
  );
}
