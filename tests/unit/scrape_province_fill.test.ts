import { describe, it, expect } from 'vitest';
import { fillProvinceFromComune } from '../../src/discovery/scrape_pipeline';
import type { Lead } from '../../src/types/lead';

/**
 * Post-mortem: il parser Maps non estrae la sigla → ~42% dei lead usciva con
 * province vuota. Ora la risolviamo a scrape-time dal nome comune.
 */
describe('fillProvinceFromComune (scrape-time)', () => {
  it('risolve la provincia dal city quando manca (caso Maps)', () => {
    const lead: Lead = { company_name: 'Trattoria', category: 'ristorante', city: 'Padova' };
    fillProvinceFromComune(lead);
    expect(lead.province).toBe('PD');
  });

  it('usa query_location come fallback', () => {
    const lead: Lead = { company_name: 'X', query_location: 'Verona' };
    fillProvinceFromComune(lead);
    expect(lead.province).toBe('VR');
  });

  it('NON sovrascrive una provincia gia\' presente (dall\'indirizzo PG)', () => {
    const lead: Lead = { company_name: 'Y', city: 'Padova', province: 'RM' };
    fillProvinceFromComune(lead);
    expect(lead.province).toBe('RM'); // invariata
  });

  it('lascia vuoto su comune sconosciuto/ambiguo (nessun indovinare)', () => {
    const lead: Lead = { company_name: 'Z', city: 'ComuneInventato' };
    fillProvinceFromComune(lead);
    expect(lead.province).toBeUndefined();
  });
});
