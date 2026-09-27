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

  it('keeps real agency sites whose NAME contains a portal name (host match, not substring)', () => {
    expect(parseWikicasaItem({ name: 'Rossi', website: 'https://www.rossiimmobiliare.it' })!.website).toBe('https://www.rossiimmobiliare.it');
    expect(parseWikicasaItem({ name: 'Mia Casa', website: 'miacasa.it' })!.website).toBe('https://miacasa.it');
    expect(parseImmobiliareAgencyItem({ name: 'Acme', website: 'https://maps.google.com/?cid=1' })!.website).toBeUndefined();
    expect(parseImmobiliareAgencyItem({ name: 'Acme', website: 'https://www.google.it/maps/place/Acme' })!.website).toBeUndefined();
    // Maps on any Google ccTLD, not just the .com/.it in the directory list
    expect(parseImmobiliareAgencyItem({ name: 'Acme', website: 'https://www.google.de/maps/place/Acme' })!.website).toBeUndefined();
    expect(parseImmobiliareAgencyItem({ name: 'Acme', website: 'https://maps.google.fr/?cid=1' })!.website).toBeUndefined();
    expect(parseImmobiliareAgencyItem({ name: 'Acme', website: 'https://www.google.co.uk/maps/place/X' })!.website).toBeUndefined();
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

  it('parses the REAL immobiliare.it shape: phones objects (virtual excluded), location, realEstateAds, isPaid', () => {
    const rec = parseImmobiliareAgencyItem({
      name: 'Esempio Group Real Estate',
      phones: [
        { type: 'vtel', value: '02 0000 2188', formattedValues: '+390200002188', isVirtual: true },
        { type: 'tel1', value: '02 0000 8590', formattedValues: '+390200008590', isVirtual: false },
      ],
      location: { city: { name: 'Milano' }, province: { id: 'MI' } },
      realEstateAds: 409,
      isPaid: true,
      emails: ['acme.srl@lamiapec.it'],
      url: 'https://www.immobiliare.it/agenzie-immobiliari/000001/esempio/',
    });
    expect(rec!.phone).toBe('+390200008590'); // the REAL line — never the virtual tracking number
    expect(rec!.city).toBe('Milano');
    expect(rec!.province).toBe('MI');
    expect(rec!.listingsCount).toBe(409);
    expect(rec!.isPaid).toBe(true);
    expect(rec!.email).toBe('acme.srl@lamiapec.it');
  });

  it('parses the REAL wikicasa shape: company_name, city_name, premium/#ads — and NO truncated phone', () => {
    const rec = parseWikicasaItem({
      name: 'Gambaro',
      company_name: 'GAMBARO INTERMEDIAZIONI COMMERCIALI SNC DI GAMBARO EDOARDO & C',
      city_name: 'Venezia',
      zip: '30173',
      hidden_display_phone: '041531',
      io_vox_phone: null,
      website: 'www.intermediazionicommerciali.it',
      active_real_estates: 92,
      premium: true,
      from_url: 'https://www.wikicasa.it/agenzie-immobiliari/regione-veneto/',
    });
    expect(rec!.name).toContain('GAMBARO');
    expect(rec!.city).toBe('Venezia');
    expect(rec!.phone).toBeUndefined(); // truncated hidden_display_phone must never become a phone key
    expect(rec!.website).toBe('https://www.intermediazionicommerciali.it');
    expect(rec!.listingsCount).toBe(92);
    expect(rec!.isPaid).toBe(true);
  });

  it('an all-virtual phone list yields no phone at all', () => {
    const rec = parseImmobiliareAgencyItem({
      name: 'Acme',
      phones: [{ type: 'vtel', formattedValues: '+39028295', isVirtual: true }],
    });
    expect(rec!.phone).toBeUndefined();
  });

  it('degrades to undefined on empty/garbage items — never throws', () => {
    expect(parseImmobiliareAgencyItem({})).toBeUndefined();
    expect(parseImmobiliareAdsItem(null)).toBeUndefined();
    expect(parseWikicasaItem('garbage')).toBeUndefined();
    expect(parsePortalItem('immobiliare', { unexpected: { nested: [1, 2] } })).toBeUndefined();
  });
});
