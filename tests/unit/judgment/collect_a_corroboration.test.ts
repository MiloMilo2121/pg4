import { describe, expect, it } from 'vitest';
import type { Lead } from '../../../src/types/lead';
import type { SerpResult } from '../../../src/types/providers';
import type { HarvestContext } from '../../../src/judgment/harvest/source_harvest';
import { InMemoryEnrichmentCache } from '../../../src/persistence/enrichment_cache';
import { collectA } from '../../../src/judgment/collectors/collect_a';

const NOW = 1_750_000_000_000;

function ctx(results: Array<Partial<SerpResult>>): HarvestContext {
  const serp = results.map((r, i): SerpResult => ({ title: '', snippet: '', url: '', rank: i + 1, source_provider: 'stub', ...r }));
  return {
    tenantId: 't',
    cache: new InMemoryEnrichmentCache(),
    fetcher: async () => undefined,
    search: async () => serp,
    paidEnabled: false,
    now: () => NOW,
    ledgerMeta: { company_name: 'x' },
  };
}

async function searchHits(lead: Lead, results: Array<Partial<SerpResult>>) {
  const sigs = await collectA(lead, ctx(results), { byKind: {} });
  return sigs.filter((s) => s.state === 'confirmed_present' && s.evidence.some((e) => e.source === 'search'));
}

const brambilla: Lead = {
  company_name: 'Officine Brambilla Srl',
  city: 'Lecco',
  province: 'LC',
  official_website: 'https://www.brambilla.it',
  facebook: 'https://facebook.com/officinebrambilla',
  vat_code: '01234567890',
};

describe('collectA: a search hit counts only when third-party and corroborated', () => {
  it("does not count the company's own site", async () => {
    const hits = await searchHits(brambilla, [{ url: 'https://brambilla.it/news/premio', title: 'Officine Brambilla riceve il premio', snippet: 'Officine Brambilla di Lecco (LC)' }]);
    expect(hits).toEqual([]);
  });

  it("does not count the company's own social profile", async () => {
    const hits = await searchHits(brambilla, [{ url: 'https://www.facebook.com/officinebrambilla/posts/1', title: 'Officine Brambilla premio', snippet: 'Lecco' }]);
    expect(hits).toEqual([]);
  });

  it('does not count a name collision with no corroboration (same name, other city)', async () => {
    const lead: Lead = { company_name: 'Rossi Costruzioni Srl', city: 'Padova', province: 'PD' };
    const hits = await searchHits(lead, [{ url: 'https://www.larena.it/economia/premio', title: 'Rossi Costruzioni vince il premio', snippet: 'L’impresa Rossi Costruzioni di Verona (VR) premiata' }]);
    expect(hits).toEqual([]);
  });

  it('does not count a name made only of generic trade words, even with the city', async () => {
    const lead: Lead = { company_name: 'Costruzioni Generali Srl', city: 'Padova' };
    const hits = await searchHits(lead, [{ url: 'https://www.ilgazzettino.it/x', title: 'Costruzioni generali premiate', snippet: 'Premio alle costruzioni generali di Padova' }]);
    expect(hits).toEqual([]);
  });

  it('does not count a hit that carries only part of the name', async () => {
    const hits = await searchHits(brambilla, [{ url: 'https://www.laprovinciadilecco.it/x', title: 'Brambilla premiato', snippet: 'Il premio va a Mario Brambilla di Lecco' }]);
    expect(hits).toEqual([]);
  });

  it.each([
    ['city', 'Officine Brambilla premiata a Lecco'],
    ['province', 'Officine Brambilla, Calolziocorte (LC)'],
    ['VAT', 'Officine Brambilla P.IVA IT01234567890'],
    ['own domain named in the text', 'Officine Brambilla (brambilla.it) premiata'],
  ])('counts a third-party hit corroborated by %s', async (_label, snippet) => {
    const hits = await searchHits(brambilla, [{ url: 'https://www.ilsole24ore.com/art/x', title: 'Premio innovazione', snippet }]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].evidence[0].url).toBe('https://www.ilsole24ore.com/art/x');
  });

  it('counts a single-token name when the city corroborates it', async () => {
    const lead: Lead = { company_name: 'Blurebus Srl', city: 'Vicenza' };
    const hits = await searchHits(lead, [{ url: 'https://www.ilgiornaledivicenza.it/x', title: 'Blurebus premiata', snippet: 'La startup Blurebus di Vicenza vince' }]);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('does not count a single-token name without corroboration', async () => {
    const lead: Lead = { company_name: 'Blurebus Srl', city: 'Vicenza' };
    const hits = await searchHits(lead, [{ url: 'https://www.example-news.it/x', title: 'Blurebus premiata', snippet: 'La startup Blurebus vince' }]);
    expect(hits).toEqual([]);
  });

  it('skips the own-site hit and takes the corroborated third-party one behind it', async () => {
    const hits = await searchHits(brambilla, [
      { url: 'https://www.brambilla.it/premi', title: 'Officine Brambilla premio', snippet: 'Lecco' },
      { url: 'https://www.laprovinciadilecco.it/x', title: 'Officine Brambilla premiata', snippet: 'a Lecco' },
    ]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.evidence[0].url === 'https://www.laprovinciadilecco.it/x')).toBe(true);
  });
});
