import { describe, it, expect } from 'vitest';
import { generateCandidates, toAsciiDomain } from '../../src/enrichment/email/pattern_inference';

describe('email pattern inference — generateCandidates', () => {
  it('always emits role inboxes, highest prior first (info before contatti)', () => {
    const c = generateCandidates({ domain: 'rossi.it' });
    const locals = c.map((x) => x.localPart);
    expect(locals).toContain('info');
    expect(locals).toContain('contatti');
    expect(locals.indexOf('info')).toBeLessThan(locals.indexOf('contatti'));
    // role-only when no person name available
    expect(c.every((x) => x.pattern === 'role')).toBe(true);
    expect(c[0].email).toBe('info@rossi.it');
  });

  it('emits person patterns ONLY when a person name is supplied', () => {
    const withName = generateCandidates({ domain: 'studio.it', personName: 'Mario Rossi' });
    const locals = withName.map((x) => x.localPart);
    expect(locals).toContain('mario.rossi');
    expect(locals).toContain('m.rossi');
    expect(locals).toContain('mariorossi');
    expect(locals).toContain('rossi');
    // role inboxes still lead (higher prior)
    expect(locals.indexOf('info')).toBeLessThan(locals.indexOf('mario.rossi'));
  });

  it('strips accents and apostrophes from person locals', () => {
    const c = generateCandidates({ domain: 'x.it', personName: "Niccolò D'Angelo" });
    const locals = c.map((x) => x.localPart);
    expect(locals).toContain('niccolo.dangelo');
    expect(locals.some((l) => /[^a-z0-9._-]/.test(l))).toBe(false);
  });

  it('infers a person from a company name that IS a person (no descriptor)', () => {
    const c = generateCandidates({ domain: 'mr.it', companyName: 'Mario Rossi' });
    expect(c.map((x) => x.localPart)).toContain('mario.rossi');
  });

  it('does NOT invent a person from a descriptor company name', () => {
    const c = generateCandidates({ domain: 'imm.it', companyName: 'Immobiliare Rossi SRL' });
    // "immobiliare" is a descriptor → not a person → role inboxes only
    expect(c.every((x) => x.pattern === 'role')).toBe(true);
  });

  it('de-duplicates local parts and rejects invalid domains', () => {
    expect(generateCandidates({ domain: 'no-dot' })).toEqual([]);
    expect(generateCandidates({ domain: '' })).toEqual([]);
    const c = generateCandidates({ domain: 'rossi.it' });
    expect(new Set(c.map((x) => x.localPart)).size).toBe(c.length);
  });
});

describe('toAsciiDomain (IDN/punycode)', () => {
  it('lowercases and trims a normal domain', () => {
    expect(toAsciiDomain('  Rossi.IT ')).toBe('rossi.it');
  });
  it('converts an IDN domain to punycode', () => {
    expect(toAsciiDomain('caffè.it')).toBe('xn--caff-8oa.it');
  });
  it('returns undefined for a bare label', () => {
    expect(toAsciiDomain('localhost')).toBeUndefined();
  });
});
