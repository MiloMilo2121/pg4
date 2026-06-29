import type { Company } from '../data';
import { useCompanies } from '../queries';
import { chipStyle, tierPillStyle } from '../helpers';
import type { ViewProps } from '../ctx';

const SECTION = { padding: '34px 36px 60px', maxWidth: 1180, margin: '0 auto' } as const;
const COLS = '2fr 1.4fr 1fr .9fr .7fr 1fr 1fr';

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
    case 'giudicate': return c.mat === 'Qualificata' || c.mat === 'Target';
    case 'target': return c.mat === 'Target';
    case 'escluse': return c.tier === '—';
    default: return true;
  }
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
  const resultLabel = rows.length + (rows.length === 1 ? ' azienda' : ' aziende') + (st.query.trim() ? ` per “${st.query.trim()}”` : '');
  const hasQuery = st.query.trim().length > 0;

  return (
    <section className="agfade" style={SECTION}>
      <div style={{ marginBottom: 8 }}><span className="kicker">Archivio</span></div>
      <h1 style={{ fontSize: '1.95rem', fontWeight: 500, letterSpacing: '-.02em', marginBottom: 6 }}>Aziende</h1>
      <p style={{ fontSize: '.95rem', color: 'var(--ink-2)', marginBottom: 18 }}>
        Cerca per settore, parola chiave, comune o nome: il sistema filtra l&apos;archivio in tempo reale.
      </p>

      {/* search */}
      <div style={{ position: 'relative', marginBottom: 16 }}>
        <span style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', fontSize: '1rem' }}>⌕</span>
        <input
          value={st.query}
          onChange={(e) => set({ query: e.target.value })}
          placeholder="Es. “tornitura”, “carpenteria inox”, “Schio”, “Tier A”…"
          style={{ width: '100%', boxSizing: 'border-box', padding: '14px 44px 14px 42px', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--paper)', fontFamily: 'var(--sans)', fontSize: '.95rem', color: 'var(--ink)', outline: 'none' }}
        />
        {hasQuery && (
          <button onClick={() => set({ query: '' })} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', fontSize: '.9rem', padding: '4px 8px' }}>✕</button>
        )}
      </div>

      {/* view chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {VIEWS.map(([id, label]) => (
          <button key={id} onClick={() => set({ aziView: id })} style={chipStyle(st.aziView === id)}>
            {label} <span style={{ opacity: 0.6 }}>{counts[id]}</span>
          </button>
        ))}
      </div>

      <div style={{ fontSize: '.78rem', color: 'var(--ink-3)', marginBottom: 12, fontWeight: 600, letterSpacing: '.02em' }}>{resultLabel}</div>

      {/* table */}
      <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, padding: '12px 20px', borderBottom: '1px solid var(--line)', fontSize: '.68rem', fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
          <span>Azienda</span><span>Settore</span><span>Comune</span><span>Fatturato</span><span>Dip.</span><span>Maturità</span><span>Giudizio</span>
        </div>
        {rows.map((c) => (
          <div key={c.nome} className="ag-row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, padding: '13px 20px', borderBottom: '1px solid var(--line-soft)', alignItems: 'center', fontSize: '.86rem' }}>
            <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{c.nome}</span>
            <span style={{ color: 'var(--ink-3)', fontSize: '.8rem' }}>{c.settore}</span>
            <span style={{ color: 'var(--ink-2)' }}>{c.comune}</span>
            <span style={{ color: 'var(--ink-2)' }}>{c.fattN ? c.fattN.toFixed(1).replace('.', ',') + 'M' : '—'}</span>
            <span style={{ color: 'var(--ink-2)' }}>{c.dip || '—'}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 38, height: 5, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: c.matW, background: 'var(--accent)' }} />
              </span>
              <span style={{ fontSize: '.72rem', color: 'var(--ink-3)' }}>{c.mat}</span>
            </span>
            <span style={tierPillStyle(c.tier)}>{c.tier}</span>
          </div>
        ))}
        {rows.length === 0 && (
          <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--ink-3)' }}>
            <div style={{ fontFamily: 'var(--serif)', fontSize: '1.1rem', marginBottom: 6 }}>{isLoading ? 'Caricamento archivio…' : 'Nessuna azienda trovata'}</div>
            <div style={{ fontSize: '.84rem' }}>{isLoading ? 'Connessione al motore pg4.' : 'Prova un’altra parola chiave o cambia vista.'}</div>
          </div>
        )}
      </div>
    </section>
  );
}
