import { describe, it, expect } from 'vitest';
import {
  parseImmobiliareAgencyItem,
  parseImmobiliareAdsItem,
  parseWikicasaItem,
  parsePortalItem,
} from '../../src/providers/apify/portal_parsers';

describe('portal parsers', () => {
  it('parses an immobiliare agency item (canonical keys)', () => {
    const rec = parseImmobiliareAgencyItem({
      name: 'Immobiliare Acme SRL',
      phone: '+39 049 1234567',
      email: 'INFO@ACME.IT',
      website: 'https://www.acme.it',
      city: 'Padova',
      province: 'PD',
      socials: ['https://instagram.com/acme?utm=1', 'https://facebook.com/acme'],
      listingsCount: 42,
      agencyUrl: 'https://www.immobiliare.it/agenzie-immobiliari/12/acme/',
    });
    expect(rec).toBeDefined();
    expect(rec!.portal).toBe('immobiliare');
    expect(rec!.email).toBe('info@acme.it');
    expect(rec!.instagram).toBe('https://instagram.com/acme');
    expect(rec!.facebook).toBe('https://facebook.com/acme');
    expect(rec!.website).toBe('https://www.acme.it');
    expect(rec!.listingsCount).toBe(42);
  });

  it('never echoes a portal/listing URL as the agency website', () => {
    const rec = parseImmobiliareAgencyItem({ name: 'Acme', website: 'https://www.immobiliare.it/agenzie/acme' });
    expect(rec!.website).toBeUndefined();
    const wk = parseWikicasaItem({ name: 'Acme', website: 'wikicasa.it/agenzia/acme' });
    expect(wk!.website).toBeUndefined();
  });

  it('normalizes a bare-host declared website to https', () => {
    const rec = parseWikicasaItem({ name: 'Acme', website: 'acme.it' });
    expect(rec!.website).toBe('https://acme.it');
  });

  it('parses the ads item flags (isPaid / fiaip / counts) from string-ish values', () => {
    const rec = parseImmobiliareAdsItem({ agencyName: 'Acme', totalAds: '17', premium: 'true', fiaip: false, telefono: '0491234567' });
    expect(rec!.listingsCount).toBe(17);
    expect(rec!.isPaid).toBe(true);
    expect(rec!.fiaip).toBe(false);
  });

  it('rejects invalid emails instead of attaching garbage', () => {
    const rec = parseImmobiliareAgencyItem({ name: 'Acme', email: 'not-an-email' });
    expect(rec!.email).toBeUndefined();
  });

  it('degrades to undefined on empty/garbage items — never throws', () => {
    expect(parseImmobiliareAgencyItem({})).toBeUndefined();
    expect(parseImmobiliareAdsItem(null)).toBeUndefined();
    expect(parseWikicasaItem('garbage')).toBeUndefined();
    expect(parsePortalItem('immobiliare', { unexpected: { nested: [1, 2] } })).toBeUndefined();
  });
});
