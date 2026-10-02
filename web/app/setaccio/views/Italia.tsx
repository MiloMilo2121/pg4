import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { SVGID, type ItMode, type Region } from '../data';
import { useRegionsCoverage, useProvincesCoverage, useComuniCoverage, useCompanies, useMetrics, useMarkets, useTotal } from '../queries';
import { ITALY_REGIONS, VENETO_PROVINCES } from '../geo';
import { fmt, modeVal, fillFor, isDarkFill, EMPTY } from '../helpers';
import type { ViewProps } from '../ctx';
import { Kicker } from '../../ds/components/Kicker';
import { Button } from '../../ds/components/Button';
import { Stat } from '../ui/Stat';
import { Bars, type BarRow } from '../ui/Bar';
import { cx } from '../../ds/components/cx';

const MODES: [ItMode, string][] = [
  ['copertura', 'Copertura'], ['profondita', 'Profondità'], ['settori', 'Settori'],
  ['fatturato', 'Fatturato'], ['target', 'Target'], ['recenza', 'Recenza'], ['opportunita', 'Opportunità'],
];

/**
 * Animated count-up for the tooltip figure (cubic ease-out over 420ms). Local to
 * the map so a hover re-renders the tooltip, not the whole dashboard. Under
 * reduced motion it shows the final value at once.
 */
function useCountUp(target: number): number {
  const [n, setN] = useState(target);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      raf.current = requestAnimationFrame(() => setN(target));
      return () => { if (raf.current) cancelAnimationFrame(raf.current); };
    }
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 420);
      setN(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [target]);
  return n;
}

/** Enter / Space activate a focusable map shape, like a button. */
function onActivate(fn?: () => void) {
  return fn
    ? (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fn();
        }
      }
    : undefined;
}

/** centroid of an absolute-coord svg path (used for province labels). */
function centroid(path: string): [number, number] {
  const nums = (path.match(/[\d.]+/g) || []).map(Number);
  let xmin = 1e9, xmax = -1e9, ymin = 1e9, ymax = -1e9;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i], y = nums[i + 1];
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  return [(xmin + xmax) / 2, (ymin + ymax) / 2];
}

const pct = (rows: [string, number][]): BarRow[] => rows.map(([k, v]) => ({ k, v: v + '%', w: v }));

export default function Italia({ st, set }: Pick<ViewProps, 'st' | 'set'>) {
  const REGIONS = useRegionsCoverage();
  const PROVINCES = useProvincesCoverage();
  const comuni = useComuniCoverage('PD');
  const { raw } = useCompanies();
  const metrics = useMetrics();
  const markets = useMarkets();
  const total = useTotal();
  const modeLabel = (MODES.find((m) => m[0] === st.itMode) || ['', ''])[1];

  // ---- NAZIONE: real region outlines ----
  const bySvg: Record<string, Region> = {};
  REGIONS.forEach((r) => { bySvg[SVGID[r.id]] = r; });

  // ---- detail panel ----
  let detail: {
    kicker: string;
    title: string;
    kpis: { k: string; v: string }[];
    bars: BarRow[];
    actions: { label: string; primary?: boolean; onClick: () => void }[];
  };
  const fill = metrics.data?.fillRates ?? {};
  const byAz = <T extends { az: number }>(xs: T[]) => [...xs].sort((x, y) => y.az - x.az);
  if (st.itLevel === 'nazione') {
    const active = REGIONS.filter((r) => r.az > 0);
    detail = {
      kicker: 'Italia', title: 'Patrimonio nazionale',
      kpis: [
        { k: 'Aziende', v: fmt(total) }, { k: 'Regioni attive', v: String(active.length) },
        { k: 'Province', v: String(active.reduce((s, r) => s + r.prov, 0)) }, { k: 'Mercati', v: String(markets.length) },
        { k: 'Con fatturato', v: Math.round(fill.revenue ?? 0) + '%' }, { k: 'Con sito', v: fmt(metrics.data?.withWebsite ?? 0) },
      ],
      bars: pct(byAz(active).slice(0, 5).map((r) => [r.name, r.cov])),
      actions: [
        { label: 'Mappa nuovo territorio', primary: true, onClick: () => set({ wizardOpen: true, wStep: 0 }) },
        { label: 'Apri il Veneto', onClick: () => set({ itLevel: 'regione', hover: null }) },
      ],
    };
  } else if (st.itLevel === 'regione') {
    const ven = REGIONS.find((r) => r.id === 'ven');
    detail = {
      kicker: 'Regione', title: 'Veneto',
      kpis: [
        { k: 'Aziende', v: fmt(ven?.az ?? 0) }, { k: 'Province', v: String(ven?.prov ?? 0) },
        { k: 'Mercati', v: String(ven?.mercati ?? 0) }, { k: 'Con sito', v: fmt(PROVINCES.reduce((s, p) => s + p.target, 0)) },
        { k: 'Copertura', v: (ven?.cov ?? 0) + '%' }, { k: 'Top provincia', v: byAz(PROVINCES)[0]?.name ?? EMPTY },
      ],
      bars: pct(byAz(PROVINCES).slice(0, 5).map((p) => [p.name, p.cov])),
      actions: [
        { label: 'Confronta province', primary: true, onClick: () => set({ nav: 'analytics', anTab: 'geografica' }) },
        { label: 'Apri Padova', onClick: () => set({ itLevel: 'provincia', hover: null }) },
      ],
    };
  } else {
    const pd = PROVINCES.find((p) => p.id === 'pd');
    const rows = raw.filter((c) => String(c.province ?? '').toUpperCase() === 'PD');
    const share = (f: string) => (rows.length ? Math.round((100 * rows.filter((c) => c[f]).length) / rows.length) : 0);
    detail = {
      kicker: 'Provincia', title: 'Padova',
      kpis: [
        { k: 'Aziende', v: fmt(pd?.az ?? 0) }, { k: 'Comuni', v: String(comuni.filter((c) => c.az > 0).length) },
        { k: 'Con fatt.', v: share('revenue') + '%' }, { k: 'Con sito', v: fmt(pd?.target ?? 0) },
        { k: 'Target rate', v: pd?.tr ?? EMPTY }, { k: 'Costo/tgt', v: pd?.ct ?? EMPTY },
      ],
      bars: pct([['Sito', share('official_website')], ['Fatturato', share('revenue')], ['Email', share('email_inferred')], ['PEC', share('pec')], ['P.IVA', share('vat_code_final')]]),
      actions: [
        { label: 'Apri aziende', primary: true, onClick: () => set({ nav: 'aziende' }) },
        { label: 'Raffina selezione', onClick: () => set({ nav: 'raff', raffTab: 'imbuto' }) },
      ],
    };
  }

  // ---- tooltip ----
  let tip: { name: string; az: number; rows: { k: string; v: string }[] } | null = null;
  if (st.hover) {
    if (st.hover.startsWith('prov:')) {
      const p = PROVINCES.find((x) => 'prov:' + x.id === st.hover);
      if (p) tip = { name: p.name, az: p.az, rows: [{ k: 'Target', v: fmt(p.target) }, { k: 'Target rate', v: p.tr }, { k: 'Costo/target', v: p.ct }] };
    } else if (st.hover.startsWith('com:')) {
      const c = comuni.find((x) => 'com:' + x.name === st.hover);
      if (c) tip = { name: c.name, az: c.az, rows: [{ k: 'Con sito', v: fmt(c.withSite) }, { k: 'Settore principale', v: c.topCategory }] };
    } else if (st.hover.startsWith('reg:')) {
      const r = REGIONS.find((x) => 'reg:' + x.id === st.hover);
      if (r) tip = { name: r.name, az: r.az, rows: [{ k: 'Province coperte', v: String(r.prov) }, { k: 'Mercati mappati', v: String(r.mercati) }, { k: 'Copertura', v: r.cov + '%' }] };
    }
  }
  const tipCount = useCountUp(tip?.az ?? 0);

  const maxC = Math.max(1, ...comuni.map((c) => c.az));
  const hoverOn = (key: string) => () => set({ hover: key });
  const hoverOff = () => set({ hover: null });

  return (
    <section className="sx-italia sx-enter">
      {/* left mode panel */}
      <div className="sx-italia__modes">
        <Kicker>Modalità mappa</Kicker>
        <div className="sx-modes" role="group" aria-label="Metrica della mappa">
          {MODES.map(([id, label]) => (
            <button key={id} type="button" className="sx-mode" aria-pressed={st.itMode === id} onClick={() => set({ itMode: id })}>{label}</button>
          ))}
        </div>
        <div className="sx-italia__legend">
          <Kicker muted>Legenda</Kicker>
          <div className="sx-legend" aria-hidden="true" />
          <div className="sx-legend__ends sx-meta"><span>vuoto</span><span>pieno</span></div>
          <p className="sx-meta" style={{ marginTop: '1rem', lineHeight: 1.5 }}>
            Ogni area è colorata per intensità della metrica scelta. Passa il mouse o usa Tab per i dettagli; Invio sul Veneto per scendere alle province.
          </p>
        </div>
      </div>

      {/* map stage */}
      <div className="sx-italia__map">
        <nav className="sx-italia__bar" aria-label="Livello mappa">
          <button type="button" className="sx-crumbbtn" aria-current={st.itLevel === 'nazione' ? 'location' : undefined} onClick={() => set({ itLevel: 'nazione', hover: null })}>Italia</button>
          {st.itLevel !== 'nazione' && (
            <>
              <span aria-hidden="true" className="sx-meta">→</span>
              <button type="button" className="sx-crumbbtn" aria-current={st.itLevel === 'regione' ? 'location' : undefined} onClick={() => set({ itLevel: 'regione', hover: null })}>Veneto</button>
            </>
          )}
          {st.itLevel === 'provincia' && (
            <>
              <span aria-hidden="true" className="sx-meta">→</span>
              <span className="sx-crumbbtn" aria-current="location">Padova</span>
            </>
          )}
          <span className="kicker kicker--muted" style={{ marginLeft: 'auto' }}>{modeLabel}</span>
        </nav>

        <div className="sx-italia__canvas">
          {/* NAZIONE */}
          {st.itLevel === 'nazione' && (
            <svg viewBox="0 0 610 793" className="sx-enter" style={{ maxHeight: 600 }} role="group" aria-label={`Italia per regione, metrica ${modeLabel}`}>
              {ITALY_REGIONS.locations.map((loc) => {
                const r = bySvg[loc.id];
                const v = r ? modeVal(r, st.itMode) : 0;
                const hovered = r && st.hover === 'reg:' + r.id;
                const open = r && r.id === 'ven' ? () => set({ itLevel: 'regione', hover: null }) : undefined;
                return (
                  <path
                    key={loc.id}
                    d={loc.path}
                    fill={fillFor(v)}
                    stroke={hovered ? 'var(--accent-2)' : open ? 'var(--accent)' : 'rgba(var(--accent-rgb),0.2)'}
                    strokeWidth={hovered ? 2.4 : open ? 1.6 : 0.8}
                    className={cx('sx-region', open && 'sx-region--link')}
                    tabIndex={r ? 0 : undefined}
                    role={r ? (open ? 'button' : 'img') : undefined}
                    aria-label={r ? `${r.name}: ${fmt(r.az)} aziende, ${modeLabel.toLowerCase()} ${v}%${open ? ', apri le province' : ''}` : undefined}
                    onMouseEnter={r ? hoverOn('reg:' + r.id) : undefined}
                    onFocus={r ? hoverOn('reg:' + r.id) : undefined}
                    onMouseLeave={hoverOff}
                    onBlur={hoverOff}
                    onClick={open}
                    onKeyDown={onActivate(open)}
                  />
                );
              })}
            </svg>
          )}

          {/* REGIONE: Veneto provinces */}
          {st.itLevel === 'regione' && (
            <svg viewBox="0 0 600 463" className="sx-enter" style={{ maxHeight: 520 }} role="group" aria-label={`Veneto per provincia, metrica ${modeLabel}`}>
              {VENETO_PROVINCES.locations.map((loc) => {
                const p = PROVINCES.find((x) => x.id === loc.id);
                const v = p ? modeVal({ cov: p.cov }, st.itMode) : 0;
                const hovered = p && st.hover === 'prov:' + p.id;
                const open = p && p.id === 'pd' ? () => set({ itLevel: 'provincia', hover: null }) : undefined;
                return (
                  <path
                    key={loc.id}
                    d={loc.path}
                    fill={fillFor(v)}
                    stroke={hovered ? 'var(--accent-2)' : open ? 'var(--accent)' : 'rgba(var(--accent-rgb),0.2)'}
                    strokeWidth={hovered ? 2.4 : open ? 1.8 : 0.9}
                    className={cx('sx-region', open && 'sx-region--link')}
                    tabIndex={p ? 0 : undefined}
                    role={p ? (open ? 'button' : 'img') : undefined}
                    aria-label={p ? `${p.name}: ${fmt(p.az)} aziende, ${modeLabel.toLowerCase()} ${v}%${open ? ', apri i comuni' : ''}` : undefined}
                    onMouseEnter={p ? hoverOn('prov:' + p.id) : undefined}
                    onFocus={p ? hoverOn('prov:' + p.id) : undefined}
                    onMouseLeave={hoverOff}
                    onBlur={hoverOff}
                    onClick={open}
                    onKeyDown={onActivate(open)}
                  />
                );
              })}
              {VENETO_PROVINCES.locations.map((loc) => {
                const p = PROVINCES.find((x) => x.id === loc.id);
                const [lx, ly] = centroid(loc.path);
                const v = p ? modeVal({ cov: p.cov }, st.itMode) : 0;
                return (
                  <text key={'t' + loc.id} x={lx} y={ly} textAnchor="middle" aria-hidden="true" className={cx('sx-map-label', isDarkFill(v) ? 'sx-map-label--light' : 'sx-map-label--dark')}>
                    {p ? p.name : loc.name}
                  </text>
                );
              })}
            </svg>
          )}

          {/* PROVINCIA: Padova comuni */}
          {st.itLevel === 'provincia' && (
            <svg viewBox="0 0 460 420" className="sx-enter" style={{ maxHeight: 480 }} role="group" aria-label="Comuni della provincia di Padova">
              {comuni.map((c) => {
                const r = 10 + (c.az / maxC) * 18;
                return (
                  <g
                    key={c.name}
                    className="sx-region"
                    tabIndex={0}
                    role="img"
                    aria-label={`${c.name}: ${fmt(c.az)} aziende`}
                    onMouseEnter={hoverOn('com:' + c.name)}
                    onFocus={hoverOn('com:' + c.name)}
                    onMouseLeave={hoverOff}
                    onBlur={hoverOff}
                  >
                    <circle cx={c.x} cy={c.y} r={r} fill={`rgba(var(--accent-rgb),${(0.18 + (c.az / maxC) * 0.5).toFixed(2)})`} stroke="var(--accent)" strokeWidth="1.4" />
                    <text x={c.x} y={c.y - r - 6} textAnchor="middle" className="sx-map-label sx-map-label--dark" style={{ fontSize: 11 }}>{c.name}</text>
                  </g>
                );
              })}
            </svg>
          )}

          {/* tooltip */}
          {tip && (
            <div className="sx-tooltip sx-enter" role="status" aria-live="polite">
              <div className="sx-tooltip__name">{tip.name}</div>
              <span className="sx-stat__value" style={{ fontSize: 'var(--fs-ui-2xl)' }}>{fmt(tipCount)}</span>
              <span className="sx-meta" style={{ display: 'block', marginBottom: '0.6rem' }}>aziende acquisite</span>
              <div className="sx-dl sx-list">
                {tip.rows.map((t) => (
                  <div key={t.k} className="sx-dl__row" style={{ paddingTop: '0.3rem' }}>
                    <span className="sx-dl__k">{t.k}</span>
                    <span className="sx-dl__v num">{t.v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* right detail panel */}
      <aside className="sx-italia__detail" aria-labelledby="sx-italia-detail-title">
        <Kicker>{detail.kicker}</Kicker>
        <h2 id="sx-italia-detail-title" className="sx-panel-title">{detail.title}</h2>
        <div className="sx-grid sx-grid--joined" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: '1.25rem' }}>
          {detail.kpis.map((k) => <Stat key={k.k} variant="value-top" size="sm" value={k.v} label={k.k} />)}
        </div>
        <Kicker muted>Maturità dati</Kicker>
        <div style={{ margin: '0.75rem 0 1.4rem' }}>
          <Bars rows={detail.bars} size="thin" />
        </div>
        <div className="sx-stack" style={{ gap: '0.5rem' }}>
          {detail.actions.map((a) => (
            <Button key={a.label} variant={a.primary ? 'solid' : 'outline'} glyph={a.primary ? undefined : '→'} block onClick={a.onClick}>{a.label}</Button>
          ))}
        </div>
      </aside>
    </section>
  );
}
