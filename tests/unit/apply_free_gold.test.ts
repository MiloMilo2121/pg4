import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { applyFreeGoldExtraction } from '../../src/enrichment/extract/apply_free_gold';
import type { Lead } from '../../src/types/lead';

const FIX = path.join(__dirname, '..', 'fixtures', 'extract');
const load = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8');

describe('applyFreeGoldExtraction — Phase 1', () => {
  it('no body → no-op (not applied)', () => {
    const lead: Lead = { company_name: 'X', official_website: 'https://x.it' };
    const r = applyFreeGoldExtraction(lead, undefined);
    expect(r.applied).toBe(false);
    expect(r.filled).toEqual([]);
  });

  it('fills empty fields from the body (email/pec/phone)', () => {
    const lead: Lead = { company_name: 'Neri', official_website: 'https://neriservizi.it' };
    const r = applyFreeGoldExtraction(lead, load('it_site_pec_and_phone.html'));
    expect(r.applied).toBe(true);
    expect(lead.email_inferred).toBe('contatti@neriservizi.it');
    expect(lead.email_type).toBe('business');
    expect(lead.pec).toBe('neriservizi@pec.it');
    expect(lead.phone).toBe('0422000177');
    expect(r.filled).toEqual(expect.arrayContaining(['email_inferred', 'pec', 'phone']));
  });

  it('fills social columns', () => {
    const lead: Lead = { company_name: 'Bianchi', official_website: 'https://bianchicase.it' };
    applyFreeGoldExtraction(lead, load('it_site_footer_socials.html'));
    expect(lead.instagram).toBe('https://instagram.com/agenziabianchi');
    expect(lead.facebook).toBe('https://facebook.com/agenziabianchicase');
    expect(lead.linkedin).toBe('https://linkedin.com/company/agenzia-bianchi');
  });

  it('promotes a checksum-valid P.IVA to vat_code_final when empty', () => {
    const lead: Lead = { company_name: 'Verdi', official_website: 'https://verdicostruzioni.it' };
    applyFreeGoldExtraction(lead, load('it_site_legal_footer_piva.html'));
    expect(lead.vat_code_final).toBe('01234567897');
  });

  it('NEVER overwrites a populated field (input wins)', () => {
    const lead: Lead = {
      company_name: 'Neri',
      official_website: 'https://neriservizi.it',
      phone: '0499999999',
      email_inferred: 'preset@neriservizi.it',
      vat_code_final: '99999999999',
    };
    applyFreeGoldExtraction(lead, load('it_site_pec_and_phone.html'));
    expect(lead.phone).toBe('0499999999'); // unchanged
    expect(lead.email_inferred).toBe('preset@neriservizi.it'); // unchanged
    expect(lead.vat_code_final).toBe('99999999999'); // unchanged
    expect(lead.pec).toBe('neriservizi@pec.it'); // pec was empty → filled
  });

  it('never throws on garbage body', () => {
    const lead: Lead = { company_name: 'X' };
    expect(() => applyFreeGoldExtraction(lead, '<<<')).not.toThrow();
  });
});
