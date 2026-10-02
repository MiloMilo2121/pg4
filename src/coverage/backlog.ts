/**
 * Backlog generator — the OPERATIONAL output of the gap map.
 *
 * From the coverage map it produces a prioritized list of actions. Two branches,
 * because a "gap" has two causes with opposite remedies:
 *   - SCRAPE: few companies vs addressable universe  -> scrape more
 *   - ENRICH: companies present but with little data  -> enrich the existing ones
 *
 * For the scrape branch it emits ready-to-run `pnpm run pipeline` commands for the weakest
 * provinces, using the crosswalk keywords. For the enrich branch it gives guidance (in
 * pg4 enrichment starts from a CSV / the dashboard, not from a geo query).
 */

import type { CoverageReport, CoverageCell, RegionRollup } from './coverage_engine';
import { Crosswalk } from './crosswalk';
import { stripDiacritics } from '../util/text';

export interface BacklogItem {
  rank: number;
  action: 'scrape' | 'enrich';
  division: string;
  atecoLabel: string;
  region: string;
  priorityScore: number | null;
  coveragePct: number | null;
  reason: string;
  // scrape branch
  keywords?: string[];
  targetProvinces?: string[];
  estLeadsNeeded?: number | null;
  commands?: string[];
  // enrich branch
  haveToEnrich?: number;
  enrichScore?: number;
  weakFields?: string[];
}

export interface BacklogOptions {
  crosswalk?: Crosswalk;
  /** Below this enrichment score (0..100) a well-covered cell becomes an enrich action. */
  enrichScoreThreshold?: number;
  /** How many weak provinces to list per scrape item. */
  maxProvincesPerItem?: number;
  /** Maximum number of items in the backlog. */
  maxItems?: number;
}

const DEFAULTS: Required<Omit<BacklogOptions, 'crosswalk'>> = {
  enrichScoreThreshold: 50,
  maxProvincesPerItem: 4,
  maxItems: 50,
};

function slug(s: string): string {
  return stripDiacritics(s.toLowerCase()).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

const WEAK_FIELD_THRESHOLD = 50; // fill % below which a field is "weak"

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
 * Builds the backlog from the coverage map (reasons at the
 * region x division level, with the weak provinces as the operational target).
 */
export function buildBacklog(report: CoverageReport, opts: BacklogOptions = {}): BacklogItem[] {
  const o = { ...DEFAULTS, ...opts };
  const crosswalk = opts.crosswalk ?? new Crosswalk();
  const target = report.generated.config.targetCoverage;

  // provincia cells indexed by region|division, to pick the weak provinces
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
      // ---- SCRAPE branch ----
      const keywords = crosswalk.keywordsFor(r.division);
      const targetProvinces = provinceCells.slice(0, o.maxProvincesPerItem).map((c) => c.province);
      // if the region has no cells yet (0 scraped), use all provinces? we leave it empty: the data point is "0 everywhere"
      const primaryKw = keywords[0] ?? r.atecoLabel;
      const commands = targetProvinces.map(
        (prov) => `pnpm run pipeline -- --category "${primaryKw}" --province ${prov} --maps --coverage full --out output/${slug(r.division + '_' + primaryKw)}_${prov}`,
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
      // ---- ENRICH branch (sufficiently covered but poor data) ----
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

  // sort: scrape with known priority first (desc), then enrich by have desc
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
