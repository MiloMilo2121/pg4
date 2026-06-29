import { fmt } from '../helpers';
import type { ViewProps } from '../ctx';
import { useMetrics, useJudgmentSummary, useDedupReview, useCost, useMarkets, useProvincesCoverage } from '../queries';

const SECTION = { padding: '34px 36px 60px', maxWidth: 1180, margin: '0 auto' } as const;

export default function Home({ set }: Pick<ViewProps, 'set'>) {
  const m = useMetrics();
  const js = useJudgmentSummary();
  const dd = useDedupReview();
  const cost = useCost();
  const markets = useMarkets();
  const provinces = useProvincesCoverage();

  const total = m.data?.total ?? 0;
  const withWebsite = m.data?.withWebsite ?? 0;
  const fr = m.data?.fillRates ?? {};
  const pct = (n: number) => (total ? Math.round((100 * n) / total) : 0);
  const conFatturato = Math.round(((fr.revenue ?? 0) / 100) * total);
  const conEmail = Math.round(((fr.email ?? 0) / 100) * total);
  const giudicate = js.data?.judged ?? 0;
  const targetCount = Object.values(js.data?.targets ?? {}).reduce((s, n) => s + n, 0);
  const dups = (dd.data?.candidates?.length ?? 0);
  const provCoperte = provinces.filter((p) => p.az > 0).length;
  const costoSessione = cost.data ? cost.data.seedRunCostEur + cost.data.liveSessionCostEur : 0;

  const kpis = [
    { label: 'Aziende complessive', value: fmt(total), sub: 'nel database pg4', subColor: 'var(--accent)' },
    { label: 'Mercati mappati', value: String(markets.length), sub: `su ${provCoperte} province`, subColor: 'var(--ink-3)' },
    { label: 'Con sito', value: fmt(withWebsite), sub: `${pct(withWebsite)}% del totale`, subColor: 'var(--ink-3)' },
    { label: 'Con fatturato', value: fmt(conFatturato), sub: `${fr.revenue ?? 0}% arricchito`, subColor: 'var(--ink-3)' },
    { label: 'Con email', value: fmt(conEmail), sub: 'inferita + verificata MX', subColor: 'var(--accent)' },
    { label: 'Possibili duplicati', value: fmt(dups), sub: 'da rivedere', subColor: 'var(--accent-2)' },
    { label: 'Giudicate', value: fmt(giudicate), sub: giudicate ? 'dal judgment layer' : 'nessuna ancora', subColor: 'var(--ink-3)' },
    { label: 'Costo sessione', value: `€ ${costoSessione.toFixed(2)}`, sub: 'free-first, €0 di default', subColor: 'var(--ink-3)' },
  ];

  // Funnel from REAL counts (acquisite → con sito → con fatturato → giudicate → target).
  const funnelData: [string, number][] = [
    ['Aziende acquisite', total],
    ['Con sito', withWebsite],
    ['Con fatturato', conFatturato],
    ['Giudicate', giudicate],
    ['Target utili', targetCount],
  ];
  const maxV = total || 1;
  let prev = total;
  const funnel = funnelData.map(([label, val], i) => {
    const delta = prev - val;
    prev = val;
    const w = Math.max(18, Math.round((100 * val) / maxV));
    const last = i === funnelData.length - 1;
    return {
      label,
      value: fmt(val),
      w: w + '%',
      fill: last ? 'var(--accent)' : 'var(--accent-wash)',
      textColor: last ? 'var(--white)' : 'var(--ink)',
      delta: i === 0 ? '' : '-' + fmt(delta),
      showDelta: i !== 0,
    };
  });

  const topProv = [...provinces].sort((a, b) => b.az - a.az)[0];
  const suggestions = [
    { text: `${fmt(Math.max(0, withWebsite - conEmail))} aziende hanno un sito ma nessuna email: inferenza + handshake MX a €0.`, cta: 'Arricchisci email', onClick: () => set({ nav: 'raff', raffTab: 'enrichment' }) },
    { text: giudicate ? `${fmt(giudicate)} aziende già giudicate dal judgment layer.` : 'Nessuna azienda ancora giudicata: lancia la valutazione a due assi.', cta: 'Valuta le aziende', onClick: () => set({ nav: 'val' }) },
    { text: dups ? `${fmt(dups)} possibili duplicati segnalati per revisione.` : 'Nessun duplicato in sospeso.', cta: 'Rivedi duplicati', onClick: () => set({ nav: 'raff', raffTab: 'imbuto' }) },
    { text: topProv ? `Provincia con più aziende: ${topProv.name} (${fmt(topProv.az)}).` : 'Mappa un nuovo territorio per iniziare.', cta: 'Apri territorio', onClick: () => set({ nav: 'italia', itLevel: 'regione' }) },
  ];

  return (
    <section className="agfade" style={SECTION}>
      <div style={{ marginBottom: 8 }}><span className="kicker">Cockpit</span></div>
      <h1 style={{ fontSize: '2.1rem', fontWeight: 500, letterSpacing: '-.02em', marginBottom: 6 }}>Il sistema, a colpo d&apos;occhio</h1>
      <p style={{ fontSize: '1.05rem', color: 'var(--ink-2)', maxWidth: 620, marginBottom: 30 }}>
        Mappi il mercato, raccogli il grezzo, migliori i dati, tagli il rumore, estrai il segmento. Ecco dove sei nel percorso.
      </p>

      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 38 }}>
        {kpis.map((k) => (
          <div key={k.label} className="ag-card-h" style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: '17px 18px' }}>
            <div style={{ fontSize: '.68rem', fontWeight: 600, letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 9 }}>{k.label}</div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: '1.85rem', fontWeight: 500, lineHeight: 1, color: 'var(--ink)' }}>{k.value}</div>
            <div style={{ fontSize: '.76rem', color: k.subColor, marginTop: 7 }}>{k.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr .85fr', gap: 26, alignItems: 'start' }}>
        {/* funnel */}
        <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 16, padding: '24px 26px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
            <span className="kicker">Funnel di maturità</span>
            <span style={{ fontSize: '.74rem', color: 'var(--ink-3)' }}>grezzo → utile</span>
          </div>
          <p style={{ fontSize: '.85rem', color: 'var(--ink-2)', marginBottom: 20 }}>
            Da {fmt(total)} aziende acquisite a {fmt(targetCount)} target realmente utili.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'center' }}>
            {funnel.map((f) => (
              <div key={f.label} style={{ width: f.w, transition: 'width .6s cubic-bezier(.16,1,.3,1)' }}>
                <div style={{ position: 'relative', background: f.fill, border: '1px solid var(--accent-line)', borderRadius: 9, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '.82rem', fontWeight: 600, color: f.textColor }}>{f.label}</span>
                  <span style={{ fontFamily: 'var(--serif)', fontSize: '1.05rem', fontWeight: 500, color: f.textColor }}>{f.value}</span>
                </div>
                {f.showDelta && <div style={{ textAlign: 'center', fontSize: '.66rem', color: 'var(--ink-3)', padding: '2px 0' }}>▼ {f.delta}</div>}
              </div>
            ))}
          </div>
        </div>

        {/* suggestions */}
        <div>
          <div style={{ marginBottom: 14 }}><span className="kicker">Prossimo passo</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {suggestions.map((s) => (
              <button key={s.cta} className="ag-card-h" onClick={s.onClick} style={{ textAlign: 'left', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 13, padding: '15px 16px', display: 'flex', gap: 13, alignItems: 'flex-start' }}>
                <span style={{ fontSize: '1.05rem', flex: 'none', marginTop: 1, color: 'var(--accent)' }}>◆</span>
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: '.88rem', color: 'var(--ink)', lineHeight: 1.4, marginBottom: 5 }}>{s.text}</span>
                  <span style={{ fontSize: '.74rem', fontWeight: 600, color: 'var(--accent)', borderBottom: '1px solid var(--accent-line)' }}>{s.cta} →</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
