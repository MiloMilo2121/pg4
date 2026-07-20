import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { extractFromBody, registrableDomain } from '../../src/enrichment/extract/extract_from_body';

/**
 * Phase 1 (free-gold) — the pure body extractor. Offline, deterministic,
 * fixture-driven. No network. Italian SMB page shapes.
 */

const FIX = path.join(__dirname, '..', 'fixtures', 'extract');
const load = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8');

describe('registrableDomain', () => {
  it('reduces host/URL to last two labels, strips www/scheme/path', () => {
    expect(registrableDomain('https://www.studiorossi.it/contatti')).toBe('studiorossi.it');
    expect(registrableDomain('mail.studiorossi.it')).toBe('studiorossi.it');
    expect(registrableDomain('studiorossi.it')).toBe('studiorossi.it');
    expect(registrableDomain(undefined)).toBeUndefined();
    expect(registrableDomain('localhost')).toBeUndefined();
  });
});

describe('extractFromBody — email', () => {
  it('keeps the same-domain business email, rejects 3rd-party (gmail)', () => {
    const ex = extractFromBody(load('it_site_mailto_footer.html'), { official_website: 'https://studiorossi.it' });
    // info@ or amministrazione@ — both on studiorossi.it; gmail rejected.
    expect(ex.email).toBeDefined();
    expect(ex.email!.endsWith('@studiorossi.it')).toBe(true);
    expect(ex.email).not.toContain('gmail');
  });

  it('with unknown own-domain, accepts the first non-PEC email (weak)', () => {
    const ex = extractFromBody(load('it_site_mailto_footer.html'), {});
    expect(ex.email).toBeDefined();
  });
});

describe('extractFromBody — V2 de-obfuscation', () => {
  it('decodes a Cloudflare data-cfemail address the text scan cannot see', () => {
    const ex = extractFromBody(load('it_site_cfemail.html'), { official_website: 'https://studiorossi.it' });
    expect(ex.email).toBe('info@studiorossi.it');
    // the only visible text is the "[email protected]" placeholder — proves decode
    expect(load('it_site_cfemail.html')).not.toContain('info@studiorossi.it');
  });

  it('reveals bracketed [at]/[dot]/(punto) emails, keeps PEC split', () => {
    const ex = extractFromBody(load('it_site_obfuscated_email.html'), { official_website: 'https://studiorossi.it' });
    expect(ex.email).toBe('info@studiorossi.it');
    expect(ex.pec).toBe('studiorossi@pec.it');
  });

  it('does NOT fabricate an email from bare " at "/" dot " in OWN-DOMAIN prose (precision)', () => {
    const ex = extractFromBody(load('it_site_obfuscated_email.html'), { official_website: 'https://studiorossi.it' });
    // "Ci trovi at studiorossi dot it" would fabricate trovi@studiorossi.it —
    // an OWN-DOMAIN address the domain filter cannot save us from.
    expect(ex.email).toBe('info@studiorossi.it');
    expect(ex.email).not.toContain('trovi@');
  });

  it('does NOT fabricate an email from an uppercase "(AT)" province sigla (Asti footer)', () => {
    const ex = extractFromBody(load('it_site_obfuscated_email.html'), { official_website: 'https://studiorossi.it' });
    // "14053 Canelli (AT) www.studiorossi.it" → canelli@www.studiorossi.it would
    // be own-domain and accepted; bracket tokens are lowercase-only by contract.
    expect(ex.email).toBe('info@studiorossi.it');
    expect(ex.email).not.toContain('canelli');
  });

  it('decodes the href-only Cloudflare variant (no data-cfemail attribute)', () => {
    // Cloudflare rewrites plain mailto: links to /cdn-cgi/l/email-protection#HEX
    // with NO data-cfemail attr — the href path must decode on its own.
    const hex = '422b2c242d02313637262b2d302d31312b6c2b36'; // info@studiorossi.it, key 0x42
    const html = `<html><body><a href="/cdn-cgi/l/email-protection#${hex}">[email protected]</a></body></html>`;
    const ex = extractFromBody(html, { official_website: 'https://studiorossi.it' });
    expect(ex.email).toBe('info@studiorossi.it');
  });

  it('ignores malformed data-cfemail payloads (odd length, non-hex, too short)', () => {
    const html = `<html><body>
      <span data-cfemail="zz9988">x</span>
      <span data-cfemail="422b2c2">x</span>
      <span data-cfemail="42">x</span>
    </body></html>`;
    const ex = extractFromBody(html, { official_website: 'https://studiorossi.it' });
    expect(ex.email).toBeUndefined();
  });
});

describe('extractFromBody — PEC + phone', () => {
  it('splits the PEC from the business email and captures the landline', () => {
    const ex = extractFromBody(load('it_site_pec_and_phone.html'), { official_website: 'https://neriservizi.it' });
    expect(ex.email).toBe('contatti@neriservizi.it');
    expect(ex.pec).toBe('neriservizi@pec.it');
    // phone normalised: +39 stripped, digits only
    expect(ex.phones).toContain('0422000177');
  });
});

describe('extractFromBody — socials', () => {
  it('captures profile/company URLs, rejects share-intent/post links', () => {
    const ex = extractFromBody(load('it_site_footer_socials.html'), { official_website: 'https://bianchicase.it' });
    expect(ex.instagram).toBe('https://instagram.com/agenziabianchi');
    expect(ex.facebook).toBe('https://facebook.com/agenziabianchicase');
    expect(ex.linkedin).toBe('https://linkedin.com/company/agenzia-bianchi');
    // none of them should be a share/post URL
    expect(ex.instagram).not.toContain('/p/');
    expect(ex.facebook).not.toContain('sharer');
    expect(ex.linkedin).not.toContain('shareArticle');
  });
});

describe('extractFromBody — VAT (checksum-gated)', () => {
  it('extracts the checksum-valid P.IVA, rejects the bad-checksum decoy', () => {
    const ex = extractFromBody(load('it_site_legal_footer_piva.html'), { official_website: 'https://verdicostruzioni.it' });
    expect(ex.vat_candidates).toContain('01234567897');
    expect(ex.vat_candidates).not.toContain('01234567890'); // decoy fails checksum
  });
});

describe('extractFromBody — no signal / robustness', () => {
  it('returns an empty extraction (no throw) on a blank page', () => {
    const ex = extractFromBody(load('no_signal.html'), { official_website: 'https://x.it' });
    expect(ex.email).toBeUndefined();
    expect(ex.pec).toBeUndefined();
    expect(ex.instagram).toBeUndefined();
    expect(ex.vat_candidates).toEqual([]);
    expect(ex.phones).toEqual([]);
  });

  it('never throws on empty/garbage input', () => {
    expect(() => extractFromBody(undefined, {})).not.toThrow();
    expect(() => extractFromBody('', {})).not.toThrow();
    expect(() => extractFromBody('<<<not html', {})).not.toThrow();
    expect(extractFromBody(undefined, {}).vat_candidates).toEqual([]);
  });
});

describe('extractFromBody — JSON-LD / Open Graph (schema v3)', () => {
  const JSONLD = `<!doctype html><html><head>
    <meta property="og:site_name" content="Studio Rossi Immobiliare" />
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'RealEstateAgent',
      name: 'Studio Rossi Immobiliare',
      email: 'info@studiorossi.it',
      telephone: '+39 049 1234567',
      vatID: '01654010345',
      foundingDate: '1998-06-01',
      founder: { '@type': 'Person', name: 'Mario Rossi' },
      sameAs: [
        'https://www.instagram.com/studiorossi',
        'https://www.facebook.com/studiorossi',
        'https://www.tiktok.com/@studiorossi',
        'https://www.youtube.com/@studiorossi',
        'https://www.linkedin.com/company/studio-rossi',
      ],
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.6', reviewCount: '128' },
    })}</script></head><body>Studio Rossi</body></html>`;

  it('mines sameAs into every social field incl. tiktok/youtube', () => {
    const ex = extractFromBody(JSONLD, { official_website: 'https://studiorossi.it' });
    expect(ex.instagram).toBe('https://instagram.com/studiorossi');
    expect(ex.facebook).toBe('https://facebook.com/studiorossi');
    expect(ex.tiktok).toBe('https://tiktok.com/@studiorossi');
    expect(ex.youtube).toBe('https://youtube.com/@studiorossi');
    expect(ex.linkedin).toBe('https://linkedin.com/company/studio-rossi');
  });

  it('mines name/email/vat/founder/year/rating from JSON-LD', () => {
    const ex = extractFromBody(JSONLD, { official_website: 'https://studiorossi.it' });
    expect(ex.site_name).toBe('Studio Rossi Immobiliare');
    expect(ex.email).toBe('info@studiorossi.it');
    expect(ex.vat_candidates).toContain('01654010345');
    expect(ex.founder).toBe('Mario Rossi');
    expect(ex.founding_year).toBe('1998');
    expect(ex.rating).toBe('4.6');
    expect(ex.reviews_count).toBe('128');
  });

  it('handles @graph arrays and falls back to og:site_name', () => {
    const graph = `<html><head><meta property="og:site_name" content="Acme SRL"/>
      <script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'WebSite' }, { '@type': 'Organization', sameAs: ['https://instagram.com/acme'] }] })}</script>
      </head><body></body></html>`;
    const ex = extractFromBody(graph, { official_website: 'https://acme.it' });
    expect(ex.instagram).toBe('https://instagram.com/acme');
    expect(ex.site_name).toBe('Acme SRL');
  });
});
