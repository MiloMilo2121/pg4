import fs from 'fs';
import path from 'path';
import { stringify } from 'csv-stringify/sync';
import { parseArgs, reqString, optString, hasHelp, reportFatal } from './_args';
import { buildCoverageReport } from '../coverage/coverage_engine';
import type { CoverageReport, CoverageCell, RegionRollup } from '../coverage/coverage_engine';
import { buildBacklog } from '../coverage/backlog';
import { suppressionForCommand } from '../compliance/suppression';
import { loadLeadFiles } from '../io/lead_files';

/**
 * `pnpm run coverage -- --input output/campaign_enriched.csv --out output/coverage`
 *
 * Costruisce la coverage gap map (industry x area, Nord Italia) dai lead
 * accumulati e scrive:
 *   <out>_cells.csv      celle provincia x divisione (flat, per foglio/pivot)
 *   <out>_gap_map.json   gerarchia macro-area > regione > divisione > provincia + backlog
 *   <out>_backlog.csv    backlog operativo prioritizzato (scrape / enrich)
 *
 * --input accetta CSV o JSONL (enriched), ripetibile via virgola.
 */

const CELL_COLUMNS = [
  'macroArea', 'region', 'province', 'division', 'atecoLabel', 'section',
  'have', 'withWebsite', 'websitePct',
  'fill_website', 'fill_phone', 'fill_email', 'fill_pec', 'fill_vat', 'enrichScore',
  'universeTotal', 'universeProvenance', 'addressable', 'coveragePct',
  'minSample', 'sampleOk', 'needForTarget', 'needForSample', 'priorityScore',
] as const;

function cellRow(c: CoverageCell): Array<string | number> {
  return [
    c.macroArea, c.region, c.province, c.division, c.atecoLabel, c.section,
    c.have, c.withWebsite, c.websitePct ?? '',
    c.enrichment.fillRates.website, c.enrichment.fillRates.phone, c.enrichment.fillRates.email,
    c.enrichment.fillRates.pec, c.enrichment.fillRates.vat, c.enrichment.score,
    c.universeTotal ?? '', c.universeProvenance ?? '', c.addressable ?? '',
    c.coveragePct ?? '', c.minSample, c.sampleOk ? 1 : 0,
    c.needForTarget ?? '', c.needForSample, c.priorityScore ?? '',
  ];
}

/** Gerarchia macro-area > regione > divisione(rollup) > province(cells). */
function buildHierarchy(report: CoverageReport) {
  const cellsByRegionDiv = new Map<string, CoverageCell[]>();
  for (const c of report.cells) {
    const k = `${c.region}|${c.division}`;
    (cellsByRegionDiv.get(k) ?? cellsByRegionDiv.set(k, []).get(k)!).push(c);
  }
  const macros = new Map<string, Map<string, RegionRollup[]>>();
  for (const r of report.regionRollup) {
    const m = macros.get(r.macroArea) ?? macros.set(r.macroArea, new Map()).get(r.macroArea)!;
    (m.get(r.region) ?? m.set(r.region, []).get(r.region)!).push(r);
  }
  return [...macros.entries()].map(([macroArea, regions]) => ({
    macroArea,
    regions: [...regions.entries()].map(([region, divisions]) => ({
      region,
      divisions: divisions.map((d) => ({
        ...d,
        provinces: (cellsByRegionDiv.get(`${region}|${d.division}`) ?? []),
      })),
    })),
  }));
}

async function main(): Promise<number> {
  const args = parseArgs();
  if (hasHelp(args)) { printUsage(); return 0; }

  const inputs = reqString(args, 'input').split(',').map((s) => s.trim()).filter(Boolean);
  const outBase = reqString(args, 'out').replace(/\.(csv|json)$/i, '');

  const configOverride: Record<string, number> = {};
  const tc = optString(args, 'target-coverage');
  if (tc) configOverride.targetCoverage = Number(tc);
  const msr = optString(args, 'min-sample-region');
  if (msr) configOverride.minSampleRegion = Number(msr);
  const msp = optString(args, 'min-sample-province');
  if (msp) configOverride.minSampleProvince = Number(msp);

  // A suppressed company is not a lead we have: counting it would mark its
  // cell as covered while delivery can never use it. Report-only, so the list
  // is looked up next to the (first) enriched input rather than the report.
  const { kept: leads, suppressed } = suppressionForCommand(args.flags, inputs[0]).apply((await loadLeadFiles(inputs)).leads);
  const report = buildCoverageReport(leads, { config: configOverride });
  const backlog = buildBacklog(report);

  fs.mkdirSync(path.dirname(path.resolve(outBase)), { recursive: true });

  // 1) celle CSV
  const cellsCsv = `${outBase}_cells.csv`;
  fs.writeFileSync(cellsCsv, stringify([[...CELL_COLUMNS], ...report.cells.map(cellRow)]));

  // 2) gap map JSON gerarchico + backlog
  const gapJson = `${outBase}_gap_map.json`;
  fs.writeFileSync(gapJson, JSON.stringify({
    meta: { generated: report.generated, summary: report.summary },
    buckets: report.buckets,
    hierarchy: buildHierarchy(report),
    backlog,
  }, null, 2));

  // 3) backlog CSV
  const backlogCsv = `${outBase}_backlog.csv`;
  const BCOLS = ['rank', 'action', 'region', 'division', 'atecoLabel', 'coveragePct', 'priorityScore', 'estLeadsNeeded', 'enrichScore', 'reason', 'keywords', 'targetProvinces', 'command'];
  fs.writeFileSync(backlogCsv, stringify([
    BCOLS,
    ...backlog.map((b) => [
      b.rank, b.action, b.region, b.division, b.atecoLabel, b.coveragePct ?? '', b.priorityScore ?? '',
      b.estLeadsNeeded ?? '', b.enrichScore ?? '', b.reason,
      (b.keywords ?? []).join(' | '), (b.targetProvinces ?? []).join(' '), (b.commands ?? [])[0] ?? '',
    ]),
  ]));

  // sommario a video
  const s = report.summary;
  process.stdout.write([
    `\nCoverage gap map — ${leads.length} lead letti${suppressed > 0 ? ` (${suppressed} esclusi dalla suppression list)` : ''}`,
    `  in scope (Nord+classificate): ${s.inScope}  ·  fuori Nord: ${s.outOfScope}  ·  non classificate: ${s.unclassified}`,
    `  celle: ${s.cells} (universo noto ${s.cellsUniverseKnown}, ignoto ${s.cellsUniverseUnknown})`,
    s.usesSampleUniverse ? `  ⚠ universo: usa righe SAMPLE (placeholder) — sostituisci con export ISTAT reale per numeri di produzione` : `  universo: ${report.generated.universeSource}`,
    `  backlog: ${backlog.length} azioni (${backlog.filter((b) => b.action === 'scrape').length} scrape, ${backlog.filter((b) => b.action === 'enrich').length} enrich)`,
    `\nTop 5 priorita':`,
    ...backlog.slice(0, 5).map((b) => `  #${b.rank} [${b.action}] ${b.region} · ${b.atecoLabel} — ${b.reason}`),
    `\nOutput:\n  ${cellsCsv}\n  ${gapJson}\n  ${backlogCsv}\n`,
  ].join('\n'));

  return 0;
}

function printUsage(): void {
  process.stdout.write(`Usage:
  pnpm run coverage -- --input <enriched.csv|jsonl>[,<more>] --out output/coverage

Costruisce la coverage gap map (industry x area, Nord Italia).
Flags:
  --input <path[,path]>        CSV o JSONL dei lead accumulati (richiesto).
  --out <base>                 Base path output (richiesto).
  --target-coverage <0..1>     Frazione di copertura target (default 0.6).
  --min-sample-region <n>      Soglia campione regione x divisione (default 30).
  --min-sample-province <n>    Soglia campione provincia x divisione (default 15).
  --suppression-list <path>    CSV do-not-contact (altrimenti SUPPRESSION_LIST, poi
                               suppression.csv accanto al primo --input): aziende escluse dal conteggio.
`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    reportFatal('coverage', err);
    process.exit(2);
  });
