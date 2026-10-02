import { describe, expect, it } from 'vitest';
import { Deduplicator, dedupeLeads, normalizeCompanyNameForKey } from '../../src/discovery/deduper';
import type { Lead } from '../../src/types/lead';

const lead = (over: Partial<Lead>): Lead => ({ company_name: 'X', ...over });

describe('dedup — legal-form normalization', () => {
  it('canonicalizes spaced-out legal forms to a single token', () => {
    expect(normalizeCompanyNameForKey('Immobiliare S.r.l.')).toBe('immobiliare srl');
    expect(normalizeCompanyNameForKey('Immobiliare SRL')).toBe('immobiliare srl');
    expect(normalizeCompanyNameForKey('Rossi S.p.A.')).toBe('rossi spa');
    expect(normalizeCompanyNameForKey('Bianchi S.n.c.')).toBe('bianchi snc');
  });

  it('MERGES same-entity legal-form punctuation variants in the same city', () => {
    const out = dedupeLeads([
      lead({ company_name: 'Immobiliare Rossi S.r.l.', city: 'Padova', phone: '049111' }),
      lead({ company_name: 'Immobiliare Rossi SRL', city: 'Padova', phone: '049222' }),
    ]);
    expect(out).toHaveLength(1); // collapsed — same firm, dotted vs joined SRL
  });

  it('KEEPS distinct legal forms apart (SRL vs SPA — different entities)', () => {
    const out = dedupeLeads([
      lead({ company_name: 'Rossi SRL', city: 'Padova', phone: '049111' }),
      lead({ company_name: 'Rossi SPA', city: 'Padova', phone: '049222' }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('dedup — shared-registrable-host review trigger', () => {
  it('flags same registrable domain + different name (apex vs subdomain) for review', () => {
    // www and shop are different full hosts (byHost does NOT merge them) but
    // share the registrable domain — likely the same business on two pages.
    const out = dedupeLeads([
      lead({ company_name: 'Studio Rossi', city: 'Padova', website: 'https://www.studiorossi.it' }),
      lead({ company_name: 'Rossi Immobiliare', city: 'Verona', website: 'https://shop.studiorossi.it' }),
    ]);
    expect(out).toHaveLength(2); // not auto-merged
    // and the pair is flagged via the dedupeLeads internal deduper — assert
    // the trigger directly:
    const dd = new Deduplicator();
    dd.add(lead({ company_name: 'Studio Rossi', city: 'Padova', website: 'https://www.studiorossi.it' }));
    dd.add(lead({ company_name: 'Rossi Immobiliare', city: 'Verona', website: 'https://shop.studiorossi.it' }));
    const review = dd.getReviewCandidates().filter((r) => r.rule === 'shared_registrable_host');
    expect(review).toHaveLength(1);
    expect(review[0].key).toBe('studiorossi.it');
  });

  it('does NOT flag franchise siblings (different non-www subdomains)', () => {
    const dd = new Deduplicator();
    dd.add(lead({ company_name: 'Tecnocasa Padova 1', city: 'Padova', website: 'https://padova1.tecnocasaimpresa.it' }));
    dd.add(lead({ company_name: 'Tecnocasa Padova 2', city: 'Padova', website: 'https://padova2.tecnocasaimpresa.it' }));
    const review = dd.getReviewCandidates().filter((r) => r.rule === 'shared_registrable_host');
    expect(review).toHaveLength(0);
  });

  it('keys the review on the PSL registrable domain, not the last two labels', () => {
    // foo.pd.it is one firm's domain (pd.it is a public suffix). www vs shop
    // is apex vs subdomain of that firm, so it is reviewable. The old rule
    // keyed both on `pd.it` and read `foo` vs `shop.foo` as franchise siblings.
    const dd = new Deduplicator();
    dd.add(lead({ company_name: 'Studio Foo', city: 'Padova', website: 'https://www.foo.pd.it' }));
    dd.add(lead({ company_name: 'Foo Shop', city: 'Vicenza', website: 'https://shop.foo.pd.it' }));
    const review = dd.getReviewCandidates().filter((r) => r.rule === 'shared_registrable_host');
    expect(review).toHaveLength(1);
    expect(review[0].key).toBe('foo.pd.it');
  });

  it.each([
    ['province suffix', 'https://foo.pd.it', 'https://bar.pd.it'],
    ['second-level ccTLD', 'https://foo.co.uk', 'https://bar.co.uk'],
    ['hosting tenants', 'https://foo.altervista.org', 'https://bar.altervista.org'],
  ])('never pairs two firms that only share a public suffix (%s)', (_label, a, b) => {
    const dd = new Deduplicator();
    dd.add(lead({ company_name: 'Studio Foo', city: 'Padova', website: a }));
    dd.add(lead({ company_name: 'Studio Bar', city: 'Verona', website: b }));
    expect(dd.getReviewCandidates().filter((r) => r.rule === 'shared_registrable_host')).toHaveLength(0);
  });

  it('does not flag a hosting tenant against the platform apex', () => {
    const dd = new Deduplicator();
    dd.add(lead({ company_name: 'Altervista', city: 'Milano', website: 'https://altervista.org' }));
    dd.add(lead({ company_name: 'Studio Foo', city: 'Padova', website: 'https://foo.altervista.org' }));
    expect(dd.getReviewCandidates().filter((r) => r.rule === 'shared_registrable_host')).toHaveLength(0);
  });

  it('review-only: never auto-merges on shared registrable host alone', () => {
    const out = dedupeLeads([
      lead({ company_name: 'Studio Rossi', city: 'Padova', website: 'https://www.studiorossi.it', phone: '049111' }),
      lead({ company_name: 'Rossi Immobiliare', city: 'Verona', website: 'https://blog.studiorossi.it', phone: '049222' }),
    ]);
    expect(out).toHaveLength(2); // distinct records survive; only flagged for review
  });
});
