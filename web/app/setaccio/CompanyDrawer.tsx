'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import type { ViewProps } from './ctx';
import { useCompanies } from './queries';
import { useJudgmentDetail } from './jobs';
import type { Company } from '../../lib/api';

/**
 * Right-side detail drawer. Surfaces the schema-v4 engine fields (rating/reviews,
 * extra socials, firmographics, utile netto) that the table doesn't show, plus a
 * "Giudizio" tab loading the real verdict (honest empty state on 404 = unjudged).
 * net_profit is labelled "Utile netto" — NEVER conflated with fatturato.
 */
export default function CompanyDrawer({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const [tab, setTab] = useState<'dati' | 'giudizio'>('dati');
  const { raw } = useCompanies();
  const c = raw.find((r) => r.id === st.selectedCompanyId) as Company | undefined;
  const close = () => set({ selectedCompanyId: null });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 205, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={close} style={{ position: 'absolute', inset: 0, background: 'rgba(33,27,20,.28)' }} />
      <aside className="agfade ag-scroll" style={{ position: 'relative', width: 'min(460px, 92vw)', height: '100%', overflowY: 'auto', background: 'var(--paper)', borderLeft: '1px solid var(--accent-line)', boxShadow: 'var(--shadow-modal)' }}>
        {/* header */}
        <div style={{ padding: '22px 24px 14px', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'var(--paper)', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <span className="kicker">{c?.category ?? '—'}</span>
              <h3 style={{ fontFamily: 'var(--serif)', fontSize: '1.5rem', fontWeight: 500, lineHeight: 1.18, margin: '4px 0 0' }}>{c?.company_name ?? 'Azienda'}</h3>
              <div style={{ fontSize: '.82rem', color: 'var(--ink-2)', marginTop: 4 }}>{[c?.city, c?.province].filter(Boolean).join(' · ') || '—'}</div>
            </div>
            <button onClick={close} style={{ fontSize: '1.1rem', color: 'var(--ink-3)', padding: '2px 6px', cursor: 'pointer' }}>✕</button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            {(['dati', 'giudizio'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} style={{ fontSize: '.8rem', fontWeight: 600, padding: '7px 14px', borderRadius: 999, cursor: 'pointer', background: tab === t ? 'var(--accent)' : 'transparent', color: tab === t ? 'var(--white)' : 'var(--ink-2)', border: '1px solid ' + (tab === t ? 'var(--accent)' : 'var(--line)') }}>
                {t === 'dati' ? 'Dati' : 'Giudizio'}
              </button>
            ))}
          </div>
        </div>

        {!c ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-3)' }}>Azienda non trovata.</div>
        ) : tab === 'dati' ? (
          <DataTab c={c} />
        ) : (
          <GiudizioTab id={c.id} />
        )}
      </aside>
    </div>
  );
}

function DataTab({ c }: { c: Company }) {
  const socials = ([['Instagram', c.instagram], ['Facebook', c.facebook], ['LinkedIn', c.linkedin], ['TikTok', c.tiktok], ['YouTube', c.youtube]] as const).filter(([, v]) => !!v);
  return (
    <div style={{ padding: '18px 24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Section title="Contatti">
        <Row k="Sito" v={c.official_website} link />
        <Row k="Telefono" v={c.phone} />
        <Row k="Email" v={c.email_inferred} />
        <Row k="PEC" v={c.pec} />
        <Row k="P.IVA" v={c.vat_code_final} />
      </Section>

      {(c.rating || c.reviews_count) && (
        <Section title="Reputazione (Google)">
          <Row k="Valutazione" v={c.rating ? `★ ${c.rating}` : undefined} />
          <Row k="Recensioni" v={c.reviews_count} />
        </Section>
      )}

      {socials.length > 0 && (
        <Section title="Social">
          {socials.map(([label, v]) => <Row key={label} k={label} v={v as string} link />)}
        </Section>
      )}

      {(c.legal_form || c.ateco || c.founding_year || c.share_capital || c.revenue || c.net_profit) && (
        <Section title="Firmografica & bilancio">
          <Row k="Forma giuridica" v={c.legal_form} />
          <Row k="ATECO" v={c.ateco} />
          <Row k="Anno fondazione" v={c.founding_year} />
          <Row k="Capitale sociale" v={c.share_capital} />
          <Row k="Fatturato" v={c.revenue} />
          <Row k="Utile netto" v={c.net_profit ? `${c.net_profit}${c.net_profit_year ? ` (${c.net_profit_year})` : ''}` : undefined} />
          <Row k="Dipendenti" v={c.employees} />
        </Section>
      )}

      {c.decision_maker_name && (
        <Section title="Decisore">
          <Row k="Nome" v={c.decision_maker_name} />
        </Section>
      )}
    </div>
  );
}

function GiudizioTab({ id }: { id: string }) {
  const q = useJudgmentDetail(id);
  if (q.isLoading) return <Pad>Carico il giudizio…</Pad>;
  if (q.isError || !q.data?.verdetto_gap) {
    return (
      <Pad>
        <div style={{ fontFamily: 'var(--serif)', fontSize: '1.1rem', color: 'var(--ink-2)', marginBottom: 8 }}>Azienda non ancora giudicata</div>
        <div style={{ fontSize: '.84rem', color: 'var(--ink-3)' }}>Lancia &quot;Giudica&quot; dalla Valutazione per generare verdetto, assi A/B e leva.</div>
      </Pad>
    );
  }
  const d = q.data;
  const v = d.verdetto_gap;
  return (
    <div style={{ padding: '18px 24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Section title="Verdetto">
        <Row k="Quadrante" v={v?.quadrant} />
        <Row k="Target" v={v?.target} />
        <Row k="Score A / B" v={v?.scoreA != null ? `${v.scoreA} / ${v?.scoreB ?? '—'}` : undefined} />
        <Row k="Gap" v={v?.gapWidth ?? (v?.gap != null ? String(v.gap) : undefined)} />
        {v?.motivation && <div style={{ fontSize: '.86rem', color: 'var(--ink-2)', lineHeight: 1.55, marginTop: 6 }}>{v.motivation}</div>}
      </Section>
      {d.valutazione_a && <Section title="Asse A"><Row k="Livello" v={d.valutazione_a.level} /><Row k="Score" v={String(d.valutazione_a.score)} />{d.valutazione_a.rationale && <Note t={d.valutazione_a.rationale} />}</Section>}
      {d.valutazione_b && <Section title="Asse B"><Row k="Livello" v={d.valutazione_b.level} /><Row k="Score" v={String(d.valutazione_b.score)} />{d.valutazione_b.rationale && <Note t={d.valutazione_b.rationale} />}</Section>}
      {d.leva && d.leva.length > 0 && (
        <Section title="Leve">
          {d.leva.map((l, i) => <div key={i} style={{ fontSize: '.84rem', color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 6 }}><strong style={{ color: 'var(--ink)' }}>{l.kind}</strong>{l.description ? ` — ${l.description}` : ''}</div>)}
        </Section>
      )}
    </div>
  );
}

// ---- small presentational helpers (warm Setaccio style) ----
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="kicker kicker--muted" style={{ marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}
function Row({ k, v, link }: { k: string; v?: string | null; link?: boolean }) {
  if (!v) return null;
  const valStyle: CSSProperties = { fontSize: '.86rem', color: 'var(--ink)', textAlign: 'right', maxWidth: '64%', wordBreak: 'break-word' };
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
      <span style={{ fontSize: '.78rem', color: 'var(--ink-3)' }}>{k}</span>
      {link ? <a href={v.startsWith('http') ? v : `https://${v}`} target="_blank" rel="noopener noreferrer" style={{ ...valStyle, color: 'var(--accent)' }}>{v.replace(/^https?:\/\//, '')}</a> : <span style={valStyle}>{v}</span>}
    </div>
  );
}
function Note({ t }: { t: string }) {
  return <div style={{ fontSize: '.82rem', color: 'var(--ink-2)', lineHeight: 1.55, marginTop: 4 }}>{t}</div>;
}
function Pad({ children }: { children: ReactNode }) {
  return <div style={{ padding: '40px 28px', textAlign: 'center' }}>{children}</div>;
}
