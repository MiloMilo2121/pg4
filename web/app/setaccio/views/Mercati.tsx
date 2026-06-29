import { useMarkets } from '../queries';
import { fmt, statePillStyle } from '../helpers';
import type { ViewProps } from '../ctx';

const SECTION = { padding: '34px 36px 60px', maxWidth: 1180, margin: '0 auto' } as const;

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: '1.3rem', fontWeight: 500 }}>{value}</div>
      <div style={{ fontSize: '.7rem', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.1em' }}>{label}</div>
    </div>
  );
}

export default function Mercati({ set }: Pick<ViewProps, 'set'>) {
  const markets = useMarkets();
  return (
    <section className="agfade" style={SECTION}>
      <div style={{ marginBottom: 8 }}><span className="kicker">Mercati</span></div>
      <h1 style={{ fontSize: '1.95rem', fontWeight: 500, letterSpacing: '-.02em', marginBottom: 6 }}>I tuoi Market Dataset</h1>
      <p style={{ fontSize: '1rem', color: 'var(--ink-2)', maxWidth: 620, marginBottom: 28 }}>
        Ogni dataset è l&apos;universo acquisito per un settore e un territorio. Lo stato descrive la sua maturità, non un job tecnico.
      </p>
      {markets.length === 0 && (
        <p style={{ fontSize: '.9rem', color: 'var(--ink-3)' }}>Caricamento mercati dal motore…</p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>
        {markets.map((m) => (
          <button key={m.id} className="ag-card-h" onClick={() => set({ nav: 'italia', market: m.id })} style={{ textAlign: 'left', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 16, padding: '22px 24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: '1.22rem', fontWeight: 500, lineHeight: 1.2, marginBottom: 3 }}>{m.settore}</div>
                <div style={{ fontSize: '.82rem', color: 'var(--ink-3)' }}>{m.territorio}</div>
              </div>
              <span style={statePillStyle(m.stato)}>{m.stato}</span>
            </div>
            <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
              <Stat value={fmt(m.aziende)} label="aziende" />
              <Stat value={m.target ? fmt(m.target) : '—'} label="target" />
              <Stat value={String(m.comuni)} label="comuni" />
            </div>
            <div style={{ height: 6, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden', marginBottom: 7 }}>
              <div style={{ height: '100%', width: m.cov + '%', background: 'var(--accent)', borderRadius: 999 }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.74rem', color: 'var(--ink-3)' }}>
              <span>Copertura dati {m.cov}%</span>
              <span>agg. {m.ultimo}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
