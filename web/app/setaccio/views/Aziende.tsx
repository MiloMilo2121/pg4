import { NO_TIER, type Company } from '../data';
import { useCompanies } from '../queries';
import { EMPTY } from '../helpers';
import type { ViewProps } from '../ctx';
import { PageSection, PageHeader } from '../ui/Page';
import { Chip } from '../ui/Choice';
import { Table } from '../ui/Table';
import { MiniBar, pctOf } from '../ui/Bar';
import { Pill, type PillTone } from '../ui/Pill';
import { EmptyState } from '../ui/Callout';
import { CloseButton } from '../ui/Dialog';
import { Card } from '../../ds/components/Card';
import { cx } from '../../ds/components/cx';
import { Icon } from '../../ds/components/Icon';

const COLS = [2, 1.4, 1, 0.9, 0.7, 1.15, 1];
const HEAD = ['Azienda', 'Settore', 'Comune', 'Fatturato', 'Dip.', 'Maturità', 'Giudizio'];

type View = ViewProps['st']['aziView'];
const VIEWS: [View, string][] = [
  ['tutte', 'Tutte'], ['grezze', 'Grezze'], ['arricchite', 'Arricchite'],
  ['giudicate', 'Giudicate'], ['target', 'Target'], ['escluse', 'Escluse'],
];

function inView(c: Company, v: View): boolean {
  switch (v) {
    case 'tutte': return true;
    case 'grezze': return c.mat === 'Base' || c.mat === 'Grezza';
    case 'arricchite': return c.mat === 'Arricchita';
    case 'giudicate': return c.tier !== NO_TIER;
    case 'target': return c.mat === 'Target';
    case 'escluse': return c.excluded === true;
    default: return true;
  }
}

/** Tier A is the target: solid. B outlined, C/D quiet, unjudged muted. */
function tierTone(tier: string): PillTone {
  if (tier === 'Tier A') return 'solid';
  if (tier === 'Tier B') return 'outline';
  if (tier === NO_TIER) return 'muted';
  return 'wash';
}


export default function Aziende({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const { companies, isLoading } = useCompanies();
  const counts: Record<View, number> = {
    tutte: 0, grezze: 0, arricchite: 0, giudicate: 0, target: 0, escluse: 0,
  };
  (Object.keys(counts) as View[]).forEach((v) => {
    counts[v] = companies.filter((c) => inView(c, v)).length;
  });

  const q = st.query.trim().toLowerCase();
  const rows = companies.filter((c) => {
    if (!inView(c, st.aziView)) return false;
    if (!q) return true;
    return (c.nome + ' ' + c.comune + ' ' + c.settore + ' ' + c.kw + ' ' + c.tier).toLowerCase().includes(q);
  });
  const resultLabel = rows.length + (rows.length === 1 ? ' azienda' : ' aziende') + (st.query.trim() ? ` per «${st.query.trim()}»` : '');
  const hasQuery = st.query.trim().length > 0;
  const open = (c: Company) => c.id && set({ selectedCompanyId: c.id });

  return (
    <PageSection>
      <PageHeader
        kicker="Archivio" number="02"
        title="Aziende"
        lead="Cerca per settore, parola chiave, comune o nome: il sistema filtra l’archivio in tempo reale."
      />

      <div className="sx-search" style={{ marginBottom: '1rem' }}>
        <label htmlFor="sx-azi-search" className="sr-only">Cerca nell’archivio</label>
        <Icon name="search" size={15} className="sx-search__icon" />
        <input
          id="sx-azi-search"
          type="search"
          className="sx-search__input"
          value={st.query}
          onChange={(e) => set({ query: e.target.value })}
          placeholder="Es. computer vision, SaaS HR, Trento, Tier A"
          autoComplete="off"
        />
        {hasQuery && (
          <span className="sx-search__clear">
            <CloseButton onClick={() => set({ query: '' })} label="Cancella la ricerca" />
          </span>
        )}
      </div>

      <div className="sx-chips" role="group" aria-label="Vista" style={{ marginBottom: '0.9rem' }}>
        {VIEWS.map(([id, label]) => (
          <Chip key={id} pressed={st.aziView === id} onClick={() => set({ aziView: id })} count={counts[id]}>{label}</Chip>
        ))}
      </div>

      <p className="sx-meta num" role="status" style={{ marginBottom: '0.75rem' }}>{resultLabel}</p>

      <Card pad="flush">
        {rows.length > 0 && (
          <Table cols={COLS} head={HEAD} minWidth={820} label="Aziende nell’archivio">
            {rows.map((c) => (
              <tr key={c.id ?? c.nome} className={cx(c.id && 'sx-tr--action')} onClick={() => open(c)}>
                <td>
                  {c.id ? (
                    <button type="button" className="sx-rowbtn" onClick={(e) => { e.stopPropagation(); open(c); }}>{c.nome}</button>
                  ) : (
                    <span className="sx-cell-strong">{c.nome}</span>
                  )}
                </td>
                <td className="sx-cell-sub">{c.settore}</td>
                <td>{c.comune}</td>
                <td className="sx-cell-num">{c.fattN ? c.fattN.toFixed(1).replace('.', ',') + 'M' : EMPTY}</td>
                <td className="sx-cell-num">{c.dip || EMPTY}</td>
                <td><MiniBar value={pctOf(c.matW)} text={c.mat} /></td>
                <td><Pill tone={tierTone(c.tier)}>{c.tier}</Pill></td>
              </tr>
            ))}
          </Table>
        )}
        {rows.length === 0 && (
          <EmptyState icon={isLoading ? 'job' : 'search'} title={isLoading ? 'Caricamento archivio' : 'Nessuna azienda trovata'}>
            {isLoading ? 'Connessione al motore pg4.' : 'Prova un’altra parola chiave o cambia vista.'}
          </EmptyState>
        )}
      </Card>
    </PageSection>
  );
}
