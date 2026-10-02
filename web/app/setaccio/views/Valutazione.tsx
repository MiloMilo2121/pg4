import { useId, type CSSProperties } from 'react';
import { fmt, EMPTY } from '../helpers';
import { useJudgmentSummary, useCompanies } from '../queries';
import { useJudgmentJob, type JudgmentKind } from '../jobs';
import type { ViewProps } from '../ctx';
import { CELLS, cellQuadrant } from '../data';
import { PageSection, PageHeader } from '../ui/Page';
import { Tabs, TabPanel } from '../ui/Tabs';
import { Stat } from '../ui/Stat';
import { Card } from '../../ds/components/Card';
import { Button } from '../../ds/components/Button';
import { Kicker } from '../../ds/components/Kicker';
import { Tag } from '../../ds/components/Tag';
import { cx } from '../../ds/components/cx';

const JUDGE_STEPS: [JudgmentKind, string][] = [
  ['discovery', 'Scopri footprint'], ['collect_signals', 'Raccogli segnali'], ['judge', 'Giudica'], ['validate_export', 'Valida & esporta'],
];

const TABS = [
  ['matrice', 'Matrice A×B'], ['coda', 'Coda giudizio'], ['golden', 'Golden set'],
  ['evals', 'Evals'], ['config', 'Confronto config'], ['validation', 'Validation'],
] as const;

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
  const tabsId = useId();
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
  const blocked = anyPending || ids.length === 0;

  return (
    <PageSection>
      <PageHeader kicker="Valutazione" number="03" title="Il giudice e la sua precisione" />
      <Tabs items={TABS} value={st.valTab} onChange={(id) => set({ valTab: id })} label="Valutazione" idBase={tabsId} />

      {/* judgment launch: runs the real L2–L5 pipeline on the loaded companies */}
      <div className="sx-row-flex sx-mb" role="group" aria-label="Pipeline di giudizio">
        <span className="sx-meta">Lancia sul dataset (<span className="num">{fmt(Math.min(ids.length, 200))}</span>):</span>
        {JUDGE_STEPS.map(([kind, label], i) => (
          <Button key={kind} variant={kind === 'judge' ? 'solid' : 'outline'} size="sm" onClick={() => launch(kind)} disabled={blocked}>
            {`${i + 1}. ${label}`}
          </Button>
        ))}
      </div>

      <TabPanel idBase={tabsId} value={st.valTab}>
        {st.valTab === 'matrice' ? (
          <div className="sx-split">
            <div className="sx-row-flex" style={{ alignItems: 'stretch', flexWrap: 'nowrap', gap: '0.85rem' }}>
              <span className="sx-axis sx-axis--y" style={{ alignSelf: 'center' }}>Asse B · Dimensione e segnali</span>
              <div className="sx-matrix-wrap">
                <div className="sx-matrix" role="group" aria-label="Matrice A per B: scegli un quadrante">
                  {cells.map((c, i) => {
                    const isTarget = c.tier === 'Tier A';
                    const a = 0.06 + (c.count / maxCount) * 0.5;
                    return (
                      <button
                        key={i}
                        type="button"
                        className={cx('sx-cell', isTarget && 'sx-cell--target')}
                        aria-pressed={st.cell === i}
                        aria-label={`${c.tier}, A ${c.a}, B ${c.b}: ${fmt(c.count)} aziende`}
                        onClick={() => set({ cell: i })}
                        style={{ '--a': a.toFixed(2) } as CSSProperties}
                      >
                        <span className="sx-cell__count">{fmt(c.count)}</span>
                        <span className="sx-cell__tier">{c.tier}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="sx-axis" style={{ textAlign: 'center', marginTop: '0.6rem' }}>Asse A · Fit prodotto / ICP <span aria-hidden="true">→</span></div>
              </div>
            </div>
            <Card>
              <Kicker>{`${sel.tier} · A=${sel.a} B=${sel.b}`}</Kicker>
              <h2 className="sx-panel-title" aria-live="polite">{fmt(sel.count)} aziende in questo quadrante</h2>
              {selCases.length > 0 ? (
                <div className="sx-list">
                  {selCases.map((c) => (
                    <button key={c.id} type="button" className="sx-list__item" onClick={() => set({ selectedCompanyId: c.id })}>
                      <span className="sx-list__main">
                        <span className="sx-list__title">{c.company_name ?? EMPTY}</span>
                        <span className="sx-list__meta">
                          {[c.city, c.revenue, c.employees ? `${c.employees} dip` : null].filter(Boolean).join(' · ') || c.category}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="sx-note">Nessuna azienda giudicata in questo quadrante. Lancia «Giudica» per popolarlo.</p>
              )}
            </Card>
          </div>
        ) : (
          <div>
            <div className="sx-mb">
              <Tag variant="dashed">Dati dimostrativi: nessun endpoint metriche evals/golden in questa versione</Tag>
            </div>
            <div className="sx-grid sx-grid--kpi sx-grid--joined sx-mb">
              {EVAL_KPIS.map((k) => <Stat key={k.k} label={k.k} value={k.v} />)}
            </div>
            <Card>
              <Kicker>{vo[0]}</Kicker>
              <p className="sx-note sx-measure" style={{ marginTop: '0.6rem' }}>{vo[1]}</p>
            </Card>
          </div>
        )}
      </TabPanel>
    </PageSection>
  );
}
