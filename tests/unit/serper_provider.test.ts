import { describe, it, expect } from 'vitest';
import { SerperProvider } from '../../src/providers/serp/serper';

/**
 * Phase G — SerperProvider unit tests. No network: all tests target
 * the static `parseOrganic` parser and the `available()` gate.
 *
 * Live HTTP path is exercised in the smoke suite (RUN_SMOKE=1)
 * separately so unit tests stay 0-network.
 */

describe('SerperProvider — invariants', () => {
  it('costPerCallEur is 0.001 (paid tier 2)', () => {
    const p = new SerperProvider();
    expect(p.costPerCallEur).toBe(0.001);
    expect(p.tier).toBe(2);
    expect(p.id).toBe('serper');
    expect(p.family).toBe('serp');
  });
});

describe('SerperProvider — Phase G.1 error classification', () => {
  // We can't easily mock undici.request without DI, but the
  // observable invariant we want to pin is: parseOrganic handles all
  // shapes safely. The router-level breaker behaviour is covered by
  // the router tests; here we confirm the parser cannot misclassify.
  it('treats `null`/`undefined` payload as empty (not crash)', () => {
    expect(SerperProvider.parseOrganic(null, 5, 'serper')).toEqual([]);
    expect(SerperProvider.parseOrganic(undefined, 5, 'serper')).toEqual([]);
  });
});

describe('SerperProvider — parseOrganic', () => {
  const ID = 'serper';

  it('parses organic results into SerpResult shape', () => {
    const json = {
      organic: [
        { title: 'Cangrande Immobiliare', link: 'https://cangrande.it', snippet: 'Agenzia immobiliare a Verona' },
        { title: 'Pierobon', link: 'https://agenziaimmobiliareestimopierobon.com', snippet: 'Belluno' },
      ],
    };
    const out = SerperProvider.parseOrganic(json, 10, ID);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ title: 'Cangrande Immobiliare', url: 'https://cangrande.it', rank: 1, source_provider: 'serper' });
    expect(out[1].rank).toBe(2);
  });

  it('returns [] for empty organic', () => {
    expect(SerperProvider.parseOrganic({ organic: [] }, 10, ID)).toEqual([]);
  });

  it('returns [] when organic missing', () => {
    expect(SerperProvider.parseOrganic({}, 10, ID)).toEqual([]);
    expect(SerperProvider.parseOrganic({ organic: 'wrong-type' }, 10, ID)).toEqual([]);
  });

  it('skips entries without title or url', () => {
    const json = {
      organic: [
        { title: 'No url' },
        { link: 'https://no-title.example', snippet: 'x' },
        { title: 'Good', link: 'https://good.example', snippet: 'ok' },
      ],
    };
    const out = SerperProvider.parseOrganic(json, 10, ID);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://good.example');
  });

  it('respects the limit', () => {
    const json = {
      organic: Array.from({ length: 30 }, (_, i) => ({ title: `r${i}`, link: `https://r${i}.example`, snippet: '' })),
    };
    const out = SerperProvider.parseOrganic(json, 5, ID);
    expect(out).toHaveLength(5);
    expect(out[4].title).toBe('r4');
  });
});
