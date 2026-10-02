import type { CSSProperties } from 'react';
import { fmt } from '../helpers';
import { PageSection, PageHeader, PanelHead } from '../ui/Page';
import { Stat } from '../ui/Stat';
import { Funnel } from '../ui/Funnel';
import { Callout } from '../ui/Callout';
import { Card } from '../../ds/components/Card';
import type { ViewProps } from '../ctx';
import { useMetrics, useHealth, useJudgmentSummary, useDedupReview, useCost, useMarkets, useCoverage, fmtEur } from '../queries';

export default function Home({ set }: Pick<ViewProps, 'set'>) {
  const m = useMetrics();
  const health = useHealth();
  const js = useJudgmentSummary();
  const dd = useDedupReview();
  const cost = useCost();
  const markets = useMarkets();
  const coverage = useCoverage();

  const total = m.data?.total ?? 0;
  const withWebsite = m.data?.withWebsite ?? 0;
  const fr = m.data?.fillRates ?? {};
  const pct = (n: number) => (total ? Math.round((100 * n) / total) : 0);
  const conFatturato = Math.round(((fr.revenue ?? 0) / 100) * total);
  const conEmail = Math.round(((fr.email ?? 0) / 100) * total);
  const giudicate = js.data?.judged ?? 0;
  const targetCount = Object.values(js.data?.targets ?? {}).reduce((s, n) => s + n, 0);
  const dups = (dd.data?.candidates?.length ?? 0);
  const provinces = coverage.data?.provinces ?? [];
  const provCoperte = provinces.length;
  // This server session's jobs only; the seed run's cost is in Sistema → Costi cumulati.
  const costoSessione = cost.data?.liveSessionCostEur;

  const kpis = [
    { label: 'Aziende complessive', value: fmt(total), sub: 'nel database pg4' },
    { label: 'Mercati mappati', value: String(markets.length), sub: `su ${provCoperte} province` },
    { label: 'Con sito', value: fmt(withWebsite), sub: `${pct(withWebsite)}% del totale` },
    { label: 'Con fatturato', value: fmt(conFatturato), sub: `${String(fr.revenue ?? 0).replace('.', ',')}% arricchito` },
    { label: 'Con email', value: fmt(conEmail), sub: 'inferita e verificata MX' },
    { label: 'Possibili duplicati', value: fmt(dups), sub: dups ? 'da rivedere' : 'nessuno in sospeso' },
    { label: 'Giudicate', value: fmt(giudicate), sub: giudicate ? 'dal judgment layer' : 'nessuna ancora' },
    { label: 'Costo sessione', value: fmtEur(costoSessione), sub: costoSessione === null ? 'non misurato' : 'free-first, €0 di default' },
  ];

  // Funnel from REAL counts (acquisite → con sito → con fatturato → giudicate → target).
  const funnel = [
    { label: 'Aziende acquisite', value: total },
    { label: 'Con sito', value: withWebsite },
    { label: 'Con fatturato', value: conFatturato },
    { label: 'Giudicate', value: giudicate },
    { label: 'Target utili', value: targetCount },
  ];

  const topProv = provinces[0];
  const suggestions = [
    { text: `${fmt(Math.max(0, withWebsite - conEmail))} aziende hanno un sito ma nessuna email: inferenza e handshake MX a €0.`, cta: 'Arricchisci email', onClick: () => set({ nav: 'raff', raffTab: 'enrichment' }) },
    { text: giudicate ? `${fmt(giudicate)} aziende già giudicate dal judgment layer.` : 'Nessuna azienda ancora giudicata: lancia la valutazione a due assi.', cta: 'Valuta le aziende', onClick: () => set({ nav: 'val' }) },
    { text: dups ? `${fmt(dups)} possibili duplicati segnalati per revisione.` : 'Nessun duplicato in sospeso.', cta: 'Rivedi duplicati', onClick: () => set({ nav: 'raff', raffTab: 'imbuto' }) },
    { text: topProv ? `Provincia con più aziende: ${topProv.province}${topProv.region ? ` (${topProv.region})` : ''}, ${fmt(topProv.total)}.` : 'Mappa un nuovo territorio per iniziare.', cta: 'Apri territorio', onClick: () => set({ nav: 'italia', itLevel: 'regione' }) },
  ];

  return (
    <PageSection>
      <PageHeader
        kicker="Cockpit" number="01"
        title="Il sistema, a colpo d’occhio"
        lead="Mappi il mercato, raccogli il grezzo, migliori i dati, tagli il rumore, estrai il segmento. Ecco dove sei nel percorso."
      >
        {health.data?.seedEmpty === true && (
          <div className="sx-mt">
            <Callout tone="quiet" role="status">
              <strong>Database vuoto.</strong> Premi «Mappa il mercato» per raccogliere aziende dal vivo, oppure avvia <code>pnpm demo</code> per il dataset dimostrativo.
            </Callout>
          </div>
        )}
      </PageHeader>

      <div className="sx-grid sx-grid--kpi sx-grid--joined" style={{ marginBottom: '2rem' }}>
        {kpis.map((k) => <Stat key={k.label} label={k.label} value={k.value} sub={k.sub} />)}
      </div>

      <div className="sx-grid sx-split--home" style={{ gap: '1.6rem', alignItems: 'start' }}>
        <Card>
          <PanelHead kicker="Funnel di maturità" aside={<span className="sx-meta">grezzo → utile</span>} />
          <p className="sx-note" style={{ margin: '0.35rem 0 1.25rem' }}>
            Da {fmt(total)} aziende acquisite a {fmt(targetCount)} target realmente utili.
          </p>
          <Funnel steps={funnel} base={total} minPct={34} label="Funnel di maturità" />
        </Card>

        <div>
          <PanelHead kicker="Prossimo passo" />
          <div className="sx-stack" style={{ marginTop: '0.85rem', '--gap': '0.65rem' } as CSSProperties}>
            {suggestions.map((s) => (
              <button key={s.cta} type="button" className="mm-card mm-card--interactive mm-card--tight sx-suggest" onClick={s.onClick}>
                <span className="sx-suggest__text">{s.text}</span>
                <span className="mm-link sx-suggest__cta">{s.cta} <span aria-hidden="true">→</span></span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </PageSection>
  );
}
