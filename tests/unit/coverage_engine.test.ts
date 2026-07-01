import { describe, it, expect } from 'vitest';
import type { Lead } from '../../src/types/lead';
import { buildCoverageReport } from '../../src/coverage/coverage_engine';
import { buildBacklog } from '../../src/coverage/backlog';
import { IstatAsiaUniverse } from '../../src/coverage/universe';

// Universo FISSO (fixture sample) per asserzioni deterministiche, indipendenti
// dal file ISTAT reale di produzione (che cambia ad ogni aggiornamento annuale).
const SAMPLE = new IstatAsiaUniverse('data/reference/istat_asia_universe.sample.csv');

const leads: Lead[] = [
  // 3 immobiliari a PD, enrichment decrescente
  { company_name: 'A', category: 'agenzie immobiliari', province: 'PD', official_website: 'https://a.it', phone: '+390', email_inferred: 'a@a.it', pec: 'a@pec.it', vat_code_final: '123' },
  { company_name: 'B', category: 'agenzia immobiliare', province: 'PD', website: 'http://b.it' },
  { company_name: 'C', category: 'mediatore immobiliare', province: 'PD' },
  // 1 ristorante a MI
  { company_name: 'D', category: 'ristorante', province: 'MI', phone: '+391' },
  // fuori scope (Roma)
  { company_name: 'E', category: 'agenzie immobiliari', province: 'RM' },
  // non classificabile (categoria ignota) ma in Nord
  { company_name: 'F', category: 'categoria ignota xyz', province: 'PD' },
];

describe('buildCoverageReport', () => {
  const report = buildCoverageReport(leads, { universe: SAMPLE });

  it('conta scope/out-of-scope/unclassified senza drop silenziosi', () => {
    expect(report.summary.totalLeads).toBe(6);
    expect(report.summary.outOfScope).toBe(1);
    expect(report.summary.unclassified).toBe(1);
    expect(report.summary.inScope).toBe(4);
    expect(report.buckets.outOfScope.byProvince.RM).toBe(1);
    expect(report.buckets.unclassified.count).toBe(1);
  });

  it('cella 68|PD: have, universo, addressable, coverage, campione', () => {
    const cell = report.cells.find((c) => c.division === '68' && c.province === 'PD');
    expect(cell).toBeDefined();
    expect(cell!.have).toBe(3);
    expect(cell!.region).toBe('Veneto');
    // universo sample 2200 * directoryFactor sezione L (0.7) = 1540
    expect(cell!.universeTotal).toBe(2200);
    expect(cell!.addressable).toBe(1540);
    expect(cell!.coveragePct).toBe(0.002); // 3/1540 arrotondato a 3 decimali
    expect(cell!.sampleOk).toBe(false); // 3 < 15
    expect(cell!.needForSample).toBe(12);
    expect(cell!.universeProvenance).toBe('sample');
  });

  it('cella 68|PD: fill-rate di enrichment (carenza di qualita\')', () => {
    const cell = report.cells.find((c) => c.division === '68' && c.province === 'PD')!;
    expect(cell.enrichment.fillRates.website).toBeCloseTo(66.7, 1); // A+B su 3
    expect(cell.enrichment.fillRates.phone).toBeCloseTo(33.3, 1); // solo A
    expect(cell.enrichment.fillRates.pec).toBeCloseTo(33.3, 1);
    expect(cell.enrichment.score).toBeCloseTo(40, 0);
  });

  it('segnala l\'uso di universo SAMPLE', () => {
    expect(report.summary.usesSampleUniverse).toBe(true);
  });

  it('rollup regione Veneto x 68 aggrega le province', () => {
    const r = report.regionRollup.find((x) => x.region === 'Veneto' && x.division === '68');
    expect(r).toBeDefined();
    expect(r!.have).toBe(3);
    expect(r!.minSample).toBe(30);
    expect(r!.sampleOk).toBe(false);
  });
});

describe('buildBacklog', () => {
  const report = buildCoverageReport(leads, { universe: SAMPLE });
  const backlog = buildBacklog(report);

  it('produce azioni scrape per le celle sotto-coperte con keyword e comandi', () => {
    expect(backlog.length).toBeGreaterThan(0);
    const veneto68 = backlog.find((b) => b.region === 'Veneto' && b.division === '68');
    expect(veneto68?.action).toBe('scrape');
    expect(veneto68?.keywords?.[0]).toBe('agenzie immobiliari');
    expect(veneto68?.targetProvinces).toContain('PD');
    expect(veneto68?.commands?.[0]).toMatch(/pnpm run run .*--province PD/);
  });

  it('i rank sono progressivi a partire da 1', () => {
    backlog.forEach((b, i) => expect(b.rank).toBe(i + 1));
  });
});
