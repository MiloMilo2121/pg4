import { describe, it, expect } from 'vitest';
import { ApifyProvider } from '../../src/providers/apify/apify_provider';
import { PEC_DOMAINS, buildEmailVerifyInput } from '../../src/scripts/enrich3/email_verify';

describe('parseEmailVerifyItem', () => {
  const parse = ApifyProvider.parseEmailVerifyItem;

  it('maps the common marketplace vocabularies', () => {
    expect(parse({ email: 'A@Acme.IT', status: 'valid' })).toEqual({ email: 'a@acme.it', status: 'deliverable' });
    expect(parse({ email: 'a@b.it', result: 'deliverable' }).status).toBe('deliverable');
    expect(parse({ email: 'a@b.it', status: 'undeliverable' }).status).toBe('invalid');
    expect(parse({ email: 'a@b.it', verdict: 'bounced' }).status).toBe('invalid');
    expect(parse({ email: 'a@b.it', status: 'risky' }).status).toBe('unknown');
  });

  it('catch-all wins over the raw verdict', () => {
    expect(parse({ email: 'a@b.it', status: 'valid', catchAll: true }).status).toBe('catch_all');
    expect(parse({ email: 'a@b.it', status: 'accept_all' }).status).toBe('catch_all');
  });

  it('anything unrecognized is unknown — NEVER a false invalid', () => {
    expect(parse({ email: 'a@b.it', status: 'weird-new-state' }).status).toBe('unknown');
    expect(parse({}).status).toBe('unknown');
    expect(parse(null).email).toBeUndefined();
  });
});

describe('email_verify free shortcuts', () => {
  it('PEC domains are recognized (with and without subdomain)', () => {
    expect(PEC_DOMAINS.test('info@pec.it')).toBe(true);
    expect(PEC_DOMAINS.test('acme@studio.pec.it')).toBe(true);
    expect(PEC_DOMAINS.test('acme@legalmail.it')).toBe(true);
    expect(PEC_DOMAINS.test('acme@arubapec.it')).toBe(true);
    expect(PEC_DOMAINS.test('info@acme.it')).toBe(false);
    expect(PEC_DOMAINS.test('acme@gmail.com')).toBe(false);
  });

  it('the actor input builder is the single overridable place', () => {
    expect(buildEmailVerifyInput(['a@b.it', 'c@d.it'])).toEqual({ emails: ['a@b.it', 'c@d.it'] });
  });
});
