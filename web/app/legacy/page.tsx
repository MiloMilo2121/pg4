'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api, type Company, type Metrics, type ProviderHealth, type CostView, type CellStatus, type JudgmentDetail, type AxisEval } from '../../lib/api';

const ENRICH_FIELDS = [
  { key: 'email', col: 'email_inferred', label: 'Email' },
  { key: 'pec', col: 'pec', label: 'PEC' },
  { key: 'vat', col: 'vat_code_final', label: 'P.IVA' },
  { key: 'revenue', col: 'revenue', label: 'Fatturato' },
  { key: 'employees', col: 'employees', label: 'Dipend.' },
  { key: 'instagram', col: 'instagram', label: 'Instagram' },
  { key: 'facebook', col: 'facebook', label: 'Facebook' },
  { key: 'linkedin', col: 'linkedin', label: 'LinkedIn' },
] as const;

const FILL_LABELS: Record<string, string> = {
  official_website: 'Sito ufficiale',
  phone: 'Telefono',
  email: 'Email',
  pec: 'PEC',
  vat: 'P.IVA',
  revenue: 'Fatturato (ufficiale)',
  employees: 'Dipendenti (ufficiale)',
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
};

const MAX_ENRICH = 200; // mirrors the server's ENRICH_MAX_SELECTION (footgun guard)

type CellMap = Record<string, Record<string, { status: CellStatus; value?: string; source?: string; confidence?: number }>>; // companyId → field → state

export default function Dashboard() {
  const [health, setHealth] = useState<{ ok: boolean; companies: number; seed: string } | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [providerHealth, setProviderHealth] = useState<ProviderHealth | null>(null);
  const [dedupCount, setDedupCount] = useState<number>(0);
  const [cost, setCost] = useState<CostView | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // composer
  const [category, setCategory] = useState('agenzie immobiliari');
  const [province, setProvince] = useState('PD');
  const [srcPg, setSrcPg] = useState(true);
  const [srcMaps, setSrcMaps] = useState(true);
  const [paid, setPaid] = useState(false);
  const [scrapeNote, setScrapeNote] = useState<string | null>(null);

  // table
  const [page, setPage] = useState(0);
  const [onlyWebsite, setOnlyWebsite] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cells, setCells] = useState<CellMap>({});
  // judgment layer (L2–L5): per-company verdict badge + live section state
  const [verdicts, setVerdicts] = useState<Record<string, { target?: string; quadrant?: string; running?: boolean; summary?: string }>>({});
  const pollRef = useRef<Set<string>>(new Set());
  // judgment DETAIL drawer — the full two-axis verdict the operator reads + evals.
  const [detail, setDetail] = useState<JudgmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function openJudgment(id: string) {
    setDetailLoading(true);
    setDetail({ id } as JudgmentDetail); // open immediately (skeleton)
    try {
      setDetail(await api.judgmentDetail(id));
    } catch {
      setErr('impossibile caricare il giudizio — riprova');
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }
  const PAGE_SIZE = 50;

  const loadAll = useCallback(async () => {
    try {
      const [h, c, m, ph, dr, co] = await Promise.all([
        api.health(),
        api.companies(2000),
        api.metrics(),
        api.providerHealth(),
        api.dedupReview(),
        api.cost(),
      ]);
      setHealth(h);
      setCompanies(c.rows);
      setMetrics(m);
      setProviderHealth(ph);
      setDedupCount(dr.candidates.length);
      setCost(co);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message + ' — è acceso il server API? (pnpm run serve)');
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const filtered = useMemo(() => {
    let rows = companies;
    if (onlyWebsite) rows = rows.filter((r) => r.official_website);
    if (filterText.trim()) {
      const q = filterText.toLowerCase();
      rows = rows.filter((r) => (r.company_name ?? '').toLowerCase().includes(q) || (r.city ?? '').toLowerCase().includes(q));
    }
    return rows;
  }, [companies, onlyWebsite, filterText]);

  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const pageIds = pageRows.map((r) => r.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAllPage() {
    setSelected((s) => {
      const n = new Set(s);
      if (allPageSelected) pageIds.forEach((id) => n.delete(id));
      else pageIds.forEach((id) => n.add(id));
      return n;
    });
  }

  // ---- live enrich: POST then poll the job, streaming cell states in ----
  async function enrich(fieldKey: string) {
    const ids = [...selected];
    if (!ids.length) return;
    // optimistic: mark queued
    setCells((prev) => {
      const n = { ...prev };
      for (const id of ids) n[id] = { ...(n[id] ?? {}), [fieldKey]: { status: 'queued' } };
      return n;
    });
    try {
      const { jobId } = await api.enrich(ids, [fieldKey]);
      setErr(null);
      pollRef.current.add(jobId);
      pollJob(jobId);
    } catch (e) {
      setErr((e as Error).message);
      // roll back the optimistic "queued" cells so they don't hang
      setCells((prev) => {
        const n = { ...prev };
        for (const id of ids) if (n[id]) delete n[id][fieldKey];
        return n;
      });
    }
  }

  async function pollJob(jobId: string) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      let job;
      try {
        job = await api.job(jobId);
      } catch {
        setErr('connessione al server persa durante l’arricchimento — riprova');
        break;
      }
      setCells((prev) => {
        const n = { ...prev };
        for (const it of job.items) {
          for (const [f, st] of Object.entries(it.cells)) {
            n[it.companyId] = { ...(n[it.companyId] ?? {}), [f]: { status: st.status, value: st.value, source: st.source, confidence: st.confidence } };
          }
        }
        return n;
      });
      // F0 — a failed/timed-out job surfaces its error instead of a frozen spinner.
      if (job.status === 'error') {
        setErr(job.error ?? 'enrich job failed');
        break;
      }
      // write filled values into the row data so fill-rates + cells persist
      setCompanies((prev) => {
        const byId = new Map(prev.map((r) => [r.id, r]));
        let changed = false;
        for (const it of job.items) {
          const row = byId.get(it.companyId);
          if (!row) continue;
          for (const [f, st] of Object.entries(it.cells)) {
            if (st.status === 'filled' && st.value) {
              const col = ENRICH_FIELDS.find((x) => x.key === f)?.col;
              if (col && !row[col]) {
                (row as Record<string, unknown>)[col] = st.value;
                changed = true;
              }
            }
          }
        }
        return changed ? [...prev] : prev;
      });
      if (job.status === 'done') break;
    }
    pollRef.current.delete(jobId);
    // refresh metrics so fill-rate bars climb after a live enrich
    api.metrics().then(setMetrics).catch(() => {});
  }

  // ---- judgment layer (L2–L5): one button per layer, polled per-section ----
  async function judgmentAction(kind: 'discovery' | 'collect_signals' | 'judge' | 'validate_export') {
    const ids = [...selected];
    if (!ids.length) return;
    setVerdicts((prev) => {
      const n = { ...prev };
      for (const id of ids) n[id] = { ...(n[id] ?? {}), running: true };
      return n;
    });
    try {
      const fn = kind === 'discovery' ? api.discovery : kind === 'collect_signals' ? api.collectSignals : kind === 'judge' ? api.judge : api.validateExport;
      const { jobId } = await fn(ids);
      setErr(null);
      pollJudgment(jobId);
    } catch (e) {
      setErr((e as Error).message);
      setVerdicts((prev) => {
        const n = { ...prev };
        for (const id of ids) if (n[id]) n[id].running = false;
        return n;
      });
    }
  }

  async function pollJudgment(jobId: string) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      let job;
      try {
        job = await api.judgmentJob(jobId);
      } catch {
        setErr('connessione al server persa durante il giudizio — riprova');
        break;
      }
      setVerdicts((prev) => {
        const n = { ...prev };
        for (const it of job.items) {
          const cur = { ...(n[it.companyId] ?? {}) };
          const v = it.sections['verdetto_gap'];
          if (v?.summary) {
            cur.summary = v.summary;
            cur.target = v.summary.match(/target=(\w+)/)?.[1];
            cur.quadrant = v.summary.match(/(A[+\-?]B[+\-?])/)?.[1];
          }
          cur.running = Object.values(it.sections).some((s) => s.state === 'running' || s.state === 'queued');
          n[it.companyId] = cur;
        }
        return n;
      });
      if (job.status === 'error') {
        setErr(job.error ?? 'judgment job failed');
        break;
      }
      if (job.status === 'done') break;
    }
    api.cost().then(setCost).catch(() => {});
  }

  async function submitIntent() {
    setScrapeNote('Avvio…');
    try {
      const r = await api.scrape({ category, province, sources: [srcPg && 'pg', srcMaps && 'maps'].filter(Boolean), paidEnabled: paid });
      setScrapeNote(r.note);
    } catch (e) {
      setScrapeNote((e as Error).message);
    }
  }

  function cellOf(id: string, fieldKey: string, col: string, row: Company) {
    const st = cells[id]?.[fieldKey];
    // P.IVA column falls back to the input vat_code so a revenue sourced from
    // the input VAT (no website → no enriched vat_code_final) still shows the
    // VAT it was keyed on — revenue is never "without a P.IVA".
    const existing = (fieldKey === 'vat' ? (row.vat_code_final ?? (row as Record<string, unknown>).vat_code) : row[col]) as string | undefined;
    if (st?.status === 'running' || st?.status === 'queued')
      return (
        <span className={`cell ${st.status}`}>
          {st.status === 'running' ? <span className="spinner" /> : null}
          {st.status === 'running' ? 'cerco…' : 'in coda'}
        </span>
      );
    if (st?.status === 'failed') return <span className="cell failed" title={st.value}>errore</span>;
    if (st?.status === 'filled' || existing) {
      // evidence-lite: hover shows provenance + confidence (the A.3 drill-down:
      // WHERE the value came from and HOW trustworthy). A footer mailto ≠ a
      // pattern guess; a site VAT ≠ a vies-unconfirmed input VAT.
      const conf = typeof st?.confidence === 'number' ? ` · conf ${(st.confidence * 100).toFixed(0)}%` : '';
      const evidence = st?.source ? `fonte: ${st.source}${conf}` : 'da dati seed';
      return <span className={`cell filled ${st?.status === 'filled' ? 'justfilled' : ''}`} title={evidence}>{(st?.value ?? existing) as string}</span>;
    }
    if (st?.status === 'not_found') return <span className="cell not_found">—</span>;
    return <span className="cell empty">·</span>;
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <h1>pg4 <span className="serif" style={{ color: 'var(--accent-2)' }}>intelligence</span></h1>
          <span className="tag">company-intelligence · tenant dev · dati reali free-gold</span>
        </div>
        <div className="right">
          <span><span className={`dot ${health?.ok ? 'ok' : ''}`} />{health ? `${metrics?.total ?? companies.length} aziende` : 'connessione…'}</span>
          <span className="num">costo sessione: €{(cost?.liveSessionCostEur ?? 0).toFixed(3)}</span>
        </div>
      </div>

      {err && <div className="banner" style={{ background: 'oklch(0.72 0.18 25 / 0.14)', borderColor: 'var(--bad)' }}>⚠ {err}</div>}

      <div className="grid">
        {/* ---- left: composer + metrics ---- */}
        <div className="stack">
          <div className="panel">
            <div className="hd">Nuova ricerca</div>
            <div className="bd">
              <div className="field">
                <label>Categoria</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="agenzie immobiliari">agenzie immobiliari (validata)</option>
                  <option value="__other" disabled>altre categorie → lavoro backend, non promessa UI</option>
                </select>
                <div className="hint">Solo le categorie validate hanno copertura piena. Le altre richiedono un giro di calibrazione backend.</div>
              </div>
              <div className="field">
                <label>Provincia</label>
                <select value={province} onChange={(e) => setProvince(e.target.value)}>
                  {['PD', 'VR', 'VE', 'VI', 'TV', 'RO', 'BL', 'BS', 'MN', 'MI', 'TO', 'RM'].map((p) => (
                    <option key={p} value={p}>{p} (curata)</option>
                  ))}
                </select>
                <div className="hint">Province curate in italy_geo: copertura comuni verificata.</div>
              </div>
              <div className="field">
                <label>Fonti</label>
                <div className="toggles">
                  <span className={`toggle ${srcPg ? 'on' : ''}`} onClick={() => setSrcPg((v) => !v)}>PagineGialle</span>
                  <span className={`toggle ${srcMaps ? 'on' : ''}`} onClick={() => setSrcMaps((v) => !v)}>Maps</span>
                  <span className="toggle off-paid" style={{ cursor: 'not-allowed', opacity: 0.5 }}>Registro (prossima fase)</span>
                </div>
                {srcMaps && <div className="hint warn">Maps: il conteggio oscilla run-su-run (misurato 6×). In dashboard è mostrato come “≥ N”, un minimo, mai un dato secco.</div>}
              </div>
              <div className="field">
                <label>Tetto costo (€/run) · provider a pagamento</label>
                <div className="row2">
                  <input type="number" defaultValue={0.02} step={0.01} min={0} />
                  <span className={`toggle ${paid ? 'on' : 'off-paid'}`} onClick={() => setPaid((v) => !v)} style={{ textAlign: 'center' }}>
                    paid: {paid ? 'ON' : 'OFF'}
                  </span>
                </div>
                <div className="hint">I provider a pagamento sono disabilitati in questa build (free-gold a €0). Il tetto è già provato dal vivo (€0,019 ≤ €0,02).</div>
              </div>
              <button className="primary" onClick={submitIntent}>Avvia ricerca free-gold</button>
              {scrapeNote && <div className="hint" style={{ marginTop: 10 }}>{scrapeNote}</div>}
            </div>
          </div>

          {/* fill rates */}
          <div className="panel">
            <div className="hd">Copertura campi <span className="num muted">{metrics?.total ?? 0} righe</span></div>
            <div className="bd">
              {metrics ? (
                Object.entries(metrics.fillRates).map(([k, v]) => (
                  <div className="fillrow" key={k}>
                    <div className="top"><span>{FILL_LABELS[k] ?? k}</span><span className="pct num">{v}%</span></div>
                    <div className="bar"><i style={{ width: `${v}%` }} /></div>
                  </div>
                ))
              ) : <div className="muted">…</div>}
              <div className="hint" style={{ marginTop: 10 }}>
                I dati partono dallo stato “before” reale (sito+telefono). Seleziona righe e arricchisci email/P.IVA/social: il free-gold rilegge i siti veri e le barre salgono.
              </div>
            </div>
          </div>

          {/* provider health */}
          <div className="panel">
            <div className="hd">Salute provider</div>
            <div className="bd">
              {providerHealth?.providerDead.length ? (
                <>
                  {providerHealth.providerDead.map((d) => (
                    <div className="health-item" key={d.provider}>
                      <span className="pill bad">0% · morto</span>
                      <b>{d.provider}</b>
                      <span className="muted num">{d.calls} chiamate, tutte {d.dominant_kind}</span>
                    </div>
                  ))}
                  <div className="hint">Segnalati, non nascosti — è la classe dns_mx/crtsh che restava silenziosa per mesi.</div>
                </>
              ) : (
                <div className="health-item"><span className="pill ok">tutti sani</span></div>
              )}
            </div>
          </div>

          {/* sources + dedup + cost */}
          <div className="panel">
            <div className="hd">Provenienza & qualità</div>
            <div className="bd">
              {metrics && Object.entries(metrics.sources).map(([s, n]) => (
                <div className="metric" key={s}><span className="k">{s}</span><span className="v num">{n}</span></div>
              ))}
              <div className="metric"><span className="k">coda dedup-review</span><span className="v num">{dedupCount}</span></div>
              <div className="metric"><span className="k">lead (Maps band)</span><span className="v num">{metrics?.mapsBand.display}</span></div>
              <div className="metric"><span className="k">costo run seed</span><span className="v num">€{(cost?.seedRunCostEur ?? 0).toFixed(3)}</span></div>
            </div>
          </div>
        </div>

        {/* ---- right: the reactive table ---- */}
        <div className="panel">
          <div className="toolbar">
            <span className="sel">
              {selected.size ? `${selected.size} selezionate` : `${filtered.length} aziende`}
              {selected.size > MAX_ENRICH && <span className="hint warn" style={{ marginLeft: 8 }}>max {MAX_ENRICH} per arricchimento</span>}
            </span>
            <input type="text" placeholder="filtra per nome o città…" value={filterText} onChange={(e) => { setFilterText(e.target.value); setPage(0); }} style={{ width: 200 }} />
            <span className={`toggle ${onlyWebsite ? 'on' : ''}`} onClick={() => { setOnlyWebsite((v) => !v); setPage(0); }}>solo con sito</span>
            {ENRICH_FIELDS.map((f) => (
              <button key={f.key} className="ebtn" disabled={!selected.size || selected.size > MAX_ENRICH} onClick={() => enrich(f.key)} title={`Arricchisci ${f.label} sulle selezionate (€0)`}>
                + {f.label}
              </button>
            ))}
            <span className="sel" style={{ marginLeft: 8, opacity: 0.7 }}>· giudizio:</span>
            {([
              ['discovery', 'L2 Discovery'],
              ['collect_signals', 'L3 Segnali A/B'],
              ['judge', 'L4 Giudizio'],
              ['validate_export', 'L5 Validazione'],
            ] as const).map(([kind, label]) => (
              <button key={kind} className="ebtn" disabled={!selected.size || selected.size > MAX_ENRICH} onClick={() => judgmentAction(kind)} title={`${label} sulle aziende selezionate — layer indipendente, idempotente, cumulativo`}>
                {label}
              </button>
            ))}
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 30 }}><input type="checkbox" checked={allPageSelected} onChange={toggleAllPage} /></th>
                  <th>Azienda</th>
                  <th>Telefono</th>
                  <th>Sito</th>
                  <th>Verdetto</th>
                  {ENRICH_FIELDS.map((f) => <th key={f.key}>{f.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.id} className={selected.has(r.id) ? 'selected' : ''}>
                    <td><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                    <td className="name">{r.company_name}<div className="sub">{r.city}{r.province ? ` (${r.province})` : ''} · {r.category}</div></td>
                    <td className="num">{r.phone ?? <span className="muted">—</span>}</td>
                    <td>{r.official_website ? <a href={r.official_website as string} target="_blank" rel="noreferrer">{hostOf(r.official_website as string)}</a> : <span className="muted">—</span>}</td>
                    <td onClick={() => openJudgment(r.id)} style={{ cursor: 'pointer' }} title="apri il giudizio completo (A/B, quadrante, leve)">{verdictCell(verdicts[r.id])}</td>
                    {ENRICH_FIELDS.map((f) => <td key={f.key}>{cellOf(r.id, f.key, f.col, r)}</td>)}
                  </tr>
                ))}
                {pageRows.length === 0 && (
                  <tr><td colSpan={5 + ENRICH_FIELDS.length}><div className="empty-state">Nessuna azienda con questi filtri.</div></td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span>pagina {page + 1} / {Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}</span>
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹ prec</button>
            <button disabled={(page + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage((p) => p + 1)}>succ ›</button>
          </div>
        </div>
      </div>
      {detail && <JudgmentDrawer detail={detail} loading={detailLoading} onClose={() => setDetail(null)} />}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function verdictCell(v?: { target?: string; quadrant?: string; running?: boolean; summary?: string }) {
  if (!v) return <span className="cell empty">·</span>;
  if (v.running && !v.target) return <span className="cell running"><span className="spinner" /> giudico…</span>;
  if (!v.target) return <span className="cell empty">·</span>;
  const color = v.target === 'yes' ? 'var(--good, #16a34a)' : v.target === 'borderline' ? 'var(--accent-2, #d97706)' : 'var(--muted, #888)';
  return (
    <span className="cell filled" title={v.summary} style={{ color, fontWeight: 600 }}>
      {v.target === 'yes' ? '★ target' : v.target === 'borderline' ? '~ borderline' : '— no'}
      {v.quadrant ? <span className="muted" style={{ marginLeft: 6, fontWeight: 400 }}>{v.quadrant}</span> : null}
    </span>
  );
}

function levelColor(level?: string): string {
  return level === 'high' ? 'var(--good, #16a34a)' : level === 'mid' ? 'var(--accent-2, #d97706)' : level === 'low' ? 'var(--bad, #dc2626)' : 'var(--muted, #888)';
}

function AxisCard({ title, e }: { title: string; e: AxisEval | null }) {
  return (
    <div style={{ padding: '10px 12px', border: '1px solid var(--border, #2a2d36)', borderRadius: 10 }}>
      <div className="muted" style={{ fontSize: 12 }}>{title}</div>
      {e ? (
        <>
          <div style={{ fontSize: 16, fontWeight: 700, color: levelColor(e.level) }}>{(e.level ?? 'unknown').toUpperCase()}{e.score != null ? ` · ${e.score.toFixed(2)}` : ''}</div>
          {e.rationale && <div style={{ fontSize: 13, marginTop: 4, lineHeight: 1.45 }}>{e.rationale}</div>}
          {e.signalsPresent != null && e.signalsConsidered != null && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>segnali {e.signalsPresent}/{e.signalsConsidered}</div>}
        </>
      ) : <div className="muted">non misurato</div>}
    </div>
  );
}

/** The judgment view — the screen the operator reads + evals the real verdict from. */
function JudgmentDrawer({ detail, loading, onClose }: { detail: JudgmentDetail; loading: boolean; onClose: () => void }) {
  const v = detail.verdetto_gap;
  const judged = !!v;
  const tColor = v?.target === 'yes' ? 'var(--good, #16a34a)' : v?.target === 'borderline' ? 'var(--accent-2, #d97706)' : 'var(--muted, #888)';
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'oklch(0 0 0 / 0.45)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <aside onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px, 92vw)', height: '100%', overflowY: 'auto', background: 'var(--panel, #14161c)', borderLeft: '1px solid var(--border, #2a2d36)', padding: '20px 22px', boxShadow: '-20px 0 60px oklch(0 0 0 / 0.4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{detail.company_name ?? '…'}</div>
            <div className="muted" style={{ fontSize: 13 }}>{detail.category}{detail.official_website ? ` · ${hostOf(detail.official_website)}` : ''}</div>
          </div>
          <button className="ebtn" onClick={onClose}>✕</button>
        </div>
        {loading && <div className="muted" style={{ marginTop: 16 }}><span className="spinner" /> carico il giudizio…</div>}
        {!loading && !judged && (
          <div className="empty-state" style={{ marginTop: 18 }}>Non ancora giudicata. Selezionala e premi <b>L4 Giudizio</b> per generare il verdetto a due assi.</div>
        )}
        {!loading && judged && (
          <>
            <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: tColor }}>{v!.target === 'yes' ? '★ TARGET' : v!.target === 'borderline' ? '~ BORDERLINE' : '— NO'}</span>
              <span style={{ fontFamily: 'monospace', fontSize: 18, padding: '2px 10px', border: '1px solid var(--border, #2a2d36)', borderRadius: 8 }}>{v!.quadrant}</span>
              {v!.confidence != null && <span className="muted">conf {Math.round(v!.confidence * 100)}%</span>}
            </div>
            {v!.motivation && <p style={{ marginTop: 12, lineHeight: 1.5 }}>{v!.motivation}</p>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
              <AxisCard title="Asse A — forza intrinseca" e={detail.valutazione_a} />
              <AxisCard title="Asse B — espressione digitale" e={detail.valutazione_b} />
            </div>
            <div className="muted" style={{ marginTop: 14, fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
              {v!.gapWidth && <span>gap: <b>{v!.gapWidth}</b></span>}
              {v!.trajectory && <span>traiettoria: <b>{v!.trajectory}</b></span>}
              {v!.cause && <span>causa: <b>{v!.cause}</b></span>}
              {v!.businessModel && <span>modello: <b>{v!.businessModel}</b></span>}
              {detail.contesto_categoria?.provisional && <span style={{ color: 'var(--accent-2, #d97706)' }}>benchmark §17 provvisorio (coorte sottile)</span>}
            </div>
            {detail.leva && detail.leva.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Leve (il gap aggredibile)</div>
                {detail.leva.map((l, i) => (
                  <div key={i} style={{ padding: '8px 10px', border: '1px solid var(--border, #2a2d36)', borderRadius: 8, marginBottom: 6 }}>
                    <div style={{ fontWeight: 600 }}>{l.kind}</div>
                    {(l.rationale || l.description) && <div className="muted" style={{ fontSize: 13 }}>{l.rationale || l.description}</div>}
                  </div>
                ))}
              </div>
            )}
            <div className="muted" style={{ marginTop: 18, fontSize: 12 }}>Questo è il giudizio reale: leggilo e dammi le eval (A giusto? B giusto? quadrante? target?). Le tue correzioni diventano golden (L5b).</div>
          </>
        )}
      </aside>
    </div>
  );
}
