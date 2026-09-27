import { describe, it, expect } from 'vitest';
import { ApifyProvider } from '../../src/providers/apify/apify_provider';
import { buildEmailVerifyInput, verifyInChunks } from '../../src/scripts/enrich3/email_verify';
import { isPecAddress } from '../../src/enrichment/extract/pec';
import type { Lead } from '../../src/types/lead';

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
    expect(isPecAddress('info@pec.it')).toBe(true);
    expect(isPecAddress('acme@studio.pec.it')).toBe(true);
    expect(isPecAddress('acme@legalmail.it')).toBe(true);
    expect(isPecAddress('acme@arubapec.it')).toBe(true);
    expect(isPecAddress('info@acme.it')).toBe(false);
    expect(isPecAddress('acme@gmail.com')).toBe(false);
  });

  it('the actor input builder is the single overridable place', () => {
    expect(buildEmailVerifyInput(['a@b.it', 'c@d.it'])).toEqual({ emails: ['a@b.it', 'c@d.it'] });
  });
});

describe('verifyInChunks', () => {
  it('a failed chunk is skipped, NOT fatal: later chunks still run', async () => {
    const emails = ['a@x.it', 'b@x.it', 'c@x.it', 'd@x.it'];
    const seen: number[] = [];
    const statusByEmail = new Map<string, Lead['email_status']>();
    const res = await verifyInChunks(emails, 1, async (chunk, index) => {
      seen.push(index);
      if (index === 1) return null; // gated / transient failure / empty
      return chunk.map((email) => ({ email, status: 'valid' }));
    }, statusByEmail);
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(res).toEqual({ verified: 3, failedChunks: 1 });
    expect(statusByEmail.get('c@x.it')).toBe('deliverable');
    expect(statusByEmail.get('d@x.it')).toBe('deliverable');
    expect(statusByEmail.has('b@x.it')).toBe(false);
  });
});
