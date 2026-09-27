import { describe, it, expect } from 'vitest';
import type { Lead } from '../../src/types/lead';
import { isOffTarget, leadToRow, dedupKey, mergeRow, type OutboundRow } from '../../src/scripts/export_outbound_logistica';

describe('isOffTarget (esclusioni brief: poche e sicure)', () => {
  it('HARD: taxi / NCC / noleggio con conducente / autoscuole sempre esclusi', () => {
    expect(isOffTarget('Taxi/Ncc Alex Mazzeo')).toBe(true);
    expect(isOffTarget('Autonoleggio NCC Rossi')).toBe(true);
    expect(isOffTarget('Noleggio con conducente Bianchi')).toBe(true);
    expect(isOffTarget('Autoscuola Europa')).toBe(true);
  });

  it('SOFT: traslochi / trasporto persone puri esclusi', () => {
    expect(isOffTarget('LCA Traslochi')).toBe(true);
    expect(isOffTarget('Traslochi Volante')).toBe(true);
    expect(isOffTarget('Bus Trasporto Persone Srl')).toBe(true);
  });

  it('SOFT rescue: un ibrido con segnale freight/logistica resta IN lista', () => {
    expect(isOffTarget('Depositi Berni - Traslochi e Deposito Mobili')).toBe(false); // deposito
    expect(isOffTarget('Traslochi Alleanza Padova - Trasporti Nazionali e Internazionali')).toBe(false);
    expect(isOffTarget('Corriere e Traslochi Bonati Omar')).toBe(false); // corriere
    expect(isOffTarget('Traslochi Autotrasporti Fratelli Soldati')).toBe(false); // autotrasporti
  });

  it('aziende freight normali non toccate', () => {
    expect(isOffTarget('A.T.E.S.')).toBe(false);
    expect(isOffTarget('Bartolini Corriere Espresso')).toBe(false);
    expect(isOffTarget('Ghesini Antonio Autotrasporti Movimento Terra')).toBe(false);
  });
});

describe('leadToRow', () => {
  it('telefono GREZZO (phone_raw preferito su phone normalizzato); cap da zip_code', () => {
    const lead = {
      company_name: 'A.T.E.S.',
      phone: '+390532000210',
      phone_raw: '0532 000210',
      zip_code: '44100',
      city: 'Ferrara',
      province: 'FE',
      category: 'autotrasporti',
      pg_url: 'https://www.paginegialle.it/cisaf',
    } as Lead;
    const r = leadToRow(lead, '2026-07-21T16:00:00.000Z');
    expect(r.telefono_1).toBe('0532 000210'); // MAI il +39 normalizzato
    expect(r.cap).toBe('44100');
    expect(r.comune).toBe('Ferrara');
    expect(r.url_scheda_pg).toContain('paginegialle');
    expect(r.scraped_at).toBe('2026-07-21T16:00:00.000Z');
  });

  it('comune preferisce business_city quando presente', () => {
    const lead = { company_name: 'X', phone_raw: '02 1', city: 'Milano', business_city: 'Sesto San Giovanni' } as Lead;
    expect(leadToRow(lead, 'T').comune).toBe('Sesto San Giovanni');
  });
});

describe('dedupKey + mergeRow (dedup esatto tel+comune, categorie concatenate)', () => {
  const row = (over: Partial<OutboundRow>): OutboundRow => ({
    ragione_sociale: 'X', telefono_1: '', telefono_2: '', indirizzo: '', cap: '', comune: '', provincia: '',
    sito_web: '', categoria_pg: '', url_scheda_pg: '', email: '', descrizione: '', scraped_at: 'T', ...over,
  });

  it('chiave = cifre telefono + comune lowercase; nessuna chiave senza telefono', () => {
    expect(dedupKey(row({ telefono_1: '0532 000210', comune: 'Ferrara' }))).toBe('0532000210|ferrara');
    expect(dedupKey(row({ telefono_1: '', comune: 'Ferrara' }))).toBeUndefined();
  });

  it('merge concatena categorie nuove, non duplica, riempie solo campi vuoti', () => {
    const kept = row({ ragione_sociale: 'A.T.E.S.', telefono_1: '0532 000210', comune: 'Ferrara', categoria_pg: 'autotrasporti', sito_web: '' });
    const dup = row({ telefono_1: '0532 000210', comune: 'Ferrara', categoria_pg: 'logistica', sito_web: 'https://ates.example' });
    mergeRow(kept, dup);
    expect(kept.categoria_pg).toBe('autotrasporti | logistica');
    expect(kept.sito_web).toBe('https://ates.example'); // fill-only-empty
    // stessa categoria di nuovo → nessun duplicato
    mergeRow(kept, row({ categoria_pg: 'autotrasporti' }));
    expect(kept.categoria_pg).toBe('autotrasporti | logistica');
  });

  it('un secondo numero DIVERSO dalla stessa azienda finisce in telefono_2', () => {
    const kept = row({ telefono_1: '0532 000210', comune: 'Ferrara', categoria_pg: 'autotrasporti' });
    mergeRow(kept, row({ telefono_1: '0532 999999', comune: 'Ferrara', categoria_pg: 'spedizionieri' }));
    expect(kept.telefono_2).toBe('0532 999999');
  });
});
