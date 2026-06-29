import { describe, it, expect, afterEach } from 'vitest';
import { ApifyProvider } from '../../src/providers/apify/apify_provider';
import { resetEnvCache } from '../../src/config/env';

afterEach(() => {
  for (const k of ['APIFY_ENABLED', 'APIFY_API_KEY', 'APIFY_MAPS_ENABLED', 'APIFY_INSTAGRAM_ENABLED']) delete process.env[k];
  resetEnvCache();
});

describe('ApifyProvider.parseRegistroItem', () => {
  it('maps a regdata register item to RegistroRecord (utile, NOT revenue)', () => {
    const r = ApifyProvider.parseRegistroItem({
      denominazione: 'FERRARI S.P.A.',
      formaGiuridica: 'SOCIETA\' PER AZIONI',
      atecoCode: '291',
      atecoDescription: 'Fabbricazione di autoveicoli',
      capitaleSociale: '€ 20.260.000,00',
      utile: '€ 1.619.983.155,00',
      utileAnno: '2025',
      dipendenti: 5186,
      pec: 'ferrari@pec.ferrari.com',
      rea: '88683',
      indirizzo: 'VIA EMILIA EST 1163 - MODENA',
    });
    expect(r.name).toBe('FERRARI S.P.A.');
    expect(r.legal_form).toBe('SOCIETA\' PER AZIONI');
    expect(r.ateco).toBe('291 — Fabbricazione di autoveicoli');
    expect(r.net_profit).toBe('€ 1.619.983.155,00');
    expect(r.net_profit_year).toBe('2025');
    expect(r.employees).toBe('5186');
    expect(r.pec).toBe('ferrari@pec.ferrari.com');
    expect(r.rea).toBe('88683');
  });
  it('never throws on garbage / empty', () => {
    expect(ApifyProvider.parseRegistroItem(null).name).toBeUndefined();
    expect(ApifyProvider.parseRegistroItem({}).net_profit).toBeUndefined();
  });
});

describe('ApifyProvider.parseMapsItem', () => {
  it('maps a full Google-Maps actor item to MapsPlace', () => {
    const p = ApifyProvider.parseMapsItem({
      title: 'Studio Rossi Immobiliare',
      website: 'https://studiorossi.it',
      phone: '+39 049 1234567',
      totalScore: 4.6,
      reviewsCount: 128,
      categoryName: 'Agenzia immobiliare',
      address: 'Via Roma 1, Padova',
      instagrams: ['https://instagram.com/studiorossi'],
      facebooks: ['https://facebook.com/studiorossi'],
    });
    expect(p).toMatchObject({
      name: 'Studio Rossi Immobiliare',
      website: 'https://studiorossi.it',
      phone: '+39 049 1234567',
      rating: '4.6',
      reviews_count: '128',
      instagram: 'https://instagram.com/studiorossi',
      facebook: 'https://facebook.com/studiorossi',
    });
  });

  it('tolerates alternate field names + missing fields', () => {
    const p = ApifyProvider.parseMapsItem({ name: 'Acme', rating: 3.9, website: 'acme.it' });
    expect(p.name).toBe('Acme');
    expect(p.rating).toBe('3.9');
    expect(p.website).toBe('acme.it');
    expect(p.instagram).toBeUndefined();
  });

  it('NEVER uses the Google-Maps listing url as the website (false-positive guard)', () => {
    // A business with no site: actor leaves `website` empty, `url` is the maps link.
    const p = ApifyProvider.parseMapsItem({
      name: 'Skyline',
      rating: 4.4,
      reviewsCount: 39,
      url: 'https://www.google.com/maps/search/?api=1&query=Skyline&query_place_id=ChIJ123',
    });
    expect(p.website).toBeUndefined(); // maps url rejected
    expect(p.rating).toBe('4.4'); // but reputation still captured
    expect(p.reviews_count).toBe('39');
  });

  it('never throws on garbage', () => {
    expect(() => ApifyProvider.parseMapsItem(null)).not.toThrow();
    expect(ApifyProvider.parseMapsItem(undefined).name).toBeUndefined();
  });
});

describe('ApifyProvider gating', () => {
  it('available() needs APIFY_ENABLED + key; actorAvailable() needs the per-actor flag', () => {
    process.env.APIFY_ENABLED = 'true';
    process.env.APIFY_API_KEY = 'tok_xxx';
    process.env.APIFY_MAPS_ENABLED = 'true';
    resetEnvCache();
    const prov = new ApifyProvider();
    expect(prov.available()).toBe(true);
    expect(prov.actorAvailable('maps')).toBe(true);
    expect(prov.actorAvailable('instagram')).toBe(false); // RED actor: own flag off
    expect(prov.meta('maps').costPerCallEur).toBeGreaterThan(0);
    expect(prov.meta('maps').tier).toBe(2);
  });

  it('available() is false without a key', () => {
    process.env.APIFY_ENABLED = 'true';
    resetEnvCache();
    expect(new ApifyProvider().available()).toBe(false);
  });

  it('runActorSync calls run-sync-get-dataset-items and returns the items', async () => {
    process.env.APIFY_ENABLED = 'true';
    process.env.APIFY_API_KEY = 'tok_xxx';
    process.env.APIFY_MAPS_ENABLED = 'true';
    resetEnvCache();
    let calledUrl = '';
    const prov = new ApifyProvider(async (url) => {
      calledUrl = url;
      return { status: 200, json: [{ title: 'Acme', totalScore: 4.1 }] };
    });
    const place = await prov.mapsLookup('Acme', 'Padova');
    expect(calledUrl).toContain('/acts/compass~crawler-google-places/run-sync-get-dataset-items');
    expect(calledUrl).toContain('token=tok_xxx');
    expect(place?.name).toBe('Acme');
    expect(place?.rating).toBe('4.1');
  });
});
