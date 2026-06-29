import { describe, it, expect } from 'vitest';
import { parseResolution, validatedSocial } from '../../src/enrichment/stages/perplexity_resolve_stage';

describe('parseResolution', () => {
  it('parses a plain JSON object', () => {
    const r = parseResolution('{"website":"https://x.it","vat":"01654010345"}');
    expect(r?.website).toBe('https://x.it');
    expect(r?.vat).toBe('01654010345');
  });
  it('strips ```json fences', () => {
    const r = parseResolution('```json\n{"website":"https://y.it"}\n```');
    expect(r?.website).toBe('https://y.it');
  });
  it('extracts JSON embedded in prose', () => {
    const r = parseResolution('Ecco i dati: {"instagram":"https://instagram.com/acme"} — fonti: …');
    expect(r?.instagram).toBe('https://instagram.com/acme');
  });
  it('returns undefined on garbage', () => {
    expect(parseResolution('no json here')).toBeUndefined();
    expect(parseResolution('')).toBeUndefined();
  });
});

describe('validatedSocial — anti-hallucination handle guard', () => {
  it('accepts a well-formed instagram handle', () => {
    expect(validatedSocial('https://instagram.com/studiorossi')?.key).toBe('instagram');
  });
  it('REJECTS a malformed instagram handle (hyphens/case the LLM invented)', () => {
    expect(validatedSocial('https://www.instagram.com/mediaCasa-immobiliare-padova')).toBeUndefined();
  });
  it('accepts a facebook /p/ page url', () => {
    const v = validatedSocial('https://facebook.com/p/MediaCasa-Immobiliare-Padova-61573056849387');
    expect(v?.key).toBe('facebook');
  });
  it('accepts a linkedin company/person url, rejects a non-social url', () => {
    expect(validatedSocial('https://it.linkedin.com/company/cbre-italy')?.key).toBe('linkedin');
    expect(validatedSocial('https://example.com/notsocial')).toBeUndefined();
  });
});
