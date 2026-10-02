import { RAFF, UNIVERSO } from '../data';
import { useId, type CSSProperties } from 'react';
import { fmt } from '../helpers';
import { useTotal, useMetrics, useProviderHealth, useEnrichFields, useJudgmentSummary, useProvincesCoverage } from '../queries';
import type { ViewProps } from '../ctx';
import { PageSection, PageHeader, PanelHead } from '../ui/Page';
import { Tabs, TabPanel } from '../ui/Tabs';
import { Stat } from '../ui/Stat';
import { Bars, MiniBar, pctOf, type BarRow } from '../ui/Bar';
import { Table } from '../ui/Table';
import { StatusDot, type DotTone } from '../ui/Pill';
import { Callout } from '../ui/Callout';
import { Card } from '../../ds/components/Card';

const TABS = [
  ['overview', 'Overview'], ['mercato', 'Mercato'], ['enrichment', 'Enrichment'],
  ['raffinazione', 'Raffinazione'], ['giudizio', 'Giudizio'], ['geografica', 'Geografica'],
  ['provider', 'Provider'], ['costi', 'Costi'],
] as const;

const AN_YIELD: BarRow[] = [
  { k: 'Google Maps', v: '4,9k', w: 82 }, { k: 'PagineGialle', v: '3,6k', w: 61 },
  { k: 'FatturatoItalia', v: '1,8k', w: 31 }, { k: 'Openapi', v: '1,2k', w: 21 },
];
const AN_INSIGHTS = [
  "Openapi ha copertura fatturato 74% sul SaaS B2B milanese, ma solo 41% sulle startup deeptech pre-revenue di Trento e Trieste.",
  'Il filtro fatturato elimina il 32% del mercato; il giudizio solo il 12%. Per SaaS e deeptech il discriminante è la fase, non la dimensione.',
  '212 possibili duplicati rilevati su impronta P.IVA + telefono nelle ultime 3 run: spesso la stessa startup con due società (SpA e Srl).',
];
// One-hue graphite ramp, darkest = best tier. Every swatch is labelled with its value.
const TIER_DATA = [
  { k: 'Tier A · target', n: 13, a: 1 },
  { k: 'Tier B', n: 23, a: 0.62 },
  { k: 'Tier C', n: 34, a: 0.34 },
  { k: 'Tier D · anti', n: 30, a: 0.14 },
];
// `win` marks the better side; rendered as weight + a text marker, not colour alone.
const CONFRONTO: { k: string; a: string; b: string; win?: 'a' | 'b' }[] = [
  { k: 'Aziende', a: '1.840', b: '1.420' },
  { k: 'Con fatturato', a: '71%', b: '58%', win: 'a' },
  { k: 'Target', a: '228', b: '139', win: 'a' },
  { k: 'Target rate', a: '12,4%', b: '9,8%', win: 'a' },
  { k: 'Costo per target', a: '€0,38', b: '€0,49', win: 'a' },
];
const PROVIDERS: { nome: string; stato: string; tone: DotTone; lat: string; yield: string; cost: string; cov: string }[] = [
  { nome: 'PagineGialle', stato: 'Attivo', tone: 'ok', lat: '1,2s', yield: '88%', cost: '€0', cov: '92%' },
  { nome: 'Google Maps', stato: 'Attivo', tone: 'ok', lat: '0,9s', yield: '74%', cost: '€0', cov: '78%' },
  { nome: 'FatturatoItalia', stato: 'Attivo', tone: 'ok', lat: '2,4s', yield: '42%', cost: '€0,016', cov: '61%' },
  { nome: 'Openapi', stato: 'Degradato', tone: 'warn', lat: '4,1s', yield: '24%', cost: '€0,030', cov: '44%' },
  { nome: 'LinkedIn (sniper)', stato: 'Limitato', tone: 'warn', lat: '6,8s', yield: '19%', cost: '€0,050', cov: '19%' },
  { nome: 'PEC registry', stato: 'Attivo', tone: 'ok', lat: '1,0s', yield: '56%', cost: '€0', cov: '44%' },
];
const COST_BARS: BarRow[] = [
  { k: 'Scraping', v: '€ 0', w: 4 }, { k: 'Enrichment fatturato', v: '€ 96', w: 40 },
  { k: 'Enrichment dipendenti', v: '€ 74', w: 31 }, { k: 'Decisore / social', v: '€ 121', w: 50 }, { k: 'Giudizio LLM', v: '€ 58', w: 24 },
];
const PROV_COLS = [1.4, 0.8, 0.8, 0.8, 0.9, 1];

// 12-month acquisition trend → svg line + area
const TREND = [0.6, 0.7, 0.9, 0.9, 1.1, 1.3, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4];
const MONTHS = ['L', 'F', 'M', 'A', 'M', 'G', 'L', 'A', 'S', 'O', 'N', 'D'];
const TW = 520, TH = 150, TPAD = 8, TMAX = 2.8, TMIN = 0.4;
const tx = (i: number) => TPAD + i * ((TW - TPAD * 2) / (TREND.length - 1));
const ty = (v: number) => TH - TPAD - ((v - TMIN) / (TMAX - TMIN)) * (TH - TPAD * 2);
const LINE = TREND.map((v, i) => tx(i) + ',' + ty(v).toFixed(1)).join(' ');
const AREA = 'M ' + tx(0) + ',' + (TH - TPAD) + ' L ' + TREND.map((v, i) => tx(i) + ',' + ty(v).toFixed(1)).join(' L ') + ' L ' + tx(TREND.length - 1) + ',' + (TH - TPAD) + ' Z';


const pctRows = (rows: { k: string; v: string; w: string }[]): BarRow[] => rows.map((r) => ({ k: r.k, v: r.v, w: pctOf(r.w) }));

export default function Analytics({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const tabsId = useId();
  const total = useTotal();
  const m = useMetrics();
  const ph = useProviderHealth();
  const enrich = useEnrichFields();
  const js = useJudgmentSummary();
  const provinces = useProvincesCoverage();

  const fr = m.data?.fillRates ?? {};
  // overall completeness = mean of the real anagraphic fill-rates (honest aggregate).
  const complFields = ['official_website', 'phone', 'email', 'pec', 'vat', 'revenue', 'employees'];
  const complVals = complFields.map((k) => fr[k]).filter((v): v is number => typeof v === 'number');
  const completezza = complVals.length ? Math.round(complVals.reduce((s, v) => s + v, 0) / complVals.length) : null;

  // judgment-derived shares (real quadrant histogram + targets).
  const judged = js.data?.judged ?? 0;
  const targetCount = Object.values(js.data?.targets ?? {}).reduce((s, n) => s + n, 0);
  const quad = js.data?.quadrants ?? {};
  const quadSum = Object.values(quad).reduce((s, n) => s + n, 0);
  const unknownCount = Object.entries(quad).filter(([k]) => k.includes('?')).reduce((s, [, n]) => s + n, 0);
  const targetRate = judged ? Math.round((1000 * targetCount) / judged) / 10 : null; // one decimal
  const unknownRate = quadSum ? Math.round((1000 * unknownCount) / quadSum) / 10 : null;

  const anKpis = [
    { k: 'Dataset', v: fmt(total), d: '+96 / settimana' },
    { k: 'Completezza', v: completezza === null ? '54%' : completezza + '%', d: 'media campi anagrafici' },
    { k: 'Target rate', v: targetRate === null ? '4,3%' : String(targetRate).replace('.', ',') + '%', d: judged ? 'sui giudicati' : 'media portfolio' },
    { k: 'Costo/target', v: '€0,44', d: '−12% vs mese scorso' },
  ];

  const totalRemoved = RAFF.reduce((s, f) => s + (st.filters[f.k] ? f.removed : 0), 0);
  const raffFinal = UNIVERSO - totalRemoved;

  // enrichment coverage bars from the REAL fill-rates (cov per field).
  const enrichBars: BarRow[] = enrich
    .filter((f) => ['ateco', 'piva', 'email', 'fatturato', 'decisore'].includes(f.k))
    .map((f) => ({ k: f.label, v: f.cov + '%', w: f.cov }));

  // giudizio distribution bars from the REAL quadrant histogram, grouped to A/B/C/D-ish tiers.
  const share = (n: number) => (quadSum ? Math.round((100 * n) / quadSum) : 0);
  const judgmentBars: BarRow[] = js.data && quadSum > 0
    ? [
        { k: 'Target (A+B+)', n: quad['A+B+'] ?? 0 },
        { k: 'Forte un asse', n: (quad['A+B-'] ?? 0) + (quad['A-B+'] ?? 0) },
        { k: 'Debole (A-B-)', n: quad['A-B-'] ?? 0 },
        { k: 'Indeterminato (?)', n: unknownCount },
      ].map((r) => ({ k: r.k, v: share(r.n) + '%', w: share(r.n) }))
    : pctRows([{ k: 'Tier A (target)', v: '13%', w: '13%' }, { k: 'Tier B', v: '23%', w: '23%' }, { k: 'Tier C', v: '34%', w: '34%' }, { k: 'Tier D (anti)', v: '30%', w: '30%' }]);

  const genMap: Record<string, { kpis: { k: string; v: string }[]; title: string; bars: BarRow[] }> = {
    mercato: { kpis: [{ k: 'Raw results', v: '11.480' }, { k: 'Unique', v: fmt(total) }, { k: 'Dedup rate', v: '12,4%' }, { k: 'Net-new', v: '96' }], title: 'Yield per fonte e query', bars: AN_YIELD },
    enrichment: { kpis: [{ k: 'Hit rate', v: '58%' }, { k: 'Conflitti', v: '3,1%' }, { k: 'Costo/campo', v: '€0,018' }, { k: 'Confidence', v: '0,82' }], title: 'Copertura per campo', bars: enrichBars.length ? enrichBars : pctRows([{ k: 'ATECO', v: '71%', w: '71%' }, { k: 'P.IVA', v: '63%', w: '63%' }, { k: 'Email', v: '51%', w: '51%' }, { k: 'Fatturato', v: '31%', w: '31%' }, { k: 'Decisore', v: '8%', w: '8%' }]) },
    raffinazione: { kpis: [{ k: 'Universo', v: fmt(UNIVERSO) }, { k: 'Lista finale', v: fmt(raffFinal) }, { k: '% eliminata', v: Math.round((totalRemoved / UNIVERSO) * 100) + '%' }, { k: 'Recuperabili', v: '1.260' }], title: 'Impatto per filtro', bars: RAFF.map((f) => ({ k: f.label, v: fmt(f.removed), w: Math.round((f.removed / 3120) * 100) })) },
    giudizio: { kpis: [{ k: 'Target', v: targetRate === null ? '13,2%' : String(targetRate).replace('.', ',') + '%' }, { k: 'Unknown', v: unknownRate === null ? '4,1%' : String(unknownRate).replace('.', ',') + '%' }, { k: 'Conf. media', v: '0,82' }, { k: 'Giudicate', v: judged ? fmt(judged) : '2,3%' }], title: 'Distribuzione quadranti', bars: judgmentBars },
  };
  const ag = genMap[st.anTab];

  // geografica: real Padova vs Treviso from province coverage (az/target/tr/ct).
  const provVi = provinces.find((p) => p.id === 'pd');
  const provVr = provinces.find((p) => p.id === 'tv');
  const confronto: typeof CONFRONTO = (provVi && provVr && provVi.az > 0)
    ? [
        { k: 'Aziende', a: fmt(provVi.az), b: fmt(provVr.az) },
        { k: 'Con sito', a: provVi.cov + '%', b: provVr.cov + '%', win: provVi.cov >= provVr.cov ? 'a' : 'b' },
        { k: 'Target', a: fmt(provVi.target), b: fmt(provVr.target), win: provVi.target >= provVr.target ? 'a' : 'b' },
        { k: 'Target rate', a: provVi.tr, b: provVr.tr },
        { k: 'Costo per target', a: provVi.ct, b: provVr.ct },
      ]
    : CONFRONTO;

  // provider: override status for providers the engine flags as dead (real health).
  const deadSet = new Map((ph.data?.providerDead ?? []).map((d) => [d.provider.toLowerCase(), d]));
  const providers = PROVIDERS.map((p) => {
    const dead = [...deadSet.keys()].some((k) => p.nome.toLowerCase().includes(k) || k.includes(p.nome.toLowerCase().split(' ')[0]));
    return dead ? { ...p, stato: 'Inattivo', tone: 'ko' as const } : p;
  });

  return (
    <PageSection>
      <PageHeader kicker="Intelligence" number="04" title="Capire mercato, dati, costi e performance" />
      <Tabs items={TABS} value={st.anTab} onChange={(id) => set({ anTab: id })} label="Analytics" idBase={tabsId} />

      <TabPanel idBase={tabsId} value={st.anTab}>
        {/* overview */}
        {st.anTab === 'overview' && (
          <div className="sx-stack" style={{ gap: '1.1rem' }}>
            <div className="sx-grid sx-grid--kpi sx-grid--joined">
              {anKpis.map((k) => <Stat key={k.k} label={k.k} value={k.v} sub={k.d} />)}
            </div>

            <div className="sx-grid sx-grid--2 sx-grid--joined">
              <Card>
                <PanelHead kicker="Yield per fonte" />
                <div className="sx-mt"><Bars rows={AN_YIELD} /></div>
              </Card>
              <Card>
                <PanelHead kicker="Anomalie e insight" />
                <ul className="sx-insights sx-mt">
                  {AN_INSIGHTS.map((t, i) => <li key={i} className="sx-note">{t}</li>)}
                </ul>
              </Card>
            </div>

            <div className="sx-grid sx-split--trend sx-grid--joined">
              <Card>
                <PanelHead kicker="Acquisizioni · 12 mesi" aside={<span className="sx-meta num">+31% vs T-3</span>} />
                <div className="sx-stat__value" style={{ margin: '0.6rem 0 0.9rem' }}>
                  2.400<span className="sx-stat__unit">aziende/mese</span>
                </div>
                <svg viewBox={`0 0 ${TW} ${TH + 14}`} className="sx-trend" role="img" aria-label="Acquisizioni mensili negli ultimi 12 mesi: da 600 a 2.400 aziende al mese, in crescita costante.">
                  <path d={AREA} className="sx-trend__area" />
                  <polyline points={LINE} className="sx-trend__line" />
                  {TREND.map((v, i) => (
                    <g key={i}>
                      <circle cx={tx(i)} cy={ty(v)} r={2.6} className="sx-trend__dot" />
                      <text x={tx(i)} y={TH + 12} textAnchor="middle" className="sx-trend__tick">{MONTHS[i]}</text>
                    </g>
                  ))}
                </svg>
              </Card>
              <Card>
                <PanelHead kicker="Composizione per tier" />
                <div className="sx-stackbar" aria-hidden="true">
                  {TIER_DATA.map((t) => (
                    <span key={t.k} style={{ width: t.n + '%', '--a': t.a } as CSSProperties} />
                  ))}
                </div>
                <ul className="sx-legend-list">
                  {TIER_DATA.map((t) => (
                    <li key={t.k}>
                      <span className="sx-swatch" style={{ '--a': t.a } as CSSProperties} aria-hidden="true" />
                      <span className="sx-legend-list__k">{t.k}</span>
                      <span className="num sx-cell-strong">{t.n}%</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        )}

        {/* geografica */}
        {st.anTab === 'geografica' && (
          <div className="sx-stack" style={{ gap: '1.25rem' }}>
            <Callout kicker="Aha moment">
              Padova e Treviso sono i due poli tech del Veneto: Padova produce più target per ogni euro speso.
            </Callout>
            <Card pad="flush">
              <Table cols={[1.4, 1, 1]} head={['Metrica', 'Padova', 'Treviso']} label="Confronto Padova e Treviso">
                {confronto.map((r) => (
                  <tr key={r.k}>
                    <td>{r.k}</td>
                    <td className={r.win === 'a' ? 'sx-cell-num sx-win' : 'sx-cell-num'}>{r.a}{r.win === 'a' && <span className="sr-only"> (migliore)</span>}</td>
                    <td className={r.win === 'b' ? 'sx-cell-num sx-win' : 'sx-cell-num'}>{r.b}{r.win === 'b' && <span className="sr-only"> (migliore)</span>}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        )}

        {/* provider */}
        {st.anTab === 'provider' && (
          <div>
            <p className="sx-note" style={{ marginBottom: '1rem' }}>
              Quale provider conviene usare per il fatturato nel settore X e nella provincia Y? Questa dashboard risponde.
            </p>
            <Card pad="flush">
              <Table cols={PROV_COLS} head={['Provider', 'Stato', 'Latenza', 'Yield', 'Costo/ok', 'Copertura']} minWidth={720} label="Provider">
                {providers.map((p) => (
                  <tr key={p.nome}>
                    <td className="sx-cell-strong">{p.nome}</td>
                    <td><StatusDot tone={p.tone}>{p.stato}</StatusDot></td>
                    <td className="sx-cell-num">{p.lat}</td>
                    <td className="sx-cell-num">{p.yield}</td>
                    <td className="sx-cell-num">{p.cost}</td>
                    <td><MiniBar value={pctOf(p.cov)} text={p.cov} /></td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        )}

        {/* costi */}
        {st.anTab === 'costi' && (
          <div className="sx-split sx-split--wide-aside">
            <Card>
              <PanelHead kicker="Costo per fase" />
              <div className="sx-mt"><Bars rows={COST_BARS} size="thick" /></div>
            </Card>
            <Callout kicker="Insight economico">
              Spendendo altri €120 su decisore e LinkedIn porti la copertura dei referenti tecnici (CTO, Head of Engineering) dal 14% al 46%. Per i deeptech il fatturato resta il segnale più debole: pesa di più la fase di finanziamento.
            </Callout>
          </div>
        )}

        {/* generic (mercato / enrichment / raffinazione / giudizio) */}
        {ag && (
          <div className="sx-stack" style={{ gap: '1.1rem' }}>
            <div className="sx-grid sx-grid--kpi sx-grid--joined">
              {ag.kpis.map((k) => <Stat key={k.k} label={k.k} value={k.v} />)}
            </div>
            <Card>
              <PanelHead kicker={ag.title} />
              <div className="sx-mt"><Bars rows={ag.bars} /></div>
            </Card>
          </div>
        )}
      </TabPanel>
    </PageSection>
  );
}
