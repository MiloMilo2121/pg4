import { useMarkets } from '../queries';
import { fmt, EMPTY } from '../helpers';
import type { ViewProps } from '../ctx';
import { PageSection, PageHeader } from '../ui/Page';
import { Stat } from '../ui/Stat';
import { Pill, type PillTone } from '../ui/Pill';
import { Bar } from '../ui/Bar';
import { EmptyState } from '../ui/Callout';

/** Dataset maturity → pill tone: the further along, the darker. */
function statoTone(stato: string): PillTone {
  if (stato.includes('arricchito')) return 'wash';
  if (stato.includes('raffinare')) return 'outline';
  return 'muted';
}

export default function Mercati({ set }: Pick<ViewProps, 'set'>) {
  const markets = useMarkets();
  return (
    <PageSection>
      <PageHeader
        kicker="Mercati" number="02"
        title="I tuoi dataset di mercato"
        lead="Ogni dataset è l’universo acquisito per un settore e un territorio. Lo stato descrive la sua maturità, non un job tecnico."
      />
      {markets.length === 0 && <EmptyState title="Caricamento mercati dal motore" />}
      <div className="sx-grid sx-grid--2 sx-grid--joined">
        {markets.map((m) => (
          <button key={m.id} type="button" className="mm-card mm-card--interactive sx-market-card" onClick={() => set({ nav: 'italia', market: m.id })}>
            <span className="sx-market-card__top">
              <span>
                <span className="sx-market-card__title">{m.settore}</span>
                <span className="sx-meta">{m.territorio}</span>
              </span>
              <Pill tone={statoTone(m.stato)}>{m.stato}</Pill>
            </span>
            <span className="sx-market-card__stats">
              <Stat boxed={false} variant="value-top" size="sm" value={fmt(m.aziende)} label="aziende" />
              <Stat boxed={false} variant="value-top" size="sm" value={m.target ? fmt(m.target) : EMPTY} label="con sito" />
              <Stat boxed={false} variant="value-top" size="sm" value={String(m.comuni)} label={m.comuni === 1 ? 'provincia' : 'province'} />
            </span>
            <Bar value={m.cov} label={`Copertura dati ${m.settore}`} />
            <span className="sx-market-card__foot sx-meta">
              <span>Copertura dati <span className="num">{m.cov}%</span></span>
              <span>agg. {m.ultimo}</span>
            </span>
          </button>
        ))}
      </div>
    </PageSection>
  );
}
