import { describe, it, expect } from 'vitest';
import { ItalianNerParser } from '../../src/discovery/website/hyper_guesser/italian_ner_parser';
import { HyperGuesserGenerator } from '../../src/discovery/website/hyper_guesser/generator';
import { HyperGuesser } from '../../src/discovery/website/hyper_guesser';
import { normalizeLead } from '../../src/discovery/input_normalizer';

describe('ItalianNerParser', () => {
  it('extracts legal entity (SRL)', () => {
    const r = ItalianNerParser.parse('Mario Rossi SRL');
    expect(r.legalEntity).toBe('srl');
    expect(r.brandTokens).toEqual(['mario', 'rossi']);
    expect(r.coreBrand).toBe('mario rossi');
  });

  it('separates descriptors from brand', () => {
    const r = ItalianNerParser.parse('Ristorante Da Mario');
    expect(r.descriptors).toContain('ristorante');
    expect(r.brandTokens).toContain('mario');
  });

  it('handles s.r.l. with dots', () => {
    const r = ItalianNerParser.parse('ACME S.R.L.');
    expect(r.legalEntity).toBe('s.r.l.');
    expect(r.coreBrand).toBe('acme');
  });

  it('falls back to all tokens when nothing remains', () => {
    const r = ItalianNerParser.parse('di e &');
    // all tokens are descriptors → fallback restores them as brand
    expect(r.brandTokens.length).toBeGreaterThan(0);
  });
});

describe('HyperGuesserGenerator', () => {
  it('produces brand+TLD permutations', () => {
    const lead = normalizeLead({ company_name: 'Acme SRL' });
    const out = HyperGuesserGenerator.generate(lead);
    expect(out).toContain('acme.it');
    expect(out).toContain('acme.com');
  });

  it('appends and prepends city', () => {
    const lead = normalizeLead({ company_name: 'Acme', city: 'Milano' });
    const out = HyperGuesserGenerator.generate(lead);
    expect(out).toContain('acmemilano.it');
    expect(out).toContain('milanoacme.it');
  });

  it('generates acronyms for multi-word brands', () => {
    const lead = normalizeLead({ company_name: 'Coffani Massimiliano Auto SRL' });
    const out = HyperGuesserGenerator.generate(lead);
    expect(out.some((d) => d.startsWith('cm') || d.startsWith('cma'))).toBe(true);
  });

  it('descriptor + brand combos', () => {
    const lead = normalizeLead({ company_name: 'Ristorante Bella Vista' });
    const out = HyperGuesserGenerator.generate(lead);
    expect(out.some((d) => d.includes('ristorante'))).toBe(true);
  });

  it('returns [] for empty name', () => {
    expect(HyperGuesserGenerator.generate(normalizeLead({ company_name: '' }))).toEqual([]);
  });

  it('filters out very short generated bases', () => {
    const out = HyperGuesserGenerator.generate(normalizeLead({ company_name: 'AB CD' }));
    expect(out.every((d) => d.length >= 4)).toBe(true);
  });
});

describe('HyperGuesser.run with mocked DNS', () => {
  it('returns only domains the resolver says are alive, sorted by generation rank', async () => {
    const aliveSet = new Set(['acme.it', 'milanoacme.it']);
    const fakeResolve = async (host: string) => (aliveSet.has(host) ? ['1.2.3.4'] : Promise.reject(new Error('ENOTFOUND')));
    const lead = normalizeLead({ company_name: 'Acme SRL', city: 'Milano' });
    const out = await HyperGuesser.run(lead, { resolve4: fakeResolve as never });
    expect(out.map((g) => g.domain).sort()).toEqual(['acme.it', 'milanoacme.it']);
    // generation_rank monotone
    for (let i = 1; i < out.length; i++) {
      expect(out[i].generation_rank).toBeGreaterThanOrEqual(out[i - 1].generation_rank);
    }
  });

  it('returns [] when no candidate resolves', async () => {
    const dead = async () => Promise.reject(new Error('ENOTFOUND'));
    const lead = normalizeLead({ company_name: 'Whatever SRL' });
    const out = await HyperGuesser.run(lead, { resolve4: dead as never });
    expect(out).toEqual([]);
  });
});
