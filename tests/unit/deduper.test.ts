import { describe, it, expect } from 'vitest';
import { dedupeLeads, Deduplicator } from '../../src/discovery/deduper';

describe('Deduplicator', () => {
  it('dedupes by phone digits', () => {
    const out = dedupeLeads([
      { company_name: 'A', city: 'Milano', phone: '+39 02 1234567' },
      { company_name: 'B', city: 'Milano', phone: '0212-3456-7' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('dedupes by name + city when phone differs but identity matches', () => {
    const out = dedupeLeads([
      { company_name: 'Mario Rossi', city: 'Milano', phone: '021' },
      { company_name: 'mario   rossi', city: 'milano', phone: '022' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('treats different cities as different leads', () => {
    const out = dedupeLeads([
      { company_name: 'Mario Rossi', city: 'Milano' },
      { company_name: 'Mario Rossi', city: 'Roma' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('dedupes by website host (www stripping)', () => {
    const out = dedupeLeads([
      { company_name: 'A', website: 'https://www.example.it/' },
      { company_name: 'B', website: 'http://example.it/about' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('merges fields from incoming into existing without overwriting', () => {
    const dd = new Deduplicator();
    const a = { company_name: 'A', city: 'Milano', phone: '+39021' };
    dd.add(a);
    const b = { company_name: 'A', city: 'Milano', address: 'Via X', website: 'https://a.it' };
    dd.merge(a, b);
    expect(a.address).toBe('Via X');
    expect(a.website).toBe('https://a.it');
    expect(a.phone).toBe('+39021');
  });

  it('dedupes by name+address when city is missing on one source', () => {
    const out = dedupeLeads([
      { company_name: 'Studio Dolomiti SRL', address: 'Via Mezzaterra 21, 32100 Belluno (BL)' },
      { company_name: 'studio dolomiti srl', address: 'Via Mezzaterra 21' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('first source wins on conflict (PG before Maps)', () => {
    const out = dedupeLeads([
      { company_name: 'Re/Max', city: 'Sedico', source: 'PG', phone: '0437 000100' },
      { company_name: 'Re/Max', city: 'Sedico', source: 'MAPS', phone: '+39 0437 000100', website: 'https://www.remax.it' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('PG');                  // existing wins
    expect(out[0].phone).toBe('0437 000100');         // existing wins
    expect(out[0].website).toBe('https://www.remax.it'); // missing → filled in
  });

  it('dedupes by maps_url across sources', () => {
    const out = dedupeLeads([
      { company_name: 'X', city: 'A' },
      { company_name: 'Y', city: 'B', maps_url: 'https://www.google.com/maps/place/foo' },
      { company_name: 'Z', city: 'C', maps_url: 'https://www.google.com/maps/place/foo' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('does NOT collapse two leads with the same generic name and no city', () => {
    // Regression: pg4 nameCityKey used to be `${name}|` when city was empty,
    // which caused unrelated leads with the same generic name to merge.
    const out = dedupeLeads([
      { company_name: 'Pizzeria' },
      { company_name: 'Pizzeria' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('does NOT collapse same name with different business_city/query_location', () => {
    const out = dedupeLeads([
      { company_name: 'Studio Tecnico', business_city: 'Belluno' },
      { company_name: 'Studio Tecnico', business_city: 'Milano' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('falls back to query_location when city is missing', () => {
    const out = dedupeLeads([
      { company_name: 'Acme', city: 'Belluno' },
      { company_name: 'Acme', query_location: 'Belluno' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('falls back to business_city when city is missing', () => {
    const out = dedupeLeads([
      { company_name: 'Acme', city: 'Belluno' },
      { company_name: 'Acme', business_city: 'Belluno' },
    ]);
    expect(out).toHaveLength(1);
  });
});
