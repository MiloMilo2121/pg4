import { describe, it, expect } from 'vitest';
import { isPecAddress } from '../../src/enrichment/extract/pec';
import { normalizeLead } from '../../src/discovery/input_normalizer';
import type { Lead } from '../../src/types/lead';

describe('isPecAddress — one anchored PEC test for the whole codebase', () => {
  it.each([
    'info@pec.it',
    'acme@studio.pec.it',
    'amministrazione@pec.acme.it',
    'acme@pec.aruba.it',
    'acme@arubapec.it',
    'acme@legalmail.it',
    'acme@cert.legalmail.it',
    'acme@lamiapec.it',
    'acme@postecert.it',
    'acme@pec.libero.it',
    'acme@mypec.eu',
    'acme@pec.cloud',
    'ACME@PEC.IT',
    // provider brands whose label ENDS in "pec"
    'agenzia@registerpec.it',
    'agenzia@casellapec.com',
    'agenzia@gigapec.it',
    'agenzia@sicurpec.it',
    'agenzia@emailcertificatapec.it',
    // non-"pec" provider labels
    'agenzia@pecsicura.it',
    'ente@legalmailpa.it',
    'agenzia@actaliscertymail.it',
  ])('PEC: %s', (email) => {
    expect(isPecAddress(email)).toBe(true);
  });

  it.each([
    'info@speciale.it',
    'info@pecoraimmobiliare.it',
    'sales@spectrum.it',
    'booking@concert.it',
    'info@acme.it',
    'acme@gmail.com',
    'pec@acme.it', // local part is irrelevant
    '',
  ])('NOT PEC: %s', (email) => {
    expect(isPecAddress(email)).toBe(false);
  });

  it('handles null/undefined', () => {
    expect(isPecAddress(undefined)).toBe(false);
    expect(isPecAddress(null)).toBe(false);
  });

  it('input normalizer keeps a business domain that merely CONTAINS "pec"/"cert"', () => {
    expect(normalizeLead({ company_name: 'Specchi Srl', email: 'info@speciale.it' } as Lead).email_domain).toBe('speciale.it');
    expect(normalizeLead({ company_name: 'Concerti Srl', email: 'info@concerto.it' } as Lead).email_domain).toBe('concerto.it');
    expect(normalizeLead({ company_name: 'Acme Srl', email: 'acme@pec.it' } as Lead).email_domain).toBeUndefined();
  });
});
