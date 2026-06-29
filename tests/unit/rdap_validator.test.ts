import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { RdapValidator } from '../../src/discovery/website/rdap_validator';
import { normalizeLead } from '../../src/discovery/input_normalizer';

const fixt = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8'));

describe('RdapValidator.score', () => {
  it('returns 0.9 piva_in_payload when P.IVA appears in JSON', () => {
    const payload = fixt('rdap_acme_piva.json');
    const lead = normalizeLead({ company_name: 'Acme Italia SRL', vat_code: '12345678901' });
    const r = RdapValidator.score(payload, lead);
    expect(r.evidence).toBe('piva_in_payload');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('returns 0.4 name_in_vcard for strong vCard fn match', () => {
    const payload = fixt('rdap_acme_piva.json');
    // Same fixture but pretend we don't know the P.IVA — score the name only.
    const lead = normalizeLead({ company_name: 'Acme Italia SRL' });
    const r = RdapValidator.score(payload, lead);
    expect(r.evidence).toBe('name_in_vcard');
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it('returns 0 for unrelated registrant payload', () => {
    const payload = fixt('rdap_unrelated.json');
    const lead = normalizeLead({ company_name: 'Acme Italia SRL', vat_code: '99999999999' });
    const r = RdapValidator.score(payload, lead);
    expect(r.evidence).toBe('none');
    expect(r.confidence).toBe(0);
  });

  it('returns 0 for null/empty payload', () => {
    const lead = normalizeLead({ company_name: 'Acme' });
    expect(RdapValidator.score(null, lead).confidence).toBe(0);
    expect(RdapValidator.score({}, lead).confidence).toBe(0);
  });

  it('does not match on tokens shorter than 3 chars', () => {
    const payload = { entities: [{ vcardArray: ['vcard', [['fn', {}, 'text', 'x y z']]] }] };
    const lead = normalizeLead({ company_name: 'A B C' });
    expect(RdapValidator.score(payload, lead).confidence).toBe(0);
  });
});
