import { RAFF } from '../data';
import { fmt, tabStyle } from '../helpers';
import { useTotal, useMetrics, useProviderHealth, useEnrichFields, useJudgmentSummary, useProvincesCoverage } from '../queries';
import type { ViewProps } from '../ctx';

const SECTION = { padding: '30px 36px 60px', maxWidth: 1180, margin: '0 auto' } as const;
const TABS: [ViewProps['st']['anTab'], string][] = [
  ['overview', 'Overview'], ['mercato', 'Mercato'], ['enrichment', 'Enrichment'],
  ['raffinazione', 'Raffinazione'], ['giudizio', 'Giudizio'], ['geografica', 'Geografica'],
  ['provider', 'Provider'], ['costi', 'Costi'],
];

const AN_YIELD = [
  { k: 'PagineGialle', v: '14.2k', w: '88%' }, { k: 'Google Maps', v: '11.8k', w: '74%' },
  { k: 'FatturatoItalia', v: '6.1k', w: '42%' }, { k: 'Openapi', v: '3.4k', w: '24%' },
];
const AN_INSIGHTS = [
  "Openapi ha copertura fatturato 71% nel metalmeccanico vicentino, ma solo 43% nell'hospitality veneziano.",
  'Il filtro fatturato elimina il 62% del mercato; il giudizio solo il 14%. Il discriminante è dimensionale.',
  '416 possibili duplicati rilevati su impronta P.IVA + telefono nelle ultime 3 run.',
];
const TIER_DATA = [
  { k: 'Tier A · target', n: 13, fill: 'var(--accent)' },
  { k: 'Tier B', n: 23, fill: 'var(--accent-2)' },
  { k: 'Tier C', n: 34, fill: 'rgba(151,88,47,0.34)' },
  { k: 'Tier D · anti', n: 30, fill: 'rgba(151,88,47,0.14)' },
];
const CONFRONTO = [
  { k: 'Aziende', a: '18.420', b: '24.100', cA: 'var(--ink)', cB: 'var(--ink)' },
  { k: 'Con fatturato', a: '71%', b: '48%', cA: 'var(--accent)', cB: 'var(--ink-2)' },
  { k: 'Target', a: '1.840', b: '1.320', cA: 'var(--accent)', cB: 'var(--ink-2)' },
  { k: 'Target rate', a: '10,0%', b: '5,5%', cA: 'var(--accent)', cB: 'var(--ink-2)' },
  { k: 'Costo per target', a: '€0,42', b: '€0,79', cA: 'var(--accent)', cB: 'var(--ink-2)' },
];
const PROVIDERS = [
  { nome: 'PagineGialle', stato: 'Attivo', dot: 'var(--ok)', lat: '1,2s', yield: '88%', cost: '€0', cov: '92%' },
  { nome: 'Google Maps', stato: 'Attivo', dot: 'var(--ok)', lat: '0,9s', yield: '74%', cost: '€0', cov: '78%' },
  { nome: 'FatturatoItalia', stato: 'Attivo', dot: 'var(--ok)', lat: '2,4s', yield: '42%', cost: '€0,016', cov: '61%' },
  { nome: 'Openapi', stato: 'Degradato', dot: 'var(--accent-2)', lat: '4,1s', yield: '24%', cost: '€0,030', cov: '44%' },
  { nome: 'LinkedIn (sniper)', stato: 'Limitato', dot: 'var(--accent-2)', lat: '6,8s', yield: '19%', cost: '€0,050', cov: '19%' },
  { nome: 'PEC registry', stato: 'Attivo', dot: 'var(--ok)', lat: '1,0s', yield: '56%', cost: '€0', cov: '44%' },
];
const COST_BARS = [
  { k: 'Scraping', v: '€ 0', w: '4%' }, { k: 'Enrichment fatturato', v: '€ 142', w: '54%' },
  { k: 'Enrichment dipendenti', v: '€ 118', w: '46%' }, { k: 'Decisore / social', v: '€ 96', w: '38%' }, { k: 'Giudizio LLM', v: '€ 34', w: '14%' },
];
const PROV_COLS = '1.4fr .8fr .8fr .8fr .9fr 1fr';

// 12-month acquisition trend → svg line + area
const TREND = [4.2, 4.6, 5.1, 5.0, 5.8, 6.4, 6.9, 7.2, 8.1, 8.6, 9.4, 9.9];
const MONTHS = ['L', 'F', 'M', 'A', 'M', 'G', 'L', 'A', 'S', 'O', 'N', 'D'];
const TW = 520, TH = 150, TPAD = 8, TMAX = 11, TMIN = 3;
const tx = (i: number) => TPAD + i * ((TW - TPAD * 2) / (TREND.length - 1));
const ty = (v: number) => TH - TPAD - ((v - TMIN) / (TMAX - TMIN)) * (TH - TPAD * 2);
const LINE = TREND.map((v, i) => tx(i) + ',' + ty(v).toFixed(1)).join(' ');
const AREA = 'M ' + tx(0) + ',' + (TH - TPAD) + ' L ' + TREND.map((v, i) => tx(i) + ',' + ty(v).toFixed(1)).join(' L ') + ' L ' + tx(TREND.length - 1) + ',' + (TH - TPAD) + ' Z';

function Bars({ rows }: { rows: { k: string; v: string; w: string }[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: 16 }}>
      {rows.map((y) => (
        <div key={y.k}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.8rem', marginBottom: 4 }}>
            <span style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{y.k}</span>
            <span style={{ color: 'var(--ink-3)' }}>{y.v}</span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: y.w, background: 'var(--accent)', borderRadius: 999 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Analytics({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
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
    { k: 'Dataset', v: fmt(total), d: '+184 / settimana' },
    { k: 'Completezza', v: completezza === null ? '54%' : completezza + '%', d: 'media campi anagrafici' },
    { k: 'Target rate', v: targetRate === null ? '4,3%' : String(targetRate).replace('.', ',') + '%', d: judged ? 'sui giudicati' : 'media portfolio' },
    { k: 'Costo/target', v: '€0,52', d: '−12% vs mese scorso' },
  ];

  const totalRemoved = RAFF.reduce((s, f) => s + (st.filters[f.k] ? f.removed : 0), 0);
  const raffFinal = 18420 - totalRemoved;

  // enrichment coverage bars from the REAL fill-rates (cov per field).
  const enrichBars = enrich
    .filter((f) => ['ateco', 'piva', 'email', 'fatturato', 'decisore'].includes(f.k))
    .map((f) => ({ k: f.label, v: f.cov + '%', w: f.cov + '%' }));

  // giudizio distribution bars from the REAL quadrant histogram, grouped to A/B/C/D-ish tiers.
  const judgmentBars = js.data && quadSum > 0
    ? [
        { k: 'Target (A+B+)', n: quad['A+B+'] ?? 0 },
        { k: 'Forte un asse', n: (quad['A+B-'] ?? 0) + (quad['A-B+'] ?? 0) },
        { k: 'Debole (A-B-)', n: quad['A-B-'] ?? 0 },
        { k: 'Indeterminato (?)', n: unknownCount },
      ].map((r) => ({ k: r.k, v: quadSum ? Math.round((100 * r.n) / quadSum) + '%' : '0%', w: quadSum ? Math.round((100 * r.n) / quadSum) + '%' : '0%' }))
    : [{ k: 'Tier A (target)', v: '13%', w: '13%' }, { k: 'Tier B', v: '23%', w: '23%' }, { k: 'Tier C', v: '34%', w: '34%' }, { k: 'Tier D (anti)', v: '30%', w: '30%' }];

  const genMap: Record<string, { kpis: { k: string; v: string }[]; title: string; bars: { k: string; v: string; w: string }[] }> = {
    mercato: { kpis: [{ k: 'Raw results', v: '52.140' }, { k: 'Unique', v: fmt(total) }, { k: 'Dedup rate', v: '12,4%' }, { k: 'Net-new', v: '184' }], title: 'Yield per fonte e query', bars: AN_YIELD },
    enrichment: { kpis: [{ k: 'Hit rate', v: '58%' }, { k: 'Conflitti', v: '3,1%' }, { k: 'Costo/campo', v: '€0,018' }, { k: 'Confidence', v: '0,82' }], title: 'Copertura per campo', bars: enrichBars.length ? enrichBars : [{ k: 'ATECO', v: '71%', w: '71%' }, { k: 'P.IVA', v: '63%', w: '63%' }, { k: 'Email', v: '51%', w: '51%' }, { k: 'Fatturato', v: '31%', w: '31%' }, { k: 'Decisore', v: '8%', w: '8%' }] },
    raffinazione: { kpis: [{ k: 'Universo', v: '18.420' }, { k: 'Lista finale', v: fmt(raffFinal) }, { k: '% eliminata', v: Math.round((totalRemoved / 18420) * 100) + '%' }, { k: 'Recuperabili', v: '2.840' }], title: 'Impatto per filtro', bars: RAFF.map((f) => ({ k: f.label, v: fmt(f.removed), w: Math.round((f.removed / 6800) * 100) + '%' })) },
    giudizio: { kpis: [{ k: 'Target', v: targetRate === null ? '13,2%' : String(targetRate).replace('.', ',') + '%' }, { k: 'Unknown', v: unknownRate === null ? '4,1%' : String(unknownRate).replace('.', ',') + '%' }, { k: 'Conf. media', v: '0,82' }, { k: 'Giudicate', v: judged ? fmt(judged) : '2,3%' }], title: 'Distribuzione quadranti', bars: judgmentBars },
  };
  const ag = genMap[st.anTab];

  // geografica: real Vicenza vs Verona from province coverage (az/target/tr/ct).
  const provVi = provinces.find((p) => p.id === 'vi');
  const provVr = provinces.find((p) => p.id === 'vr');
  const confronto = (provVi && provVr && provVi.az > 0)
    ? [
        { k: 'Aziende', a: fmt(provVi.az), b: fmt(provVr.az), cA: 'var(--ink)', cB: 'var(--ink)' },
        { k: 'Con sito', a: provVi.cov + '%', b: provVr.cov + '%', cA: 'var(--accent)', cB: 'var(--ink-2)' },
        { k: 'Target', a: fmt(provVi.target), b: fmt(provVr.target), cA: 'var(--accent)', cB: 'var(--ink-2)' },
        { k: 'Target rate', a: provVi.tr, b: provVr.tr, cA: 'var(--accent)', cB: 'var(--ink-2)' },
        { k: 'Costo per target', a: provVi.ct, b: provVr.ct, cA: 'var(--accent)', cB: 'var(--ink-2)' },
      ]
    : CONFRONTO;

  // provider: override status/dot for providers the engine flags as dead (real health).
  const deadSet = new Map((ph.data?.providerDead ?? []).map((d) => [d.provider.toLowerCase(), d]));
  const providers = PROVIDERS.map((p) => {
    const dead = [...deadSet.keys()].some((k) => p.nome.toLowerCase().includes(k) || k.includes(p.nome.toLowerCase().split(' ')[0]));
    return dead ? { ...p, stato: 'Inattivo', dot: 'var(--accent-2)' } : p;
  });

  return (
    <section className="agfade" style={SECTION}>
      <div style={{ marginBottom: 8 }}><span className="kicker">Intelligence</span></div>
      <h1 style={{ fontSize: '1.95rem', fontWeight: 500, letterSpacing: '-.02em', marginBottom: 18 }}>Capire mercato, dati, costi e performance</h1>
      <div style={{ display: 'flex', gap: 6, marginBottom: 26, borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => set({ anTab: id })} style={tabStyle(st.anTab === id)}>{label}</button>
        ))}
      </div>

      {/* overview */}
      {st.anTab === 'overview' && (
        <div className="agfade">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 22 }}>
            {anKpis.map((k) => (
              <div key={k.k} className="ag-card-h" style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 13, padding: 17 }}>
                <div style={{ fontSize: '.66rem', fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 9 }}>{k.k}</div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: '1.8rem', fontWeight: 500 }}>{k.v}</div>
                <div style={{ fontSize: '.74rem', color: 'var(--accent)', marginTop: 6 }}>{k.d}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
            <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 22 }}>
              <span className="kicker">Yield per fonte</span>
              <Bars rows={AN_YIELD} />
            </div>
            <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 22 }}>
              <span className="kicker">Anomalie &amp; insight</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: 14 }}>
                {AN_INSIGHTS.map((t, i) => (
                  <div key={i} style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--accent)', flex: 'none' }}>✎</span>
                    <span style={{ fontSize: '.86rem', color: 'var(--ink-2)', lineHeight: 1.5 }}>{t}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 18, marginTop: 18 }}>
            <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 22 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span className="kicker">Acquisizioni · 12 mesi</span>
                <span style={{ fontSize: '.78rem', color: 'var(--accent)', fontWeight: 600 }}>+18% vs T-3</span>
              </div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '1.7rem', fontWeight: 500, marginBottom: 14 }}>
                9.900<span style={{ fontSize: '.8rem', color: 'var(--ink-3)', fontWeight: 400 }}> aziende/mese</span>
              </div>
              <svg viewBox="0 0 520 150" preserveAspectRatio="none" style={{ width: '100%', height: 150, overflow: 'visible' }}>
                <defs>
                  <linearGradient id="setaccio-trendg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={AREA} fill="url(#setaccio-trendg)" />
                <polyline points={LINE} fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
                {TREND.map((v, i) => (
                  <g key={i}>
                    <circle cx={tx(i)} cy={ty(v)} r={2.6} fill="var(--accent)" />
                    <text x={tx(i)} y={TH + 4} textAnchor="middle" style={{ fontFamily: 'var(--sans)', fontSize: 9, fill: 'var(--ink-3)' }}>{MONTHS[i]}</text>
                  </g>
                ))}
              </svg>
            </div>
            <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 22 }}>
              <span className="kicker">Composizione per tier</span>
              <div style={{ display: 'flex', height: 14, borderRadius: 999, overflow: 'hidden', margin: '16px 0' }}>
                {TIER_DATA.map((t) => (
                  <div key={t.k} style={{ width: t.n + '%', background: t.fill }} />
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {TIER_DATA.map((t) => (
                  <div key={t.k} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: '.82rem' }}>
                    <span style={{ width: 11, height: 11, borderRadius: 3, background: t.fill, flex: 'none' }} />
                    <span style={{ color: 'var(--ink-2)', flex: 1 }}>{t.k}</span>
                    <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{t.n}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* geografica */}
      {st.anTab === 'geografica' && (
        <div className="agfade">
          <div style={{ background: 'var(--accent-wash)', border: '1px solid var(--accent-line)', borderRadius: 14, padding: '20px 24px', marginBottom: 22 }}>
            <span className="kicker">Aha moment</span>
            <p style={{ fontFamily: 'var(--serif)', fontSize: '1.2rem', color: 'var(--ink)', lineHeight: 1.5, marginTop: 8 }}>
              Vicenza contiene meno aziende di Verona, ma produce quasi il doppio dei target per ogni euro speso.
            </p>
          </div>
          <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 12, padding: '14px 22px', borderBottom: '1px solid var(--line)', fontSize: '.68rem', fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
              <span>Metrica</span><span>Vicenza</span><span>Verona</span>
            </div>
            {confronto.map((r) => (
              <div key={r.k} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 12, padding: '13px 22px', borderBottom: '1px solid var(--line-soft)', fontSize: '.9rem' }}>
                <span style={{ color: 'var(--ink-2)' }}>{r.k}</span>
                <span style={{ fontWeight: 600, color: r.cA }}>{r.a}</span>
                <span style={{ fontWeight: 600, color: r.cB }}>{r.b}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* provider */}
      {st.anTab === 'provider' && (
        <div className="agfade">
          <p style={{ fontSize: '.9rem', color: 'var(--ink-2)', marginBottom: 18 }}>
            Quale provider conviene usare per il fatturato nel settore X e nella provincia Y? Questa dashboard risponde.
          </p>
          <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: PROV_COLS, gap: 10, padding: '13px 20px', borderBottom: '1px solid var(--line)', fontSize: '.66rem', fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
              <span>Provider</span><span>Stato</span><span>Latenza</span><span>Yield</span><span>Costo/ok</span><span>Copertura</span>
            </div>
            {providers.map((p) => (
              <div key={p.nome} className="ag-row" style={{ display: 'grid', gridTemplateColumns: PROV_COLS, gap: 10, padding: '13px 20px', borderBottom: '1px solid var(--line-soft)', alignItems: 'center', fontSize: '.86rem' }}>
                <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{p.nome}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink-2)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.dot }} />{p.stato}
                </span>
                <span style={{ color: 'var(--ink-2)' }}>{p.lat}</span>
                <span style={{ color: 'var(--ink-2)' }}>{p.yield}</span>
                <span style={{ color: 'var(--ink-2)' }}>{p.cost}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 42, height: 5, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden' }}>
                    <span style={{ display: 'block', height: '100%', width: p.cov, background: 'var(--accent)' }} />
                  </span>
                  <span style={{ fontSize: '.76rem', color: 'var(--ink-3)' }}>{p.cov}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* costi */}
      {st.anTab === 'costi' && (
        <div className="agfade" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 24, alignItems: 'start' }}>
          <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 22 }}>
            <span className="kicker">Costo per fase</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 13, marginTop: 16 }}>
              {COST_BARS.map((c) => (
                <div key={c.k}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.82rem', marginBottom: 4 }}>
                    <span style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{c.k}</span>
                    <span style={{ color: 'var(--ink)' }}>{c.v}</span>
                  </div>
                  <div style={{ height: 9, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: c.w, background: 'var(--accent)', borderRadius: 999 }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ background: 'var(--accent-wash)', border: '1px solid var(--accent-line)', borderRadius: 14, padding: 20 }}>
            <span className="kicker">Insight economico</span>
            <p style={{ fontFamily: 'var(--serif)', fontSize: '1.05rem', color: 'var(--ink)', lineHeight: 1.55, marginTop: 10 }}>
              Spendendo altri €84 aumenti la copertura fatturato dal 61% al 79%, ma solo 240 nuove aziende entrerebbero nella fascia target.
            </p>
          </div>
        </div>
      )}

      {/* generic (mercato / enrichment / raffinazione / giudizio) */}
      {ag && (
        <div className="agfade">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
            {ag.kpis.map((k) => (
              <div key={k.k} style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: '.66rem', fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 8 }}>{k.k}</div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: '1.6rem', fontWeight: 500 }}>{k.v}</div>
              </div>
            ))}
          </div>
          <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 22 }}>
            <span className="kicker">{ag.title}</span>
            <Bars rows={ag.bars} />
          </div>
        </div>
      )}
    </section>
  );
}
