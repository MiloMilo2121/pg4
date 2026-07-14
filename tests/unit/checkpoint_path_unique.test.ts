import { describe, it, expect } from 'vitest';
import { defaultCheckpointPath } from '../../src/discovery/scrape_pipeline';

/**
 * Post-mortem: il checkpoint di default era keyed solo per categoria →
 * condiviso tra province → MissingPriorJsonlError (31 volte, 30 celle Veneto
 * azzerate). Ora è derivato dal path di output → 1:1 col target.
 */
describe('defaultCheckpointPath', () => {
  it('è unico per output diverso (province diverse, stessa categoria)', () => {
    const bl = defaultCheckpointPath('output/recall/immobiliare_BL_raw.csv');
    const ve = defaultCheckpointPath('output/recall/immobiliare_VE_raw.csv');
    expect(bl).not.toBe(ve);
    expect(bl).toBe('output/recall/immobiliare_BL_raw.checkpoint.json');
  });

  it('è stabile per lo stesso output (resume riprende lo stesso file)', () => {
    const a = defaultCheckpointPath('output/x/estetica_TV_raw.csv');
    const b = defaultCheckpointPath('output/x/estetica_TV_raw.csv');
    expect(a).toBe(b);
  });

  it('gestisce output senza estensione .csv', () => {
    expect(defaultCheckpointPath('output/x/foo')).toBe('output/x/foo.checkpoint.json');
  });
});
