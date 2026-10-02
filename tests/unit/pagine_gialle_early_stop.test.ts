import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { scrapePgLocation } from '../../src/discovery/sources/pagine_gialle_live';
import type { BrowserFactory } from '../../src/browser/factory';
import { Deduplicator } from '../../src/discovery/deduper';
import { pgNoveltyCheck } from '../../src/discovery/scrape_pipeline';

/**
 * Fix efficienza (post-mortem: 87% delle card scrapate erano duplicati). PG
 * serve risultati provincia-wide: un comune che non aggiunge nulla di NUOVO sta
 * ri-scaricando aziende già viste. Con `isNew` che segnala 0 nuovi, la
 * paginazione deve fermarsi dopo 2 pagine invece di arrivare al cap.
 */
const FIXTURE = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'scraper', 'pg_belluno_normal.html'),
  'utf8',
);

// Fake factory: ogni pagina restituisce lo stesso HTML (cards non vuote).
function fakeFactory(): BrowserFactory {
  const page = {
    goto: async () => {},
    waitForSelector: async () => {},
    $: async () => null, // nessun container handle → usa content()
    content: async () => FIXTURE,
    locator: () => ({ first: () => ({ click: async () => {} }) }),
  };
  return { getPage: async () => page, noteNavigation: () => {} } as unknown as BrowserFactory;
}

describe('pg_live early-stop su esaurimento duplicati', () => {
  it('si ferma dopo 2 pagine quando isNew segnala 0 nuovi (tutti dup)', async () => {
    const r = await scrapePgLocation(fakeFactory(), {
      category: 'agenzie immobiliari',
      location: 'Belluno',
      maxPages: 10,
      interPageDelayMs: 0,
      isNew: () => false, // simula: tutto già visto da comuni precedenti
    });
    expect(r.pages_visited).toBe(2); // early-stop, NON 10
  });

  it('senza isNew continua a paginare (comportamento pre-fix invariato)', async () => {
    const r = await scrapePgLocation(fakeFactory(), {
      category: 'agenzie immobiliari',
      location: 'Belluno',
      maxPages: 4,
      interPageDelayMs: 0,
      // isNew omesso → ogni lead conta come nuovo → nessun early-stop
    });
    expect(r.pages_visited).toBe(4); // arriva al cap (fixture sempre non-vuota)
    expect(r.results.length).toBeGreaterThan(0); // il parser ha estratto lead reali
  });

  it('counts repeats of earlier pages of the same comune as not new', async () => {
    // The run deduper only learns a comune's leads after the whole comune is
    // scraped, so repeats within it must be tracked by the predicate itself.
    const runDedup = new Deduplicator();
    const r = await scrapePgLocation(fakeFactory(), {
      category: 'agenzie immobiliari',
      location: 'Belluno',
      maxPages: 10,
      interPageDelayMs: 0,
      isNew: pgNoveltyCheck(runDedup),
    });
    expect(r.pages_visited).toBe(3); // page 1 new, pages 2 and 3 repeat it
    expect(r.results.length).toBeGreaterThan(0);
    expect(runDedup.size()).toBe(0); // ingest stays with the pipeline
  });

  it('still treats leads from earlier comuni as not new', async () => {
    const runDedup = new Deduplicator();
    const first = await scrapePgLocation(fakeFactory(), {
      category: 'agenzie immobiliari', location: 'Belluno', maxPages: 1, interPageDelayMs: 0,
    });
    for (const lead of first.results) runDedup.add(lead);
    const isNew = pgNoveltyCheck(runDedup);
    expect(first.results.filter(isNew)).toEqual([]);
  });
});
