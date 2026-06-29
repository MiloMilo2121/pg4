import { describe, it, expect } from 'vitest';
import {
  classifyCandidate,
  partitionSerpCandidates,
  harvestGenericRegistryEvidence,
} from '../../src/discovery/website/serp_evidence';

/**
 * R3 — `serp_evidence` 0-network unit tests.
 *
 * The module is pure: input is URL strings or static HTML, output is
 * classification + extracted evidence. We test:
 *   - the three-bucket classifier (official / registry / noise)
 *   - registry_id mapping for known registries
 *   - generic JSON-LD + regex extraction
 *   - regex fallbacks (visible "P.IVA 01234567890" / loose email)
 *   - tiny-HTML / empty-evidence guards
 */

describe('classifyCandidate', () => {
  it('classifies plausible company URLs as OFFICIAL_CANDIDATE', () => {
    for (const u of [
      'https://www.foosrl.com',
      'https://www.foosrl.it/contatti',
      'https://immobiliare-pierobon.com/',
    ]) {
      expect(classifyCandidate(u).classification).toBe('OFFICIAL_CANDIDATE');
    }
  });

  it('classifies extractable registries as REGISTRY_EVIDENCE with the right id', () => {
    expect(classifyCandidate('https://www.paginegialle.it/foo').classification).toBe('REGISTRY_EVIDENCE');
    expect(classifyCandidate('https://www.paginegialle.it/foo').registry_id).toBe('paginegialle');
    expect(classifyCandidate('https://www.fatturatoitalia.it/foo').registry_id).toBe('fatturatoitalia');
    expect(classifyCandidate('https://www.reportaziende.it/foo').registry_id).toBe('reportaziende');
    expect(classifyCandidate('https://www.guidatitolari.it/foo').registry_id).toBe('guidatitolari');
    expect(classifyCandidate('https://www.visura.pro/foo').registry_id).toBe('visura');
    expect(classifyCandidate('https://www.registroimprese.it/foo').registry_id).toBe('registroimprese');
    expect(classifyCandidate('https://www.ufficiocamerale.it/foo').registry_id).toBe('ufficiocamerale');
  });

  it('classifies pure directory/social URLs as DIRECTORY_NOISE', () => {
    for (const u of [
      'https://www.facebook.com/foo',
      'https://www.linkedin.com/in/foo',
      'https://www.atoka.io/public/it/azienda/foo',
      'https://www.cercacasa.it/agenzia/foo',
      'https://www.companyreports.it/foo',
    ]) {
      expect(classifyCandidate(u).classification).toBe('DIRECTORY_NOISE');
    }
  });

  it('returns DIRECTORY_NOISE for malformed URLs', () => {
    expect(classifyCandidate('not-a-url').classification).toBe('DIRECTORY_NOISE');
    expect(classifyCandidate('').classification).toBe('DIRECTORY_NOISE');
  });

  it('handles subdomains of registries (e.g. www. / region. variants)', () => {
    expect(classifyCandidate('https://aziende.fatturatoitalia.it/foo').classification).toBe('REGISTRY_EVIDENCE');
    expect(classifyCandidate('https://aziende.fatturatoitalia.it/foo').registry_id).toBe('fatturatoitalia');
  });
});

describe('partitionSerpCandidates', () => {
  it('splits a mixed list into three buckets', () => {
    const urls = [
      'https://www.foosrl.com',           // official
      'https://www.paginegialle.it/foo',  // registry
      'https://www.facebook.com/foo',     // noise
      'https://www.bar.it',                // official
      'https://www.fatturatoitalia.it/x', // registry
    ];
    const r = partitionSerpCandidates(urls);
    expect(r.official.map((c) => c.host)).toEqual(['foosrl.com', 'bar.it']);
    expect(r.registry.map((c) => c.registry_id)).toEqual(['paginegialle', 'fatturatoitalia']);
    expect(r.noise.map((c) => c.host)).toEqual(['facebook.com']);
  });

  it('returns empty buckets for an empty input', () => {
    const r = partitionSerpCandidates([]);
    expect(r.official).toEqual([]);
    expect(r.registry).toEqual([]);
    expect(r.noise).toEqual([]);
  });
});

describe('harvestGenericRegistryEvidence — JSON-LD path', () => {
  const URL = 'https://www.fatturatoitalia.it/azienda/foo-srl';
  const longBody = (extra: string) =>
    `<html><body>${'<p>x</p>'.repeat(40)}${extra}</body></html>`;

  it('extracts vatID/email/telephone/name/address from JSON-LD', () => {
    const html = longBody(`
      <script type="application/ld+json">
        ${JSON.stringify({
          '@type': 'Organization',
          name: 'Foo S.r.l.',
          vatID: 'IT01234567890',
          telephone: '+39 049 1234567',
          email: 'info@foosrl.com',
          address: 'Via Roma 1, 35100 Padova (PD)',
        })}
      </script>
      <h1>Foo S.r.l.</h1>
    `);
    const r = harvestGenericRegistryEvidence(URL, html);
    expect(r).not.toBeNull();
    expect(r!.registry_id).toBe('fatturatoitalia');
    expect(r!.vat_code).toBe('01234567890');
    expect(r!.phone).toBe('+39 049 1234567');
    expect(r!.email).toBe('info@foosrl.com');
    expect(r!.name).toBe('Foo S.r.l.');
    expect(r!.address).toContain('Via Roma 1');
  });

  it('uses streetAddress when address is structured', () => {
    const html = longBody(`
      <script type="application/ld+json">
        ${JSON.stringify({
          '@type': 'Organization',
          name: 'Foo',
          streetAddress: 'Via Roma 1',
        })}
      </script>
    `);
    const r = harvestGenericRegistryEvidence(URL, html);
    expect(r!.address).toBe('Via Roma 1');
  });

  it('walks nested JSON-LD (@graph wrappers)', () => {
    const html = longBody(`
      <script type="application/ld+json">
        ${JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [
            { '@type': 'WebSite', name: 'PortalNoise' },
            { '@type': 'Organization', name: 'Foo S.r.l.', vatID: '01234567890' },
          ],
        })}
      </script>
    `);
    const r = harvestGenericRegistryEvidence(URL, html);
    expect(r!.vat_code).toBe('01234567890');
  });
});

describe('harvestGenericRegistryEvidence — regex fallbacks', () => {
  const URL = 'https://www.reportaziende.it/azienda/foo';

  it('falls back to visible "P.IVA" in plain text when JSON-LD is missing', () => {
    const html = `<html><body><h1>Foo</h1><p>${'<span>x</span>'.repeat(20)}
      <span>P.IVA 01234567890</span>
      <span>Email: contact@foo.it</span>
    </p></body></html>`;
    const r = harvestGenericRegistryEvidence(URL, html);
    expect(r).not.toBeNull();
    expect(r!.vat_code).toBe('01234567890');
    expect(r!.email).toBe('contact@foo.it');
    expect(r!.name).toBe('Foo');
    expect(r!.registry_id).toBe('reportaziende');
  });

  it('matches "Partita IVA: IT01234567890" with the IT prefix', () => {
    const html = `<html><body>${'<p>filler</p>'.repeat(20)}
      <span>Partita IVA: IT01234567890</span>
    </body></html>`;
    const r = harvestGenericRegistryEvidence(URL, html);
    expect(r!.vat_code).toBe('01234567890');
  });

  it('classifies an unknown extractable host as unknown_registry', () => {
    const r = harvestGenericRegistryEvidence(
      'https://www.an-unknown-host.example/azienda/foo',
      // padding + space before P.IVA so the regex word boundary matches
      `<html><body>${'<p>x</p>'.repeat(40)}<span>P.IVA 01234567890</span></body></html>`,
    );
    expect(r!.registry_id).toBe('unknown_registry');
  });
});

describe('harvestGenericRegistryEvidence — guards', () => {
  it('returns null for tiny / empty HTML (<200 bytes)', () => {
    expect(harvestGenericRegistryEvidence('https://x.it', '')).toBeNull();
    expect(harvestGenericRegistryEvidence('https://x.it', '<html><body>x</body></html>')).toBeNull();
  });

  it('returns null when no extractable evidence is present', () => {
    const html = `<html><body>${'<p>filler</p>'.repeat(40)}</body></html>`;
    expect(harvestGenericRegistryEvidence('https://x.it', html)).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    const html = `<html><body>${'x'.repeat(220)}P.IVA 01234567890</body></html>`;
    expect(harvestGenericRegistryEvidence('not-a-url', html)).toBeNull();
  });
});
