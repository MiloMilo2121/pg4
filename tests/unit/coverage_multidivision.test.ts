import { describe, it, expect } from 'vitest';
import { buildCoverageReport } from '../../src/coverage/coverage_engine';
import type { UniverseSource } from '../../src/coverage/universe';
import type { Lead } from '../../src/types/lead';

/**
 * Post-mortem coverage bug: "impresa edile" classifica su ATECO 41, ma il
 * settore edilizia copre 41+43 (sectors.json). Confrontare have(41+43) con
 * universe(41) da solo → copertura gonfiata (>100%). Il motore deve sommare
 * l'universo di TUTTE le divisioni del settore.
 */
const mockUniverse: UniverseSource = {
  label: 'mock',
  hasData: () => true,
  count: (division, province) => {
    if (province !== 'PD') return null;
    if (division === '41') return { activeFirms: 100, provenance: 'istat-asia' };
    if (division === '43') return { activeFirms: 300, provenance: 'istat-asia' };
    if (division === '68') return { activeFirms: 500, provenance: 'istat-asia' };
    return null;
  },
};

describe('universo multi-divisione', () => {
  it('edilizia (41+43): universo = somma delle divisioni del settore', () => {
    const leads: Lead[] = [{ company_name: 'Edil X', category: 'impresa edile', province: 'PD' }];
    const report = buildCoverageReport(leads, { universe: mockUniverse });
    const cell = report.cells.find((c) => c.province === 'PD');
    expect(cell).toBeDefined();
    expect(cell!.division).toBe('41'); // classificato su 41 dal crosswalk
    expect(cell!.universeTotal).toBe(400); // 41(100) + 43(300)
  });

  it('immobiliare (settore mono-divisione 68): NON somma altro', () => {
    const leads: Lead[] = [{ company_name: 'Casa Y', category: 'agenzie immobiliari', province: 'PD' }];
    const report = buildCoverageReport(leads, { universe: mockUniverse });
    const cell = report.cells.find((c) => c.division === '68' && c.province === 'PD');
    expect(cell!.universeTotal).toBe(500); // solo 68
  });
});
