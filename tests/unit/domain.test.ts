import { describe, expect, it } from 'vitest';
import { registrableDomain, registryDomain, subdomainOf } from '../../src/util/domain';

describe('registrableDomain — Public Suffix List, private suffixes included', () => {
  it.each([
    ['plain .it', 'rossi.it', 'rossi.it'],
    ['www stripped', 'https://www.rossi.it/contatti?x=1#top', 'rossi.it'],
    ['subdomain folded', 'shop.rossi.it', 'rossi.it'],
    ['deep subdomain folded', 'a.b.rossi.it', 'rossi.it'],
    ['uppercase and trailing dot', 'ROSSI.IT.', 'rossi.it'],
    ['port ignored', 'rossi.it:8080', 'rossi.it'],
    ['protocol-relative', '//rossi.it/contatti', 'rossi.it'],
    ['Italian province suffix', 'foo.pd.it', 'foo.pd.it'],
    ['Italian province suffix with www', 'www.foo.pd.it', 'foo.pd.it'],
    ['second-level ccTLD', 'foo.co.uk', 'foo.co.uk'],
    ['second-level ccTLD with subdomain', 'shop.foo.co.uk', 'foo.co.uk'],
    ['hosting tenant (altervista)', 'x.altervista.org', 'x.altervista.org'],
    ['hosting tenant (blogspot)', 'https://foo.blogspot.com/', 'foo.blogspot.com'],
    ['hosting tenant (wixsite)', 'foo.wixsite.com', 'foo.wixsite.com'],
    ['IDN in punycode', 'xn--mller-kva.de', 'xn--mller-kva.de'],
    ['IDN in unicode normalizes to punycode', 'https://müller.de', 'xn--mller-kva.de'],
  ])('%s: %s → %s', (_label, input, expected) => {
    expect(registrableDomain(input)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['blank', '   '],
    ['IPv4 literal', '192.168.1.1'],
    ['IPv4 URL', 'http://10.0.0.1/admin'],
    ['IPv6 literal', 'http://[::1]/'],
    ['single label', 'localhost'],
    ['bare public suffix', 'co.uk'],
    ['bare province suffix', 'pd.it'],
    ['bare TLD', 'it'],
    ['unparseable', 'http://[bad'],
  ])('%s → undefined', (_label, input) => {
    expect(registrableDomain(input)).toBeUndefined();
  });
});

describe('subdomainOf — labels in front of the registrable domain', () => {
  it.each([
    ['padova1.tecnocasa.it', 'padova1'],
    ['www.padova1.tecnocasa.it', 'padova1'],
    ['www.rossi.it', ''],
    ['rossi.it', ''],
    ['shop.foo.co.uk', 'shop'],
    ['x.altervista.org', ''],
    ['www2.rossi.it', 'www2'],
    [undefined, ''],
  ])('%s → "%s"', (input, expected) => {
    expect(subdomainOf(input)).toBe(expected);
  });
});

describe('registryDomain — the domain RDAP holds a record for', () => {
  it.each([
    ['shop.foo.it', 'foo.it'],
    ['https://www.foo.it/chi-siamo', 'foo.it'],
    ['foo.pd.it', 'foo.pd.it'],
    ['foo.co.uk', 'foo.co.uk'],
  ])('%s → %s', (input, expected) => {
    expect(registryDomain(input)).toBe(expected);
  });

  it.each([
    ['hosting tenant: the registrant is the platform', 'x.altervista.org'],
    ['hosting tenant on blogspot', 'foo.blogspot.com'],
    ['IP literal', '192.168.1.1'],
    ['single label', 'localhost'],
  ])('%s (%s) → undefined', (_label, input) => {
    expect(registryDomain(input)).toBeUndefined();
  });
});

