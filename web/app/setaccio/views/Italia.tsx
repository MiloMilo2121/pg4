import type { CSSProperties } from 'react';
import { COMUNI, SVGID, type ItMode, type Region } from '../data';
import { useRegionsCoverage, useProvincesCoverage, useTotal } from '../queries';
import { ITALY_REGIONS, VENETO_PROVINCES } from '../geo';
import { fmt, modeVal, fillFor, tcFor, modeBtnStyle } from '../helpers';
import type { ViewProps } from '../ctx';

const MODES: [ItMode, string][] = [
  ['copertura', 'Copertura'], ['profondita', 'Profondità'], ['settori', 'Settori'],
  ['fatturato', 'Fatturato'], ['target', 'Target'], ['recenza', 'Recenza'], ['opportunita', 'Opportunità'],
];

const actSolid: CSSProperties = { padding: 11, borderRadius: 10, background: 'var(--accent)', color: 'var(--white)', fontWeight: 600, fontSize: '.84rem' };
const actOutline: CSSProperties = { padding: 11, borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)', fontWeight: 600, fontSize: '.84rem' };

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

export default function Italia({ st, set, startCount }: ViewProps) {
  const REGIONS = useRegionsCoverage();
  const PROVINCES = useProvincesCoverage();
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
    bars: { k: string; v: string; w: string }[];
    actions: { label: string; style: CSSProperties; onClick: () => void }[];
  };
  if (st.itLevel === 'nazione') {
    detail = {
      kicker: 'Italia', title: 'Patrimonio nazionale',
      kpis: [{ k: 'Aziende', v: fmt(total) }, { k: 'Regioni attive', v: '10' }, { k: 'Province', v: '18' }, { k: 'Mercati', v: '12' }, { k: 'Con fatturato', v: '36%' }, { k: 'Target', v: fmt(total * 0.043) }],
      bars: [{ k: 'Veneto', v: '78%', w: '78%' }, { k: 'Friuli-V.G.', v: '26%', w: '26%' }, { k: 'Lombardia', v: '22%', w: '22%' }, { k: 'Emilia-R.', v: '18%', w: '18%' }, { k: 'Piemonte', v: '12%', w: '12%' }],
      actions: [
        { label: 'Mappa nuovo territorio', style: actSolid, onClick: () => set({ wizardOpen: true, wStep: 0 }) },
        { label: 'Apri il Veneto →', style: actOutline, onClick: () => set({ itLevel: 'regione' }) },
      ],
    };
  } else if (st.itLevel === 'regione') {
    detail = {
      kicker: 'Regione', title: 'Veneto',
      kpis: [{ k: 'Aziende', v: '75.620' }, { k: 'Province', v: '7' }, { k: 'Mercati', v: '8' }, { k: 'Nuove', v: '184' }, { k: 'Con fatt.', v: '52%' }, { k: 'Target', v: '5.220' }],
      bars: [{ k: 'Vicenza', v: '85%', w: '85%' }, { k: 'Padova', v: '64%', w: '64%' }, { k: 'Verona', v: '48%', w: '48%' }, { k: 'Treviso', v: '40%', w: '40%' }, { k: 'Venezia', v: '34%', w: '34%' }],
      actions: [
        { label: 'Confronta province', style: actSolid, onClick: () => set({ nav: 'analytics', anTab: 'geografica' }) },
        { label: 'Apri Vicenza →', style: actOutline, onClick: () => set({ itLevel: 'provincia' }) },
      ],
    };
  } else {
    detail = {
      kicker: 'Provincia', title: 'Vicenza',
      kpis: [{ k: 'Aziende', v: '18.420' }, { k: 'Comuni', v: '41' }, { k: 'Con fatt.', v: '71%' }, { k: 'Target', v: '1.840' }, { k: 'Target rate', v: '10,0%' }, { k: 'Costo/tgt', v: '€0,42' }],
      bars: [{ k: 'Anagrafica', v: '96%', w: '96%' }, { k: 'Fatturato', v: '71%', w: '71%' }, { k: 'Email', v: '51%', w: '51%' }, { k: 'Decisore', v: '8%', w: '8%' }, { k: 'Giudizio', v: '64%', w: '64%' }],
      actions: [
        { label: 'Apri aziende', style: actSolid, onClick: () => set({ nav: 'aziende' }) },
        { label: 'Raffina selezione →', style: actOutline, onClick: () => set({ nav: 'raff', raffTab: 'imbuto' }) },
      ],
    };
  }

  // ---- tooltip ----
  let tip: { show: boolean; name: string; bigCount: string; rows: { k: string; v: string }[] } | null = null;
  if (st.hover) {
    if (st.hover.startsWith('prov:')) {
      const p = PROVINCES.find((x) => 'prov:' + x.id === st.hover);
      if (p) tip = { show: true, name: p.name, bigCount: fmt(st.hoverCount), rows: [{ k: 'Target', v: fmt(p.target) }, { k: 'Target rate', v: p.tr }, { k: 'Costo/target', v: p.ct }] };
    } else if (st.hover.startsWith('com:')) {
      const c = COMUNI.find((x) => 'com:' + x.name === st.hover);
      if (c) tip = { show: true, name: c.name, bigCount: fmt(st.hoverCount), rows: [{ k: 'Densità', v: 'alta' }, { k: 'Categoria', v: 'Metalmecc.' }] };
    } else if (st.hover.startsWith('reg:')) {
      const r = REGIONS.find((x) => 'reg:' + x.id === st.hover);
      if (r) tip = { show: true, name: r.name, bigCount: fmt(st.hoverCount), rows: [{ k: 'Province coperte', v: String(r.prov) }, { k: 'Mercati mappati', v: String(r.mercati) }, { k: 'Copertura', v: r.cov + '%' }] };
    }
  }

  const maxC = 4200;

  return (
    <section className="agfade" style={{ display: 'flex', height: '100%', minHeight: 600 }}>
      {/* left mode panel */}
      <div className="ag-scroll" style={{ width: 230, flex: 'none', borderRight: '1px solid var(--line)', padding: '24px 20px', overflowY: 'auto' }}>
        <span className="kicker">Modalità mappa</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 14 }}>
          {MODES.map(([id, label]) => (
            <button key={id} onClick={() => set({ itMode: id })} style={modeBtnStyle(st.itMode === id)}>{label}</button>
          ))}
        </div>
        <div style={{ marginTop: 26, paddingTop: 20, borderTop: '1px solid var(--line-soft)' }}>
          <span className="kicker kicker--muted">Legenda</span>
          <div style={{ marginTop: 12, height: 9, borderRadius: 999, background: 'linear-gradient(90deg, rgba(151,88,47,.08), rgba(151,88,47,.86))' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.7rem', color: 'var(--ink-3)', marginTop: 6 }}><span>vuoto</span><span>pieno</span></div>
          <p style={{ fontSize: '.74rem', color: 'var(--ink-3)', marginTop: 16, lineHeight: 1.5 }}>
            Ogni cella è una regione, colorata per intensità della metrica scelta. Passa il mouse per i dettagli, clicca il Veneto per scendere alle province.
          </p>
        </div>
      </div>

      {/* map stage */}
      <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ padding: '18px 26px 10px', display: 'flex', alignItems: 'center', gap: 10, fontSize: '.82rem' }}>
          <button onClick={() => set({ itLevel: 'nazione', hover: null })} style={{ fontWeight: st.itLevel === 'nazione' ? 600 : 500, color: st.itLevel === 'nazione' ? 'var(--accent)' : 'var(--ink-2)' }}>Italia</button>
          {st.itLevel !== 'nazione' && (
            <>
              <span style={{ color: 'var(--ink-3)' }}>→</span>
              <button onClick={() => set({ itLevel: 'regione', hover: null })} style={{ fontWeight: st.itLevel === 'regione' ? 600 : 500, color: st.itLevel === 'regione' ? 'var(--accent)' : 'var(--ink-2)' }}>Veneto</button>
            </>
          )}
          {st.itLevel === 'provincia' && (
            <>
              <span style={{ color: 'var(--ink-3)' }}>→</span>
              <span style={{ fontWeight: 600, color: 'var(--accent)' }}>Vicenza</span>
            </>
          )}
          <span style={{ marginLeft: 'auto', fontSize: '.74rem', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.1em' }}>{modeLabel}</span>
        </div>

        <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 20px 24px', minHeight: 0 }}>
          {/* NAZIONE */}
          {st.itLevel === 'nazione' && (
            <svg viewBox="0 0 610 793" style={{ height: '100%', maxHeight: 600, width: 'auto', overflow: 'visible' }} className="agfade">
              {ITALY_REGIONS.locations.map((loc) => {
                const r = bySvg[loc.id];
                const v = r ? modeVal(r, st.itMode) : 0;
                const hovered = r && st.hover === 'reg:' + r.id;
                const clickable = r && r.id === 'ven';
                return (
                  <path
                    key={loc.id}
                    d={loc.path}
                    fill={fillFor(v)}
                    stroke={hovered ? 'var(--accent-deep)' : clickable ? 'var(--accent)' : 'rgba(250,247,242,0.92)'}
                    strokeWidth={hovered ? 2.4 : clickable ? 1.6 : 0.8}
                    className="ag-tile"
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={r ? () => { set({ hover: 'reg:' + r.id }); startCount(r.az); } : undefined}
                    onMouseLeave={() => set({ hover: null })}
                    onClick={clickable ? () => set({ itLevel: 'regione', hover: null }) : undefined}
                  />
                );
              })}
            </svg>
          )}

          {/* REGIONE — Veneto provinces */}
          {st.itLevel === 'regione' && (
            <svg viewBox="0 0 600 463" style={{ height: '100%', maxHeight: 520, width: 'auto', overflow: 'visible' }} className="agfade">
              {VENETO_PROVINCES.locations.map((loc) => {
                const p = PROVINCES.find((x) => x.id === loc.id);
                const v = p ? modeVal({ cov: p.cov }, st.itMode) : 0;
                const hovered = p && st.hover === 'prov:' + p.id;
                const clickable = p && p.id === 'vi';
                return (
                  <path
                    key={loc.id}
                    d={loc.path}
                    fill={fillFor(v)}
                    stroke={hovered ? 'var(--accent-deep)' : clickable ? 'var(--accent)' : 'rgba(250,247,242,0.92)'}
                    strokeWidth={hovered ? 2.4 : clickable ? 1.8 : 0.9}
                    className="ag-tile"
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={p ? () => { set({ hover: 'prov:' + p.id }); startCount(p.az); } : undefined}
                    onMouseLeave={() => set({ hover: null })}
                    onClick={clickable ? () => set({ itLevel: 'provincia', hover: null }) : undefined}
                  />
                );
              })}
              {VENETO_PROVINCES.locations.map((loc) => {
                const p = PROVINCES.find((x) => x.id === loc.id);
                const [lx, ly] = centroid(loc.path);
                const v = p ? modeVal({ cov: p.cov }, st.itMode) : 0;
                return (
                  <text key={'t' + loc.id} x={lx} y={ly} textAnchor="middle" style={{ fontFamily: 'var(--serif)', fontSize: 14, fontWeight: 500, fill: tcFor(v), pointerEvents: 'none' }}>
                    {p ? p.name : loc.name}
                  </text>
                );
              })}
            </svg>
          )}

          {/* PROVINCIA — Vicenza comuni */}
          {st.itLevel === 'provincia' && (
            <svg viewBox="0 0 460 420" style={{ height: '100%', maxHeight: 480, width: 'auto', overflow: 'visible' }} className="agfade">
              {COMUNI.map((c) => {
                const r = 10 + (c.az / maxC) * 18;
                return (
                  <g key={c.name} className="ag-tile" onMouseEnter={() => { set({ hover: 'com:' + c.name }); startCount(c.az); }} onMouseLeave={() => set({ hover: null })}>
                    <circle cx={c.x} cy={c.y} r={r} fill={'rgba(151,88,47,' + (0.18 + (c.az / maxC) * 0.5).toFixed(2) + ')'} stroke="var(--accent)" strokeWidth="1.4" />
                    <text x={c.x} y={c.y - r - 6} textAnchor="middle" style={{ fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 600, fill: 'var(--ink-2)' }}>{c.name}</text>
                  </g>
                );
              })}
            </svg>
          )}

          {/* tooltip */}
          {tip?.show && (
            <div className="agfade" style={{ position: 'absolute', top: 14, right: 14, width: 212, background: 'var(--paper)', border: '1px solid var(--accent-line)', borderRadius: 13, padding: '15px 16px', boxShadow: 'var(--shadow-pop)', pointerEvents: 'none' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '1.05rem', fontWeight: 500, marginBottom: 8 }}>{tip.name}</div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '1.7rem', fontWeight: 500, color: 'var(--accent)', lineHeight: 1 }}>{tip.bigCount}</div>
              <div style={{ fontSize: '.72rem', color: 'var(--ink-3)', marginBottom: 10 }}>aziende acquisite</div>
              {tip.rows.map((t) => (
                <div key={t.k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.78rem', padding: '3px 0', borderTop: '1px solid var(--line-soft)' }}>
                  <span style={{ color: 'var(--ink-3)' }}>{t.k}</span>
                  <span style={{ fontWeight: 600 }}>{t.v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* right detail panel */}
      <div className="ag-scroll" style={{ width: 288, flex: 'none', borderLeft: '1px solid var(--line)', padding: '24px 22px', overflowY: 'auto', background: 'var(--paper-2)' }}>
        <span className="kicker">{detail.kicker}</span>
        <h2 style={{ fontFamily: 'var(--serif)', fontSize: '1.5rem', fontWeight: 500, margin: '8px 0 18px' }}>{detail.title}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
          {detail.kpis.map((k) => (
            <div key={k.k} style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 11, padding: '11px 12px' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '1.16rem', fontWeight: 500, color: 'var(--ink)' }}>{k.v}</div>
              <div style={{ fontSize: '.66rem', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 3 }}>{k.k}</div>
            </div>
          ))}
        </div>
        <span className="kicker kicker--muted">Maturità dati</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0 22px' }}>
          {detail.bars.map((b) => (
            <div key={b.k}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.74rem', marginBottom: 3 }}>
                <span style={{ color: 'var(--ink-2)' }}>{b.k}</span>
                <span style={{ color: 'var(--ink-3)', fontWeight: 600 }}>{b.v}</span>
              </div>
              <div style={{ height: 5, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: b.w, background: 'var(--accent)', borderRadius: 999 }} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {detail.actions.map((a) => (
            <button key={a.label} onClick={a.onClick} style={a.style}>{a.label}</button>
          ))}
        </div>
      </div>
    </section>
  );
}
