import { useId } from 'react';
import { RAFF, UNIVERSO } from '../data';
import { useEnrichFields, useCompanies, ENRICH_KEY_TO_API } from '../queries';
import { useEnrichJob } from '../jobs';
import { fmt } from '../helpers';
import type { ViewProps } from '../ctx';
import { PageSection, PageHeader } from '../ui/Page';
import { Tabs, TabPanel } from '../ui/Tabs';
import { Table } from '../ui/Table';
import { MiniBar } from '../ui/Bar';
import { Check } from '../ui/Choice';
import { Pill } from '../ui/Pill';
import { Stat } from '../ui/Stat';
import { Funnel } from '../ui/Funnel';
import { Callout } from '../ui/Callout';
import { Card } from '../../ds/components/Card';
import { Button } from '../../ds/components/Button';
import { cx } from '../../ds/components/cx';

const ENRICH_MAX = 200; // server caps a job at 200 companies

const TABS = [
  ['enrichment', 'Enrichment Center'], ['imbuto', 'Imbuto'], ['viste', 'Viste salvate'],
] as const;
const ENRICH_COLS = [1.6, 1.3, 1, 1, 0.8];

const SAVED = [
  { nome: 'SaaS 5–30M', count: '640', desc: 'fascia fatturato media, sito verificato' },
  { nome: 'Alta priorità MI', count: '410', desc: 'Tier A, decisore presente' },
  { nome: 'Da arricchire', count: '1.260', desc: 'dominio sì, fatturato no' },
];

export default function Raffinazione({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const tabsId = useId();
  const ENRICH = useEnrichFields();
  const { ids } = useCompanies();
  const enrichJob = useEnrichJob();
  // enrichment
  const selFields = ENRICH.filter((f) => st.enrich[f.k]);
  const enrichN = selFields.reduce((s, f) => s + f.costN, 0);
  const enrichTargets = selFields.reduce((s, f) => Math.max(s, f.toArr), 0);
  // map selected FE keys → free engine fields; decisore/ateco have no free field.
  const selectedKeys = selFields.map((f) => f.k);
  const apiFields = Array.from(new Set(selectedKeys.map((k) => ENRICH_KEY_TO_API[k]).filter(Boolean))) as string[];
  const unmappable = selectedKeys.filter((k) => !ENRICH_KEY_TO_API[k]);
  const targetIds = ids.slice(0, ENRICH_MAX);
  const canEnrich = apiFields.length > 0 && targetIds.length > 0 && !enrichJob.isPending;
  const runEnrich = () => {
    if (!canEnrich) return;
    enrichJob.mutate(
      { ids: targetIds, fields: apiFields },
      { onSuccess: (r) => set({ activeJob: { id: r.jobId, kind: 'enrich' }, jobModalOpen: true }) },
    );
  };
  const toggleField = (k: string) => set({ enrich: { ...st.enrich, [k]: !st.enrich[k] } });

  // imbuto
  const totalRemoved = RAFF.reduce((s, f) => s + (st.filters[f.k] ? f.removed : 0), 0);
  const raffFinal = UNIVERSO - totalRemoved;
  const vizStages: { label: string; value: number }[] = [{ label: 'Universo', value: UNIVERSO }];
  let acc = UNIVERSO;
  RAFF.forEach((f) => {
    if (st.filters[f.k]) {
      acc -= f.removed;
      vizStages.push({ label: f.label, value: acc });
    }
  });

  return (
    <PageSection>
      <PageHeader kicker="Raffinazione" number="03" title="Dal grezzo alla lista utile" />
      <Tabs items={TABS} value={st.raffTab} onChange={(id) => set({ raffTab: id })} label="Raffinazione" idBase={tabsId} />

      <TabPanel idBase={tabsId} value={st.raffTab}>
        {/* Enrichment Center */}
        {st.raffTab === 'enrichment' && (
          <div className="sx-split">
            <div>
              <p className="sx-note" style={{ marginBottom: '1rem' }}>
                Scegli cosa aggiungere solo dopo aver visto quanto manca, quanto costa e quali segmenti abilita. Seleziona i campi da arricchire.
              </p>
              <Card pad="flush">
                <Table cols={ENRICH_COLS} head={['Campo', 'Copertura', 'Da arricchire', 'Costo', 'Priorità']} minWidth={620} label="Campi da arricchire">
                  {ENRICH.map((f) => {
                    const sel = !!st.enrich[f.k];
                    return (
                      <tr key={f.k} className={cx('sx-tr--action', sel && 'sx-tr--selected')} onClick={() => toggleField(f.k)}>
                        <td>
                          <button type="button" className="sx-rowbtn" aria-pressed={sel} onClick={(e) => { e.stopPropagation(); toggleField(f.k); }}>
                            <Check on={sel} />
                            {f.label}
                          </button>
                        </td>
                        <td><MiniBar value={f.cov} text={`${f.cov}%`} /></td>
                        <td className="sx-cell-num">{fmt(f.toArr)}</td>
                        <td className="sx-cell-num">{f.cost}</td>
                        <td><Pill tone={f.prio === 'Alta' ? 'wash' : 'muted'}>{f.prio}</Pill></td>
                      </tr>
                    );
                  })}
                </Table>
              </Card>
            </div>
            <div className="sx-sticky">
              <Card emphasis className="sx-stack">
                <Stat boxed={false} variant="hero" label="Anteprima costo" value={`€ ${fmt(enrichN)}`} sub={`${selFields.length} campi · ${fmt(enrichTargets)} aziende`} />
                <Callout tone="quiet">
                  <span aria-live="polite">
                    {apiFields.length
                      ? `Arricchisco ${fmt(targetIds.length)} aziende sui campi gratuiti selezionati${ids.length > ENRICH_MAX ? ` (primo lotto di ${ENRICH_MAX})` : ''}.`
                      : 'Seleziona almeno un campo arricchibile (P.IVA, fatturato, dipendenti, email, PEC, social).'}
                  </span>
                  {unmappable.length > 0 && (
                    <span style={{ display: 'block', marginTop: '0.4rem' }}>
                      {unmappable.join(', ')}: non arricchibili gratis in questa versione, verranno ignorati.
                    </span>
                  )}
                </Callout>
                <Button glyph="→" block onClick={runEnrich} disabled={!canEnrich}>{enrichJob.isPending ? 'Avvio' : 'Arricchisci'}</Button>
              </Card>
            </div>
          </div>
        )}

        {/* Imbuto */}
        {st.raffTab === 'imbuto' && (
          <div className="sx-split sx-split--aside-left">
            <div>
              <p className="sx-note" style={{ marginBottom: '1rem' }}>Attiva o disattiva ogni filtro: la lista finale si ricalcola in tempo reale.</p>
              <Card pad="tight">
                <div className="sx-dl__row sx-filter-row">
                  <span className="sx-cell-strong">Universo iniziale</span>
                  <span className="sx-cell-num">{fmt(UNIVERSO)}</span>
                </div>
                <div role="group" aria-label="Filtri">
                  {RAFF.map((f) => {
                    const active = !!st.filters[f.k];
                    return (
                      <button
                        key={f.k}
                        type="button"
                        className="sx-filter"
                        aria-pressed={active}
                        onClick={() => set({ filters: { ...st.filters, [f.k]: !st.filters[f.k] } })}
                      >
                        <Check on={active} />
                        <span className="sx-filter__label">{f.label}</span>
                        <span className="sx-cell-num">{active ? '−' + fmt(f.removed) : 'off'}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="sx-dl__row sx-filter-total">
                  <span className="sx-cell-strong">Lista finale</span>
                  <span className="sx-stat__value" aria-live="polite" style={{ fontSize: 'var(--fs-ui-xl)' }}>{fmt(raffFinal)}</span>
                </div>
              </Card>
            </div>
            <div className="sx-stack" style={{ gap: '1.5rem' }}>
              <Funnel steps={vizStages} base={UNIVERSO} minPct={40} deltas={false} label="Imbuto di raffinazione" />
              <Callout kicker="Insight">
                Il filtro fatturato elimina il 62% del mercato, mentre il giudizio solo il 14%. Il principale discriminante è dimensionale, non qualitativo.
              </Callout>
            </div>
          </div>
        )}

        {/* Viste salvate */}
        {st.raffTab === 'viste' && (
          <div className="sx-grid sx-grid--3 sx-grid--joined">
            {SAVED.map((v) => (
              <Card key={v.nome} as="article">
                <h2 className="sx-list-card__title">{v.nome}</h2>
                <Stat boxed={false} variant="value-top" value={v.count} label="aziende" sub={v.desc} />
              </Card>
            ))}
          </div>
        )}
      </TabPanel>
    </PageSection>
  );
}
