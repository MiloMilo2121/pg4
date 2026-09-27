import { describe, it, expect } from 'vitest';
import type { Lead } from '../../src/types/lead';
import { computePhoneKey, computeNameCityKey, normalizeForKey } from '../../src/discovery/deduper';
import { pickTarget, attach, emptyJoinStats } from '../../src/scripts/enrich3/portali_join';
import type { PortalAgencyRecord } from '../../src/providers/apify/portal_parsers';

function indexes(leads: Lead[]): { byPhone: Map<string, Lead[]>; byNameCity: Map<string, Lead[]>; byCity: Map<string, Lead[]> } {
  const byPhone = new Map<string, Lead[]>();
  const byNameCity = new Map<string, Lead[]>();
  const byCity = new Map<string, Lead[]>();
  for (const lead of leads) {
    const pk = computePhoneKey(lead);
    if (pk) (byPhone.get(pk) ?? byPhone.set(pk, []).get(pk)!).push(lead);
    const nck = computeNameCityKey(lead);
    if (nck) (byNameCity.get(nck) ?? byNameCity.set(nck, []).get(nck)!).push(lead);
    const c = lead.city ? normalizeForKey(String(lead.city)) : '';
    if (c) (byCity.get(c) ?? byCity.set(c, []).get(c)!).push(lead);
  }
  return { byPhone, byNameCity, byCity };
}

const rec = (over: Partial<PortalAgencyRecord>): PortalAgencyRecord => ({ portal: 'immobiliare', ...over });

describe('portali_join pickTarget', () => {
  it('matches by phone key (unique hit)', () => {
    const leads = [{ company_name: 'Immobiliare Acme', city: 'Padova', phone: '+39 049 1234567' } as Lead];
    const { byPhone, byNameCity, byCity } = indexes(leads);
    const stats = emptyJoinStats();
    const hit = pickTarget(rec({ name: 'Acme Immobiliare', phone: '0039 049 1234567' }), byPhone, byNameCity, byCity, stats);
    expect(hit?.lead).toBe(leads[0]);
    expect(hit?.how).toBe('phone');
  });

  it('refuses a phone hit whose portal name is a different company (entity guard)', () => {
    const leads = [{ company_name: 'Immobiliare Acme', city: 'Padova', phone: '049 1234567' } as Lead];
    const { byPhone, byNameCity, byCity } = indexes(leads);
    const stats = emptyJoinStats();
    const hit = pickTarget(rec({ name: 'Pizzeria Da Mario', phone: '049 1234567', city: 'Vigonza' }), byPhone, byNameCity, byCity, stats);
    expect(hit).toBeUndefined();
    expect(stats.entityMismatch).toBe(1);
  });

  it('disambiguates a shared phone by unique name-match; skips when still ambiguous', () => {
    const leads = [
      { company_name: 'Tecnorete Padova Est', city: 'Padova', phone: '049 555555' } as Lead,
      { company_name: 'Immobiliare Ziero', city: 'Padova', phone: '049 555555' } as Lead,
    ];
    const { byPhone, byNameCity, byCity } = indexes(leads);
    const stats = emptyJoinStats();
    const ok = pickTarget(rec({ name: 'Ziero Immobiliare SRL', phone: '049 555555' }), byPhone, byNameCity, byCity, stats);
    expect(ok?.lead.company_name).toBe('Immobiliare Ziero');
    expect(ok?.how).toBe('phone_disambiguated');
    const ambiguous = pickTarget(rec({ name: 'Agenzia Casa', phone: '049 555555' }), byPhone, byNameCity, byCity, stats);
    expect(ambiguous).toBeUndefined();
    expect(stats.ambiguousPhone).toBe(1);
  });

  it('falls back to exact name+city, then unique fuzzy in the city bucket', () => {
    const leads = [
      { company_name: 'Immobiliare Ziero', city: 'Padova' } as Lead,
      { company_name: 'Studio Casa Bella', city: 'Padova' } as Lead,
    ];
    const { byPhone, byNameCity, byCity } = indexes(leads);
    const stats = emptyJoinStats();
    const exact = pickTarget(rec({ name: 'Immobiliare Ziero', city: 'Padova' }), byPhone, byNameCity, byCity, stats);
    expect(exact?.how).toBe('name_city');
    const fuzzy = pickTarget(rec({ name: 'Ziero Immobiliare S.R.L.', city: 'Padova' }), byPhone, byNameCity, byCity, stats);
    expect(fuzzy?.lead.company_name).toBe('Immobiliare Ziero');
    expect(fuzzy?.how).toBe('fuzzy');
    const none = pickTarget(rec({ name: 'Immobiliare Nuovissima', city: 'Verona' }), byPhone, byNameCity, byCity, stats);
    expect(none).toBeUndefined();
  });
});

describe('portali_join attach', () => {
  it('fill-only-empty: a present email is NEVER overwritten; portal phone never attached', () => {
    const lead = { company_name: 'Acme', phone: '049 1', email_inferred: 'kept@acme.it' } as Lead;
    const stats = emptyJoinStats();
    attach(rec({ name: 'Acme', phone: '049 999999', email: 'portal@acme.it', instagram: 'https://instagram.com/acme' }), lead, stats);
    expect(lead.email_inferred).toBe('kept@acme.it');
    expect(lead.phone).toBe('049 1');
    expect(lead.instagram).toBe('https://instagram.com/acme');
    expect(lead.portal_source).toBe('immobiliare');
  });

  it('declared website goes to `website`, never official_website; skipped when a site already exists', () => {
    const empty = { company_name: 'Acme' } as Lead;
    attach(rec({ name: 'Acme', website: 'https://acme.it' }), empty, emptyJoinStats());
    expect(empty.website).toBe('https://acme.it');
    expect(empty.official_website).toBeUndefined();

    const verified = { company_name: 'Acme', official_website: 'https://real-acme.it' } as Lead;
    attach(rec({ name: 'Acme', website: 'https://other.it' }), verified, emptyJoinStats());
    expect(verified.website).toBeUndefined();
  });

  it('fills email with type, portal facts as strings, and unions portal_source', () => {
    const lead = { company_name: 'Acme' } as Lead;
    const stats = emptyJoinStats();
    attach(rec({ name: 'Acme', email: 'info@acme.it', listingsCount: 12, isPaid: true, fiaip: false }), lead, stats);
    expect(lead.email_inferred).toBe('info@acme.it');
    expect(lead.email_type).toBe('business');
    expect(lead.portal_listings_count).toBe('12');
    expect(lead.portal_is_paid).toBe('true');
    expect(lead.portal_fiaip).toBe('false');
    attach(rec({ portal: 'wikicasa', name: 'Acme', website: 'https://acme.it' }), lead, stats);
    expect(lead.portal_source).toBe('immobiliare;wikicasa');
    expect(stats.fills.email_inferred).toBe(1);
  });

  it('freemail lands as email_type public', () => {
    const lead = { company_name: 'Acme' } as Lead;
    attach(rec({ name: 'Acme', email: 'acme.padova@gmail.com' }), lead, emptyJoinStats());
    expect(lead.email_type).toBe('public');
  });

  it('a PEC-looking portal email is routed to `pec`, never to email_inferred', () => {
    const lead = { company_name: 'Acme' } as Lead;
    attach(rec({ name: 'Acme', email: 'acme.srl@lamiapec.it' }), lead, emptyJoinStats());
    expect(lead.email_inferred).toBeUndefined();
    expect(lead.pec).toBe('acme.srl@lamiapec.it');
    const legal = { company_name: 'Acme' } as Lead;
    attach(rec({ name: 'Acme', email: 'acme@legalmail.it' }), legal, emptyJoinStats());
    expect(legal.email_inferred).toBeUndefined();
    expect(legal.pec).toBe('acme@legalmail.it');
  });

  it('a business domain that merely CONTAINS "pec" stays an outreach email', () => {
    const lead = { company_name: 'Pecora Immobiliare' } as Lead;
    attach(rec({ name: 'Pecora Immobiliare', email: 'info@pecoraimmobiliare.it' }), lead, emptyJoinStats());
    expect(lead.email_inferred).toBe('info@pecoraimmobiliare.it');
    expect(lead.pec).toBeUndefined();
  });
});
