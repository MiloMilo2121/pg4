import type { CSSProperties } from 'react';
import { RAFF } from '../data';
import { useEnrichFields } from '../queries';
import { fmt, tabStyle, prioPillStyle } from '../helpers';
import type { ViewProps } from '../ctx';

const SECTION = { padding: '30px 36px 60px', maxWidth: 1180, margin: '0 auto' } as const;
const TABS: [ViewProps['st']['raffTab'], string][] = [
  ['enrichment', 'Enrichment Center'], ['imbuto', 'Imbuto'], ['viste', 'Viste salvate'],
];
const ENRICH_COLS = '1.6fr 1.3fr 1fr 1fr .8fr';
const UNIVERSO = 18420;

const SAVED = [
  { nome: 'Metalmecc. 5–30M', count: '1.340', desc: 'fascia fatturato media, sito verificato' },
  { nome: 'Alta priorità VI', count: '620', desc: 'Tier A, decisore presente' },
  { nome: 'Da arricchire', count: '2.840', desc: 'dominio sì, fatturato no' },
];

export default function Raffinazione({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const ENRICH = useEnrichFields();
  // enrichment
  const selFields = ENRICH.filter((f) => st.enrich[f.k]);
  const enrichN = selFields.reduce((s, f) => s + f.costN, 0);
  const enrichTargets = selFields.reduce((s, f) => Math.max(s, f.toArr), 0);

  // imbuto
  const totalRemoved = RAFF.reduce((s, f) => s + (st.filters[f.k] ? f.removed : 0), 0);
  const raffFinal = UNIVERSO - totalRemoved;
  const vizStages: { label: string; val: number }[] = [{ label: 'Universo', val: UNIVERSO }];
  let acc = UNIVERSO;
  RAFF.forEach((f) => {
    if (st.filters[f.k]) {
      acc -= f.removed;
      vizStages.push({ label: f.label, val: acc });
    }
  });

  return (
    <section className="agfade" style={SECTION}>
      <div style={{ marginBottom: 8 }}><span className="kicker">Raffinazione</span></div>
      <h1 style={{ fontSize: '1.95rem', fontWeight: 500, letterSpacing: '-.02em', marginBottom: 18 }}>Dal grezzo alla lista utile</h1>
      <div style={{ display: 'flex', gap: 6, marginBottom: 26, borderBottom: '1px solid var(--line)' }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => set({ raffTab: id })} style={tabStyle(st.raffTab === id)}>{label}</button>
        ))}
      </div>

      {/* Enrichment Center */}
      {st.raffTab === 'enrichment' && (
        <div className="agfade" style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 26, alignItems: 'start' }}>
          <div>
            <p style={{ fontSize: '.92rem', color: 'var(--ink-2)', marginBottom: 18 }}>
              Scegli cosa aggiungere solo dopo aver visto quanto manca, quanto costa e quali segmenti abilita. Seleziona i campi da arricchire.
            </p>
            <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: ENRICH_COLS, gap: 10, padding: '12px 18px', borderBottom: '1px solid var(--line)', fontSize: '.66rem', fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                <span>Campo</span><span>Copertura</span><span>Da arricchire</span><span>Costo</span><span>Priorità</span>
              </div>
              {ENRICH.map((f) => {
                const sel = !!st.enrich[f.k];
                const rowStyle: CSSProperties = { width: '100%', textAlign: 'left', display: 'grid', gridTemplateColumns: ENRICH_COLS, gap: 10, padding: '13px 18px', borderBottom: '1px solid var(--line-soft)', alignItems: 'center', fontSize: '.86rem', background: sel ? 'var(--accent-wash)' : 'transparent', transition: 'background .2s' };
                const checkStyle: CSSProperties = { width: 18, height: 18, borderRadius: 5, border: '1.5px solid ' + (sel ? 'var(--accent)' : 'var(--line)'), background: sel ? 'var(--accent)' : 'transparent', color: 'var(--white)', fontSize: '.7rem', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' };
                return (
                  <button key={f.k} className="ag-row" onClick={() => set({ enrich: { ...st.enrich, [f.k]: !st.enrich[f.k] } })} style={rowStyle}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={checkStyle}>{sel ? '✓' : ''}</span>
                      <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{f.label}</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 54, height: 5, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden' }}>
                        <span style={{ display: 'block', height: '100%', width: f.cov + '%', background: 'var(--accent)' }} />
                      </span>
                      <span style={{ fontSize: '.78rem', color: 'var(--ink-2)' }}>{f.cov}%</span>
                    </span>
                    <span style={{ color: 'var(--ink-2)', fontSize: '.86rem' }}>{fmt(f.toArr)}</span>
                    <span style={{ color: 'var(--ink-2)', fontSize: '.86rem' }}>{f.cost}</span>
                    <span style={prioPillStyle(f.prio)}>{f.prio}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ position: 'sticky', top: 0 }}>
            <div style={{ background: 'var(--paper)', border: '1px solid var(--accent-line)', borderRadius: 14, padding: 20, boxShadow: 'var(--shadow-card)' }}>
              <span className="kicker">Anteprima costo</span>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '2.2rem', fontWeight: 500, color: 'var(--accent)', margin: '10px 0 2px', lineHeight: 1 }}>€ {fmt(enrichN)}</div>
              <div style={{ fontSize: '.76rem', color: 'var(--ink-3)', marginBottom: 16 }}>{selFields.length} campi · {fmt(enrichTargets)} aziende</div>
              <div style={{ background: 'var(--accent-wash)', borderRadius: 11, padding: '13px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: '.82rem', color: 'var(--ink-2)', lineHeight: 1.5 }}>
                  {selFields.length ? `Aggiungendo questi campi rendi filtrabili fino a ${fmt(enrichTargets)} aziende e abiliti i segmenti per fascia di fatturato.` : "Seleziona almeno un campo per vedere l'impatto sul dataset."}
                </div>
              </div>
              <button className="btn btn-solid" style={{ width: '100%', justifyContent: 'center' }}><span>Arricchisci</span><span className="gl">→</span></button>
            </div>
          </div>
        </div>
      )}

      {/* Imbuto */}
      {st.raffTab === 'imbuto' && (
        <div className="agfade" style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 30, alignItems: 'start' }}>
          <div>
            <p style={{ fontSize: '.88rem', color: 'var(--ink-2)', marginBottom: 16 }}>Attiva o disattiva ogni filtro: la lista finale si ricalcola in tempo reale.</p>
            <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 14px' }}>
                <span style={{ fontWeight: 600 }}>Universo iniziale</span>
                <span style={{ fontFamily: 'var(--serif)', fontSize: '1.05rem' }}>{fmt(UNIVERSO)}</span>
              </div>
              {RAFF.map((f) => {
                const active = !!st.filters[f.k];
                return (
                  <button key={f.k} className="ag-row" onClick={() => set({ filters: { ...st.filters, [f.k]: !st.filters[f.k] } })} style={{ width: '100%', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 14px', borderRadius: 9, background: 'transparent' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 3, background: active ? 'var(--accent)' : 'var(--line)', flex: 'none' }} />
                      <span style={{ fontSize: '.86rem', color: active ? 'var(--ink)' : 'var(--ink-3)', textDecoration: active ? 'none' : 'line-through' }}>{f.label}</span>
                    </span>
                    <span style={{ fontSize: '.84rem', color: active ? 'var(--accent)' : 'var(--ink-3)', fontWeight: 600 }}>{active ? '−' + fmt(f.removed) : 'off'}</span>
                  </button>
                );
              })}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: 14, marginTop: 6, borderTop: '1.6px solid var(--accent-line)', background: 'var(--accent-wash)', borderRadius: 11 }}>
                <span style={{ fontWeight: 700, color: 'var(--accent)' }}>Lista finale</span>
                <span style={{ fontFamily: 'var(--serif)', fontSize: '1.4rem', fontWeight: 500, color: 'var(--accent)' }}>{fmt(raffFinal)}</span>
              </div>
            </div>
          </div>
          <div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', marginBottom: 24 }}>
              {vizStages.map((v, i) => {
                const last = i === vizStages.length - 1;
                return (
                  <div key={v.label + i} style={{ width: 40 + (v.val / UNIVERSO) * 60 + '%', transition: 'width .55s cubic-bezier(.16,1,.3,1)' }}>
                    <div style={{ background: last ? 'var(--accent)' : 'var(--accent-wash)', border: '1px solid var(--accent-line)', borderRadius: 9, padding: '13px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '.82rem', fontWeight: 600, color: last ? 'var(--white)' : 'var(--ink)' }}>{v.label}</span>
                      <span style={{ fontFamily: 'var(--serif)', fontSize: '1.05rem', color: last ? 'var(--white)' : 'var(--ink)' }}>{fmt(v.val)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ background: 'var(--accent-wash)', border: '1px solid var(--accent-line)', borderRadius: 13, padding: '18px 20px' }}>
              <span className="kicker">Insight</span>
              <p style={{ fontFamily: 'var(--serif)', fontSize: '1.05rem', color: 'var(--ink)', lineHeight: 1.5, marginTop: 8 }}>
                Il filtro fatturato elimina il 62% del mercato, mentre il giudizio solo il 14%. Il principale discriminante è dimensionale, non qualitativo.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Viste salvate */}
      {st.raffTab === 'viste' && (
        <div className="agfade" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
          {SAVED.map((v) => (
            <div key={v.nome} className="ag-card-h" style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 14, padding: 20 }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '1.1rem', fontWeight: 500, marginBottom: 8 }}>{v.nome}</div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '1.6rem', color: 'var(--accent)' }}>{v.count}</div>
              <div style={{ fontSize: '.74rem', color: 'var(--ink-3)', marginTop: 8 }}>{v.desc}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
