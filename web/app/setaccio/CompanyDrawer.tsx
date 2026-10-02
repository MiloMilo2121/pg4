'use client';

import { useId, useState, type ReactNode } from 'react';
import type { ViewProps } from './ctx';
import { useCompanies } from './queries';
import { useJudgmentDetail } from './jobs';
import type { Company } from '../../lib/api';
import { EMPTY } from './helpers';
import { Kicker } from '../ds/components/Kicker';
import { Icon } from '../ds/components/Icon';
import { Drawer, CloseButton } from './ui/Dialog';
import { Tabs, TabPanel } from './ui/Tabs';
import { EmptyState } from './ui/Callout';

const TABS = [['dati', 'Dati'], ['giudizio', 'Giudizio']] as const;

/**
 * Right-side detail drawer. Surfaces the schema-v4 engine fields (rating/reviews,
 * extra socials, firmographics, utile netto) that the table doesn't show, plus a
 * "Giudizio" tab loading the real verdict (honest empty state on 404 = unjudged).
 * net_profit is labelled "Utile netto": NEVER conflated with fatturato.
 */
export default function CompanyDrawer({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const titleId = useId();
  const tabsId = useId();
  const [tab, setTab] = useState<'dati' | 'giudizio'>('dati');
  const { raw } = useCompanies();
  const c = raw.find((r) => r.id === st.selectedCompanyId) as Company | undefined;
  const close = () => set({ selectedCompanyId: null });

  return (
    <Drawer onClose={close} labelledBy={titleId}>
      <div className="sx-drawer__head">
        <div className="sx-row-flex" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Kicker>{c?.category ?? EMPTY}</Kicker>
            <h2 id={titleId} className="sx-dialog__title">{c?.company_name ?? 'Azienda'}</h2>
            <div className="sx-meta" style={{ marginTop: '0.25rem' }}>{[c?.city, c?.province].filter(Boolean).join(' · ') || EMPTY}</div>
          </div>
          <CloseButton onClick={close} label="Chiudi la scheda" />
        </div>
        <div style={{ marginTop: '0.85rem' }}>
          <Tabs items={TABS} value={tab} onChange={setTab} label="Scheda azienda" idBase={tabsId} variant="pill" />
        </div>
      </div>

      <TabPanel idBase={tabsId} value={tab}>
        {!c ? <EmptyState title="Azienda non trovata" /> : tab === 'dati' ? <DataTab c={c} /> : <GiudizioTab id={c.id} />}
      </TabPanel>
    </Drawer>
  );
}

function DataTab({ c }: { c: Company }) {
  const socials = ([['Instagram', c.instagram], ['Facebook', c.facebook], ['LinkedIn', c.linkedin], ['TikTok', c.tiktok], ['YouTube', c.youtube]] as const).filter(([, v]) => !!v);
  return (
    <div className="sx-drawer__body">
      <Section title="Contatti">
        <Row k="Sito" v={c.official_website} link />
        <Row k="Telefono" v={c.phone} />
        <Row k="Email" v={c.email_inferred} />
        <Row k="PEC" v={c.pec} />
        <Row k="P.IVA" v={c.vat_code_final} mono />
      </Section>

      {(c.rating || c.reviews_count) && (
        <Section title="Reputazione (Google)">
          <Row k="Valutazione" v={c.rating ? `${c.rating} su 5` : undefined} mono />
          <Row k="Recensioni" v={c.reviews_count} mono />
        </Section>
      )}

      {socials.length > 0 && (
        <Section title="Social">
          {socials.map(([label, v]) => <Row key={label} k={label} v={v as string} link />)}
        </Section>
      )}

      {(c.legal_form || c.ateco || c.founding_year || c.share_capital || c.revenue || c.net_profit) && (
        <Section title="Firmografica e bilancio">
          <Row k="Forma giuridica" v={c.legal_form} />
          <Row k="ATECO" v={c.ateco} mono />
          <Row k="Anno fondazione" v={c.founding_year} mono />
          <Row k="Capitale sociale" v={c.share_capital} mono />
          <Row k="Fatturato" v={c.revenue} mono />
          <Row k="Utile netto" v={c.net_profit ? `${c.net_profit}${c.net_profit_year ? ` (${c.net_profit_year})` : ''}` : undefined} mono />
          <Row k="Dipendenti" v={c.employees} mono />
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
  if (q.isLoading) return <EmptyState title="Carico il giudizio" />;
  if (q.isError || !q.data?.verdetto_gap) {
    return (
      <EmptyState title="Azienda non ancora giudicata">
        Lancia «Giudica» dalla Valutazione per generare verdetto, assi A/B e leva.
      </EmptyState>
    );
  }
  const d = q.data;
  const v = d.verdetto_gap;
  return (
    <div className="sx-drawer__body">
      <Section title="Verdetto">
        <Row k="Quadrante" v={v?.quadrant} mono />
        <Row k="Target" v={v?.target} />
        <Row k="Score A / B" v={v?.scoreA != null ? `${v.scoreA} / ${v?.scoreB ?? EMPTY}` : undefined} mono />
        <Row k="Gap" v={v?.gapWidth ?? (v?.gap != null ? String(v.gap) : undefined)} />
        {v?.motivation && <p className="sx-note" style={{ marginTop: '0.35rem' }}>{v.motivation}</p>}
      </Section>
      {d.valutazione_a && (
        <Section title="Asse A">
          <Row k="Livello" v={d.valutazione_a.level} />
          <Row k="Score" v={String(d.valutazione_a.score)} mono />
          {d.valutazione_a.rationale && <p className="sx-note">{d.valutazione_a.rationale}</p>}
        </Section>
      )}
      {d.valutazione_b && (
        <Section title="Asse B">
          <Row k="Livello" v={d.valutazione_b.level} />
          <Row k="Score" v={String(d.valutazione_b.score)} mono />
          {d.valutazione_b.rationale && <p className="sx-note">{d.valutazione_b.rationale}</p>}
        </Section>
      )}
      {d.leva && d.leva.length > 0 && (
        <Section title="Leve">
          {d.leva.map((l, i) => (
            <p key={i} className="sx-note">
              <strong>{l.kind}</strong>
              {l.description ? `: ${l.description}` : ''}
            </p>
          ))}
        </Section>
      )}
    </div>
  );
}

// ---- small presentational helpers ----
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <Kicker muted>{title}</Kicker>
      <div className="sx-dl" style={{ marginTop: '0.55rem' }}>{children}</div>
    </section>
  );
}
function Row({ k, v, link, mono }: { k: string; v?: string | null; link?: boolean; mono?: boolean }) {
  if (!v) return null;
  return (
    <div className="sx-dl__row">
      <span className="sx-dl__k">{k}</span>
      {link ? (
        <a href={v.startsWith('http') ? v : `https://${v}`} target="_blank" rel="noopener noreferrer" className="sx-dl__v mm-link sx-iconlink">
          {v.replace(/^https?:\/\//, '')}
          <Icon name="external" size={12} title="si apre in una nuova scheda" />
        </a>
      ) : (
        <span className={mono ? 'sx-dl__v num' : 'sx-dl__v'}>{v}</span>
      )}
    </div>
  );
}
