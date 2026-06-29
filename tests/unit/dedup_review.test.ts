import { describe, expect, it } from 'vitest';
import { Deduplicator } from '../../src/discovery/deduper';

/**
 * Phase C.3 — near-duplicate review candidates. Token-sorted name+city
 * collisions are FLAGGED, never merged.
 */
describe('Deduplicator review candidates — Phase C.3', () => {
  it('flags reordered names in the same city as review candidates without merging', () => {
    const dd = new Deduplicator();
    const a = { company_name: 'Immobiliare Rossi', city: 'Padova' };
    const b = { company_name: 'Rossi Immobiliare', city: 'Padova' };

    expect(dd.find(a)).toBeUndefined();
    dd.add(a);
    // b is NOT a primary-key duplicate (different name+city key)…
    expect(dd.find(b)).toBeUndefined();
    dd.add(b);

    // …but it IS flagged for review.
    const candidates = dd.getReviewCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].rule).toBe('token_sort_name_city');
    expect(candidates[0].existing.company_name).toBe('Immobiliare Rossi');
    expect(candidates[0].incoming.company_name).toBe('Rossi Immobiliare');
  });

  it('identical names are primary duplicates, not review candidates', () => {
    const dd = new Deduplicator();
    const a = { company_name: 'Studio Casa', city: 'Padova' };
    dd.add(a);
    expect(dd.find({ company_name: 'Studio Casa', city: 'Padova' })).toBe(a);
    expect(dd.getReviewCandidates()).toHaveLength(0);
  });

  it('same sorted tokens in DIFFERENT cities are not flagged', () => {
    const dd = new Deduplicator();
    dd.add({ company_name: 'Immobiliare Rossi', city: 'Padova' });
    dd.add({ company_name: 'Rossi Immobiliare', city: 'Treviso' });
    expect(dd.getReviewCandidates()).toHaveLength(0);
  });

  it('single-token names never produce candidates', () => {
    const dd = new Deduplicator();
    dd.add({ company_name: 'Tecnocasa', city: 'Padova' });
    dd.add({ company_name: 'Tecnocasa', city: 'Padova', address: 'altra sede' });
    // (second add of the identical key just overwrites the index; the
    // pipeline would have merged via find() first — no review noise)
    expect(dd.getReviewCandidates()).toHaveLength(0);
  });
});
