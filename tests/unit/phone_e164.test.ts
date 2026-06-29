import { describe, expect, it } from 'vitest';
import { normalizePhoneE164, normalizeLeadPhone } from '../../src/discovery/phone';

describe('normalizePhoneE164 — Phase C.2', () => {
  it('landline with spaces → +39 keeping the leading 0', () => {
    expect(normalizePhoneE164('0422 000177')).toEqual({ e164: '+390422000177', kind: 'landline' });
  });

  it('mobile with +39 prefix already', () => {
    expect(normalizePhoneE164('+39 339 0005503')).toEqual({ e164: '+393390005503', kind: 'mobile' });
  });

  it('0039 international prefix', () => {
    expect(normalizePhoneE164('0039 049 8761234')).toEqual({ e164: '+390498761234', kind: 'landline' });
  });

  it('bare 39-prefixed string treated as country code only when remainder is plausible', () => {
    // "39 0422 000177" → country code + landline
    expect(normalizePhoneE164('39 0422 000177')).toEqual({ e164: '+390422000177', kind: 'landline' });
  });

  it('mobile written without country code', () => {
    expect(normalizePhoneE164('348 0000591')).toEqual({ e164: '+393480000591', kind: 'mobile' });
  });

  it('formatting variants (dots, dashes, slashes) are stripped', () => {
    expect(normalizePhoneE164('049/876.12-34')).toEqual({ e164: '+390498761234', kind: 'landline' });
  });

  it('toll/service numbers normalize with kind=service', () => {
    expect(normalizePhoneE164('800 123456')).toEqual({ e164: '+39800123456', kind: 'service' });
  });

  it('garbage / too short / too long → undefined (conservative)', () => {
    expect(normalizePhoneE164('call me')).toBeUndefined();
    expect(normalizePhoneE164('12345')).toBeUndefined();
    expect(normalizePhoneE164('0422000177001122334455')).toBeUndefined();
    expect(normalizePhoneE164('')).toBeUndefined();
    expect(normalizePhoneE164(undefined)).toBeUndefined();
  });

  it('foreign-looking prefixes are left alone', () => {
    expect(normalizePhoneE164('+44 20 7946 0958')).toBeUndefined();
  });
});

describe('normalizeLeadPhone — Phase C.2', () => {
  it('moves the original to phone_raw and replaces phone with E.164', () => {
    const lead = { phone: '0422 000177' };
    normalizeLeadPhone(lead);
    expect(lead.phone).toBe('+390422000177');
    expect((lead as { phone_raw?: string }).phone_raw).toBe('0422 000177');
  });

  it('leaves unparseable phones untouched (no phone_raw)', () => {
    const lead = { phone: 'numero verde' };
    normalizeLeadPhone(lead);
    expect(lead.phone).toBe('numero verde');
    expect((lead as { phone_raw?: string }).phone_raw).toBeUndefined();
  });

  it('idempotent: a second call does not double-wrap', () => {
    const lead: { phone?: string; phone_raw?: string } = { phone: '0422 000177' };
    normalizeLeadPhone(lead);
    const after = { ...lead };
    normalizeLeadPhone(lead);
    expect(lead).toEqual(after);
  });
});
