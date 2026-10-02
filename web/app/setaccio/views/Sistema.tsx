import { CREDITS } from '../data';
import { useRuns, useProviderHealth, useCost, fmtEur } from '../queries';
import { fmt, EMPTY } from '../helpers';
import { PageSection, PageHeader, PanelHead } from '../ui/Page';
import { Stat } from '../ui/Stat';
import { Pill, StatusDot, type DotTone, type PillTone } from '../ui/Pill';
import { Bar } from '../ui/Bar';
import { Card } from '../../ds/components/Card';
import { Button } from '../../ds/components/Button';
import { Icon } from '../../ds/components/Icon';

// Illustrative fallback (used only until the engine writes output/_runs.jsonl).
const RUNS_FALLBACK: Run[] = [
  { nome: 'Scraping · Milano SaaS B2B', meta: '3.420 record · 24 comuni', stato: 'Completato', tone: 'ok' },
  { nome: 'Enrichment · decisori TO', meta: '1.180 aziende in coda', stato: 'In corso', tone: 'run' },
  { nome: 'Giudizio · Trento deeptech', meta: '96 in attesa', stato: 'In coda', tone: 'idle' },
  { nome: 'Scraping · Padova biotech', meta: 'ultimo run 90gg fa', stato: 'Da aggiornare', tone: 'muted' },
];
const DEDUP = [{ k: 'su P.IVA', v: '96' }, { k: 'su telefono', v: '71' }, { k: 'su nome', v: '45' }];

interface Run {
  nome: string;
  meta: string;
  stato: string;
  tone: DotTone;
}

const RUN_STATUS: Record<string, { label: string; tone: DotTone }> = {
  ok: { label: 'Completato', tone: 'ok' },
  done: { label: 'Completato', tone: 'ok' },
  running: { label: 'In corso', tone: 'run' },
  queued: { label: 'In coda', tone: 'idle' },
  error: { label: 'Errore', tone: 'ko' },
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** real run row → the "Run recenti" line shape (name/meta/stato/tone). */
function adaptRun(r: Record<string, unknown>): Run {
  const status = (str(r.status) ?? '').toLowerCase();
  const s = RUN_STATUS[status] ?? { label: str(r.status) ?? EMPTY, tone: 'muted' as const };
  const cmd = str(r.command) ?? str(r.kind) ?? 'run';
  const id = str(r.run_id) ?? str(r.id);
  const out = num(r.leads_out) ?? num(r.with_website);
  const cost = num(r.total_cost_eur);
  const dead = Array.isArray(r.provider_dead) ? (r.provider_dead as unknown[]).filter((x) => typeof x === 'string') : [];
  const metaBits: string[] = [];
  if (out !== undefined) metaBits.push(`${fmt(out)} record`);
  if (cost !== undefined) metaBits.push(fmtEur(cost));
  if (dead.length) metaBits.push(`provider ko: ${dead.join(', ')}`);
  return {
    nome: id ? `${cmd} · ${id}` : cmd,
    meta: metaBits.join(' · ') || EMPTY,
    stato: s.label,
    tone: s.tone,
  };
}

export default function Sistema() {
  const creditsAlert = CREDITS.filter((c) => c.resN <= c.soglia).length;
  const runsQ = useRuns();
  const ph = useProviderHealth();
  const cost = useCost();
  const realRuns = runsQ.data?.runs ?? [];
  const RUNS = realRuns.length ? realRuns.map(adaptRun) : RUNS_FALLBACK;
  const seedCost = cost.data?.seedRunCostEur;
  const liveCost = cost.data?.liveSessionCostEur;
  // A sum with an unmeasured part is itself unknown, never a partial number shown as the total.
  const costCumulato = typeof seedCost === 'number' && typeof liveCost === 'number' ? seedCost + liveCost : null;
  const costNote = !cost.data
    ? 'in attesa del motore'
    : costCumulato !== null
      ? 'run del seed + sessione corrente · free-first, €0 di default'
      : seedCost === null
        ? `run del seed non misurato (nessun ledger) · sessione ${fmtEur(liveCost)}`
        : 'costo della sessione non misurato';
  const deadProviders = ph.data?.providerDead ?? [];

  return (
    <PageSection>
      <PageHeader kicker="Sistema" number="05" title="Run, provider, costi, deduplica" />

      <div className="sx-mb">
        <PanelHead kicker="Credito provider a pagamento" aside={creditsAlert > 0 && <span className="sx-alert"><Icon name="alert" size={13} />{creditsAlert} da ricaricare</span>} />
      </div>
      <div className="sx-grid sx-grid--kpi sx-grid--joined" style={{ marginBottom: '2rem' }}>
        {CREDITS.map((c) => {
          const pct = Math.round((c.resN / c.totN) * 100);
          const low = c.resN <= c.soglia;
          const warn = !low && c.giorni <= 14;
          const state = low ? 'Da ricaricare' : warn ? 'In esaurimento' : 'OK';
          const tone: PillTone = low ? 'ko' : warn ? 'outline' : 'ok';
          return (
            <Card key={c.id} pad="tight" className="sx-credit">
              <div className="sx-credit__top">
                <span className="sx-cell-strong">{c.nome}</span>
                <Pill tone={tone}>{state}</Pill>
              </div>
              <span className="sx-meta">{c.piano}</span>
              <span className="sx-stat__value">
                {c.res}
                <span className="sx-stat__unit">/ {c.tot}</span>
              </span>
              <Bar value={pct} sand={low} label={`Credito residuo ${c.nome}`} />
              <span className="sx-credit__foot sx-meta">
                <span>{c.cons}</span>
                <span className="num">~{c.giorni} gg</span>
              </span>
              {/* No provider console is wired yet: the action is shown, not faked. */}
              <Button variant={low ? 'solid' : 'outline'} size="sm" block disabled title="Gestione crediti non ancora collegata">
                {low ? 'Ricarica' : 'Gestisci'}
              </Button>
            </Card>
          );
        })}
      </div>

      <div className="sx-grid sx-grid--2" style={{ alignItems: 'start' }}>
        <Card>
          <PanelHead kicker="Run recenti" aside={deadProviders.length > 0 && <span className="sx-alert"><Icon name="alert" size={13} />{deadProviders.length} provider ko</span>} />
          <div className="sx-list sx-mt">
            {RUNS.map((r) => (
              <div key={r.nome} className="sx-list__item">
                <span className="sx-list__main">
                  <span className="sx-list__title">{r.nome}</span>
                  <span className="sx-list__meta">{r.meta}</span>
                </span>
                <span className="sx-meta"><StatusDot tone={r.tone}>{r.stato}</StatusDot></span>
              </div>
            ))}
          </div>
        </Card>
        <div className="sx-stack">
          <Card>
            <PanelHead kicker="Deduplica" />
            <div className="sx-row-flex sx-mt" style={{ gap: '1.5rem' }}>
              {DEDUP.map((d) => <Stat key={d.k} boxed={false} variant="value-top" size="sm" value={d.v} label={d.k} />)}
            </div>
            <p className="sx-meta sx-mt">Impronte su P.IVA, telefono e nome. 416 possibili duplicati da rivedere.</p>
          </Card>
          <Card>
            <Stat boxed={false} variant="hero" label="Costi cumulati" value={fmtEur(costCumulato)} sub={costNote} />
          </Card>
        </div>
      </div>
    </PageSection>
  );
}
