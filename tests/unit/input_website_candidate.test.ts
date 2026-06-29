import { describe, it, expect } from 'vitest';
import { InputWebsiteCandidate } from '../../src/discovery/website/input_website_candidate';

describe('InputWebsiteCandidate.assess', () => {
  it('returns INVALID for empty input', () => {
    const r = InputWebsiteCandidate.assess(undefined);
    expect(r.classification).toBe('INVALID');
    expect(r.reason_code).toBeUndefined();
  });

  it('returns INVALID with reason_code for malformed input', () => {
    const r = InputWebsiteCandidate.assess('not a url');
    expect(r.classification).toBe('INVALID');
    expect(r.reason_code).toBe('INPUT_WEBSITE_INVALID');
  });

  it('classifies whatsapp as MESSAGING_OR_REDIRECT', () => {
    const r = InputWebsiteCandidate.assess('https://wa.me/393331234567');
    expect(r.classification).toBe('MESSAGING_OR_REDIRECT');
  });

  it('classifies linkedin as DIRECTORY_OR_SOCIAL', () => {
    const r = InputWebsiteCandidate.assess('https://linkedin.com/company/foo');
    expect(r.classification).toBe('DIRECTORY_OR_SOCIAL');
  });

  it('returns VALID with multiple candidates for bare domain', () => {
    const r = InputWebsiteCandidate.assess('example.com');
    expect(r.classification).toBe('VALID');
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates).toContain('https://example.com');
  });

  it('produces both http and https variants when input is http', () => {
    const r = InputWebsiteCandidate.assess('http://example.com/contatti');
    expect(r.candidates).toContain('http://example.com/contatti');
    expect(r.candidates).toContain('https://example.com/contatti');
    expect(r.candidates).toContain('https://example.com');
  });

  it('produces www and non-www variants', () => {
    const r = InputWebsiteCandidate.assess('https://www.example.it/');
    expect(r.candidates.some((c) => c.includes('www.example.it'))).toBe(true);
    expect(r.candidates.some((c) => c === 'https://example.it')).toBe(true);
  });

  it('rejects hostnames with no TLD', () => {
    expect(InputWebsiteCandidate.assess('http://localhost').classification).toBe('INVALID');
  });
});
