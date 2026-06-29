import type { CSSProperties } from 'react';
import { CREDITS } from '../data';
import { useRuns, useProviderHealth, useCost } from '../queries';
import { fmt } from '../helpers';

const SECTION = { padding: '34px 36px 60px', maxWidth: 1180, margin: '0 auto' } as const;

// Illustrative fallback (used only until the engine writes output/_runs.jsonl).
const RUNS_FALLBACK = [
  { nome: 'Scraping · Verona Serramenti', meta: '24.100 record · 38 comuni', stato: 'Completato', dot: 'var(--ok)' },
  { nome: 'Enrichment · fatturato VI', meta: '8.910 aziende in coda', stato: 'In corso', dot: 'var(--accent)' },
  { nome: 'Giudizio · Vicenza metalmecc.', meta: '128 in attesa', stato: 'In coda', dot: 'var(--accent-2)' },
  { nome: 'Scraping · Padova edili', meta: 'ultimo run 90gg fa', stato: 'Da aggiornare', dot: 'var(--ink-3)' },
];
const DEDUP = [{ k: 'su P.IVA', v: '1.160' }, { k: 'su telefono', v: '420' }, { k: 'su nome', v: '380' }];

const RUN_STATUS: Record<string, { label: string; dot: string }> = {
  ok: { label: 'Completato', dot: 'var(--ok)' },
  done: { label: 'Completato', dot: 'var(--ok)' },
  running: { label: 'In corso', dot: 'var(--accent)' },
  queued: { label: 'In coda', dot: 'var(--accent-2)' },
  error: { label: 'Errore', dot: 'var(--accent-2)' },
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** real run row → the existing "Run recenti" line shape (name/meta/stato/dot). */
function adaptRun(r: Record<string, unknown>) {
  const status = (str(r.status) ?? '').toLowerCase();
  const s = RUN_STATUS[status] ?? { label: str(r.status) ?? '—', dot: 'var(--ink-3)' };
  const cmd = str(r.command) ?? str(r.kind) ?? 'run';
  const id = str(r.run_id) ?? str(r.id);
  const out = num(r.leads_out) ?? num(r.with_website);
  const cost = num(r.total_cost_eur);
  const dead = Array.isArray(r.provider_dead) ? (r.provider_dead as unknown[]).filter((x) => typeof x === 'string') : [];
  const metaBits: string[] = [];
  if (out !== undefined) metaBits.push(`${fmt(out)} record`);
  if (cost !== undefined) metaBits.push(`€ ${cost.toFixed(2)}`);
  if (dead.length) metaBits.push(`provider ko: ${dead.join(', ')}`);
  return {
    nome: id ? `${cmd} · ${id}` : cmd,
    meta: metaBits.join(' · ') || '—',
    stato: s.label,
    dot: s.dot,
  };
}

export default function Sistema() {
  const creditsAlert = CREDITS.filter((c) => c.resN <= c.soglia).length;
  const runsQ = useRuns();
  const ph = useProviderHealth();
  const cost = useCost();
  const realRuns = runsQ.data?.runs ?? [];
  const RUNS = realRuns.length ? realRuns.map(adaptRun) : RUNS_FALLBACK;
  const costCumulato = cost.data ? cost.data.seedRunCostEur + cost.data.liveSessionCostEur : null;
  const deadProviders = ph.data?.providerDead ?? [];

  return (
    <section className="agfade" style={SECTION}>
      <div style={{ marginBottom: 8 }}><span className="kicker">Sistema</span></div>
      <h1 style={{ fontSize: '1.95rem', fontWeight: 500, letterSpacing: '-.02em', marginBottom: 22 }}>Run, provider, costi, deduplica</h1>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <span className="kicker">Credito provider a pagamento</span>
        {creditsAlert > 0 && <span style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--accent-2)' }}>⚠ {creditsAlert} da ricaricare</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 30 }}>
        {CREDITS.map((c) => {
          const pct = Math.round((c.resN / c.totN) * 100);
          const low = c.resN <= c.soglia;
          const warn = !low && c.giorni <= 14;
          const state = low ? 'Da ricaricare' : warn ? 'In esaurimento' : 'OK';
          const sc = low ? 'var(--accent-2)' : warn ? 'var(--accent)' : 'var(--ok)';
          const statePill: CSSProperties = { fontSize: '.66rem', fontWeight: 600, padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap', background: low ? 'rgba(180,122,76,.16)' : warn ? 'var(--accent-wash)' : 'var(--paper-3)', color: sc };
          const ctaStyle: CSSProperties = { marginTop: 13, width: '100%', padding: 9, borderRadius: 9, fontSize: '.78rem', fontWeight: 600, background: low ? 'var(--accent)' : 'transparent', color: low ? 'var(--white)' : 'var(--ink-2)', border: '1px solid ' + (low ? 'var(--accent)' : 'var(--line)') };
          return (
            <div key={c.id} className="ag-card-h" style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: sc }} />
                  <span style={{ fontWeight: 600, fontSize: '.88rem', color: 'var(--ink)', lineHeight: 1.2 }}>{c.nome}</span>
                </div>
                <span style={statePill}>{state}</span>
              </div>
              <div style={{ fontSize: '.7rem', color: 'var(--ink-3)', marginBottom: 12 }}>{c.piano}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 9 }}>
                <span style={{ fontFamily: 'var(--serif)', fontSize: '1.7rem', fontWeight: 500, color: 'var(--ink)', lineHeight: 1 }}>{c.res}</span>
                <span style={{ fontSize: '.74rem', color: 'var(--ink-3)' }}>/ {c.tot}</span>
              </div>
              <div style={{ height: 6, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden', marginBottom: 9 }}>
                <div style={{ height: '100%', width: pct + '%', background: low ? 'var(--accent-2)' : 'var(--accent)', borderRadius: 999 }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.72rem', color: 'var(--ink-3)' }}>
                <span>{c.cons}</span>
                <span style={{ fontWeight: 600 }}>~{c.giorni} gg</span>
              </div>
              <button style={ctaStyle}>{low ? 'Ricarica ora →' : 'Gestisci'}</button>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' }}>
        <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="kicker">Run recenti</span>
            {deadProviders.length > 0 && <span style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--accent-2)' }}>⚠ {deadProviders.length} provider ko</span>}
          </div>
          <div style={{ marginTop: 14 }}>
            {RUNS.map((r) => (
              <div key={r.nome} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderTop: '1px solid var(--line-soft)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.dot, flex: 'none' }} />
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', fontSize: '.86rem', fontWeight: 600, color: 'var(--ink)' }}>{r.nome}</span>
                  <span style={{ fontSize: '.74rem', color: 'var(--ink-3)' }}>{r.meta}</span>
                </span>
                <span style={{ fontSize: '.76rem', color: 'var(--ink-2)', fontWeight: 600 }}>{r.stato}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 20 }}>
            <span className="kicker">Deduplica</span>
            <div style={{ display: 'flex', gap: 20, marginTop: 14 }}>
              {DEDUP.map((d) => (
                <div key={d.k}>
                  <div style={{ fontFamily: 'var(--serif)', fontSize: '1.5rem', fontWeight: 500, color: 'var(--ink)' }}>{d.v}</div>
                  <div style={{ fontSize: '.7rem', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 3 }}>{d.k}</div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: '.78rem', color: 'var(--ink-3)', marginTop: 14, lineHeight: 1.5 }}>Impronte su P.IVA, telefono e nome. 416 possibili duplicati da rivedere.</p>
          </div>
          <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 20 }}>
            <span className="kicker">Costi cumulati</span>
            <div style={{ fontFamily: 'var(--serif)', fontSize: '2rem', fontWeight: 500, color: 'var(--accent)', marginTop: 10 }}>{costCumulato === null ? '€ 1.284' : `€ ${costCumulato.toFixed(2)}`}</div>
            <div style={{ fontSize: '.76rem', color: 'var(--ink-3)' }}>{costCumulato === null ? 'ultimi 30 giorni · tier Free + Medium' : 'sessione corrente · free-first, €0 di default'}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
