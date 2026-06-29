import { describe, it, expect } from 'vitest';
import { PgDetailHarvester } from '../../src/discovery/sources/pagine_gialle_detail_harvester';

/**
 * R1 — PgDetailHarvester unit tests. 0-network. Fixtures simulate
 * the structural shapes a real PG company-detail page exposes.
 */

const PG_URL = 'https://www.paginegialle.it/padova-pd/immobiliare/foo-srl';

function html(body: string): string {
  return `<html><head><title>Foo</title></head><body>${body}</body></html>`;
}

describe('PgDetailHarvester — gating', () => {
  it('rejects ricerca/ search pages (only company-detail pages allowed)', async () => {
    const h = new PgDetailHarvester({
      fetchHtml: async () => ({ status: 200, html: html('<a>x</a>') }),
    });
    const r = await h.harvest('https://www.paginegialle.it/ricerca/?keyword=foo');
    expect(r).toBeNull();
  });

  it('rejects non-PG hosts', async () => {
    const h = new PgDetailHarvester({
      fetchHtml: async () => ({ status: 200, html: '<html/>' }),
    });
    const r = await h.harvest('https://www.example.com/foo');
    expect(r).toBeNull();
  });

  it('returns null on HTTP error', async () => {
    const h = new PgDetailHarvester({
      fetchHtml: async () => ({ status: 503 }),
    });
    expect(await h.harvest(PG_URL)).toBeNull();
  });

  it('caches per pg_url within the run', async () => {
    let calls = 0;
    const h = new PgDetailHarvester({
      fetchHtml: async () => {
        calls++;
        return { status: 200, html: html('<h1>Foo</h1>') };
      },
    });
    await h.harvest(PG_URL);
    await h.harvest(PG_URL);
    await h.harvest(PG_URL + '/');
    expect(calls).toBe(1); // trailing slash normalized
  });
});

describe('PgDetailHarvester — extractCompanyDetails', () => {
  it('extracts CTA website + JSON-LD vatID/email/phone/name', () => {
    const body = `
      <a data-tr="scheda_azienda__cta_sitoweb" href="https://www.foosrl.com/contatti">Sito web</a>
      <script type="application/ld+json">
        ${JSON.stringify({
          '@type': 'LocalBusiness',
          name: 'Foo S.r.l.',
          telephone: '+39 049 1234567',
          email: 'info@foosrl.com',
          vatID: 'IT01234567890',
        })}
      </script>
      <h1>Foo S.r.l.</h1>
      <div class="sede__indirizzo">Via Roma 1, 35100 Padova (PD)</div>`;
    const r = PgDetailHarvester.extractCompanyDetails(html(body), PG_URL);
    expect(r).not.toBeNull();
    expect(r!.official_website).toBe('https://www.foosrl.com/contatti');
    expect(r!.vat_code).toBe('01234567890');
    expect(r!.email).toBe('info@foosrl.com');
    expect(r!.phone).toBe('+39 049 1234567');
    expect(r!.name).toBe('Foo S.r.l.');
    expect(r!.address).toContain('Via Roma 1');
  });

  it('rejects directory/social hrefs as official_website', () => {
    const body = `
      <a data-tr="scheda_azienda__cta_sitoweb" href="https://www.facebook.com/foosrl">Sito web</a>
      <a data-tr="alt" href="https://atoka.io/public/it/azienda/foo">Sito web</a>
      <h1>Foo</h1>`;
    const r = PgDetailHarvester.extractCompanyDetails(html(body), PG_URL);
    expect(r!.official_website).toBeUndefined();
    expect(r!.name).toBe('Foo');
  });

  it('rejects mailto: / tel: / javascript: hrefs', () => {
    const body = `
      <a data-tr="scheda_azienda__cta_sitoweb" href="mailto:info@foo.it">Sito web</a>
      <a title="Sito web" href="tel:+39049123">Sito web</a>
      <a href="javascript:void(0)">Sito web</a>
      <h1>Foo</h1>`;
    const r = PgDetailHarvester.extractCompanyDetails(html(body), PG_URL);
    expect(r!.official_website).toBeUndefined();
  });

  it('falls back to regex when JSON-LD is missing', () => {
    // Body padded so the >200 byte threshold passes.
    const body = `
      <h1>Foo</h1>
      <div>Lorem ipsum dolor sit amet ${'x'.repeat(180)}
        "vatID":"IT09876543210" "email":"contact@foo.it" "telephone":"+39 049 999"
      </div>`;
    const r = PgDetailHarvester.extractCompanyDetails(html(body), PG_URL);
    expect(r).not.toBeNull();
    expect(r!.vat_code).toBe('09876543210');
    expect(r!.email).toBe('contact@foo.it');
    expect(r!.phone).toBe('+39 049 999');
  });

  it('returns null on tiny / empty HTML', () => {
    expect(PgDetailHarvester.extractCompanyDetails('', PG_URL)).toBeNull();
    expect(PgDetailHarvester.extractCompanyDetails('<html><body>x</body></html>', PG_URL)).toBeNull();
  });
});

describe('PgDetailHarvester — isLikelyOfficialWebsiteUrl', () => {
  it('rejects empty / non-http / mailto / javascript', () => {
    for (const bad of ['', 'mailto:foo@bar.it', 'tel:+39049', 'javascript:alert(1)', 'ftp://foo']) {
      expect(PgDetailHarvester.isLikelyOfficialWebsiteUrl(bad)).toBe(false);
    }
  });

  it('rejects directory/social hosts', () => {
    for (const url of [
      'https://www.paginegialle.it/foo',
      'https://www.facebook.com/foo',
      'https://www.linkedin.com/in/foo',
      'https://atoka.io/public/foo',
      'https://cercacasa.it/foo',
    ]) {
      expect(PgDetailHarvester.isLikelyOfficialWebsiteUrl(url)).toBe(false);
    }
  });

  it('accepts plausible non-directory company URLs', () => {
    for (const url of [
      'https://www.foosrl.com',
      'https://www.foosrl.it/contatti',
      'https://immobiliare-pierobon.com/',
    ]) {
      expect(PgDetailHarvester.isLikelyOfficialWebsiteUrl(url)).toBe(true);
    }
  });
});
