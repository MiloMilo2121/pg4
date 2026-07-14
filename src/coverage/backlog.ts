/**
 * Generatore di backlog — l'output OPERATIVO della gap map.
 *
 * Dalla mappa di copertura produce una lista prioritizzata di azioni. Due rami,
 * perche' "carenza" ha due cause con rimedi opposti:
 *   - SCRAPE: poche aziende vs universo indirizzabile  -> scrapare di piu'
 *   - ENRICH: aziende presenti ma con pochi dati        -> arricchire le esistenti
 *
 * Per il ramo scrape emette comandi `pnpm run run` pronti, per le province piu'
 * deboli, con le keyword del crosswalk. Per il ramo enrich da' indicazioni (in
 * pg4 l'enrichment parte da un CSV / dal dashboard, non da una query geo).
 */

import type { CoverageReport, CoverageCell, RegionRollup } from './coverage_engine';
import { Crosswalk } from './crosswalk';

export interface BacklogItem {
  rank: number;
  action: 'scrape' | 'enrich';
  division: string;
  atecoLabel: string;
  region: string;
  priorityScore: number | null;
  coveragePct: number | null;
  reason: string;
  // ramo scrape
  keywords?: string[];
  targetProvinces?: string[];
  estLeadsNeeded?: number | null;
  commands?: string[];
  // ramo enrich
  haveToEnrich?: number;
  enrichScore?: number;
  weakFields?: string[];
}

export interface BacklogOptions {
  crosswalk?: Crosswalk;
  /** Sotto questo enrichment score (0..100) una cella ben coperta diventa azione enrich. */
  enrichScoreThreshold?: number;
  /** Quante province deboli elencare per item scrape. */
  maxProvincesPerItem?: number;
  /** Massimo numero di item nel backlog. */
  maxItems?: number;
}

const DEFAULTS: Required<Omit<BacklogOptions, 'crosswalk'>> = {
  enrichScoreThreshold: 50,
  maxProvincesPerItem: 4,
  maxItems: 50,
};

function slug(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

const WEAK_FIELD_THRESHOLD = 50; // % fill sotto cui un campo e' "debole"

function weakFields(r: RegionRollup): string[] {
  const f = r.enrichment.fillRates;
  const out: string[] = [];
  if (f.website < WEAK_FIELD_THRESHOLD) out.push('website');
  if (f.phone < WEAK_FIELD_THRESHOLD) out.push('phone');
  if (f.email < WEAK_FIELD_THRESHOLD) out.push('email');
  if (f.pec < WEAK_FIELD_THRESHOLD) out.push('pec');
  if (f.vat < WEAK_FIELD_THRESHOLD) out.push('vat');
  return out;
}

/**
 * Costruisce il backlog dalla mappa di copertura (ragiona a livello
 * regione x divisione, con le province deboli come target operativo).
 */
export function buildBacklog(report: CoverageReport, opts: BacklogOptions = {}): BacklogItem[] {
  const o = { ...DEFAULTS, ...opts };
  const crosswalk = opts.crosswalk ?? new Crosswalk();
  const target = report.generated.config.targetCoverage;

  // celle provincia indicizzate per regione|divisione, per scegliere le province deboli
  const cellsByRegionDiv = new Map<string, CoverageCell[]>();
  for (const c of report.cells) {
    const k = `${c.region}|${c.division}`;
    (cellsByRegionDiv.get(k) ?? cellsByRegionDiv.set(k, []).get(k)!).push(c);
  }

  const items: BacklogItem[] = [];
  for (const r of report.regionRollup) {
    const provinceCells = (cellsByRegionDiv.get(`${r.region}|${r.division}`) ?? [])
      .slice()
      .sort((a, b) => (b.priorityScore ?? -1) - (a.priorityScore ?? -1));

    const coverageInsufficient = r.needForTarget !== null && r.needForTarget > 0;
    const sampleInsufficient = !r.sampleOk;

    if (coverageInsufficient || sampleInsufficient) {
      // ---- ramo SCRAPE ----
      const keywords = crosswalk.keywordsFor(r.division);
      const targetProvinces = provinceCells.slice(0, o.maxProvincesPerItem).map((c) => c.province);
      // se la regione non ha ancora celle (0 scrapate) usa tutte le province? lasciamo vuoto: il dato e' "0 ovunque"
      const primaryKw = keywords[0] ?? r.atecoLabel;
      const commands = targetProvinces.map(
        (prov) => `pnpm run run -- --category "${primaryKw}" --province ${prov} --maps --coverage full --out output/${slug(r.division + '_' + primaryKw)}_${prov}`,
      );
      const reason = r.universeKnown
        ? `copertura ${r.coveragePct === null ? 'n/d' : Math.round((r.coveragePct) * 100) + '%'} < target ${Math.round(target * 100)}%${sampleInsufficient ? ` · campione ${r.have}/${r.minSample} sotto soglia` : ''}`
        : `universo ISTAT ignoto per la divisione · campione ${r.have}${sampleInsufficient ? ` sotto soglia ${r.minSample}` : ''}`;
      items.push({
        rank: 0,
        action: 'scrape',
        division: r.division,
        atecoLabel: r.atecoLabel,
        region: r.region,
        priorityScore: r.priorityScore,
        coveragePct: r.coveragePct,
        reason,
        keywords,
        targetProvinces,
        estLeadsNeeded: r.needForTarget,
        commands,
      });
    } else if (r.enrichment.score < o.enrichScoreThreshold) {
      // ---- ramo ENRICH (coperta a sufficienza ma dati poveri) ----
      const wf = weakFields(r);
      items.push({
        rank: 0,
        action: 'enrich',
        division: r.division,
        atecoLabel: r.atecoLabel,
        region: r.region,
        priorityScore: r.priorityScore,
        coveragePct: r.coveragePct,
        reason: `copertura sufficiente ma enrichment score ${r.enrichment.score}/100 — campi deboli: ${wf.join(', ') || 'n/d'}`,
        haveToEnrich: r.have,
        enrichScore: r.enrichment.score,
        weakFields: wf,
      });
    }
  }

  // ordina: scrape con priorita' nota prima (desc), poi enrich per have desc
  items.sort((a, b) => {
    if (a.action !== b.action) return a.action === 'scrape' ? -1 : 1;
    if (a.action === 'scrape') {
      return (b.priorityScore ?? -1) - (a.priorityScore ?? -1);
    }
    return (b.haveToEnrich ?? 0) - (a.haveToEnrich ?? 0);
  });
  const sliced = items.slice(0, o.maxItems);
  sliced.forEach((it, i) => (it.rank = i + 1));
  return sliced;
}
