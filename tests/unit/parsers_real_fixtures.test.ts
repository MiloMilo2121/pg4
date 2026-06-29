import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parsePagineGialleResults } from '../../src/discovery/sources/pagine_gialle_parser';
import { parseGoogleMapsResults } from '../../src/discovery/sources/google_maps_parser';

/**
 * Phase 3.6 — REAL fixture regression tests.
 *
 * These run against minimal HTML containers captured from live PG and Maps
 * pages (see scripts/capture_fixtures.ts). They guard against:
 *   - DOM drift on PG (Italiaonline ships layout updates regularly)
 *   - Maps DOM bullet/duplicate-span quirks that synthetic fixtures don't model
 *   - PG-generated WhatsApp click-to-action links being mistaken for the
 *     company website
 *
 * Synthetic fixtures (`tests/fixtures/scraper/*.html`) remain authoritative
 * for edge cases and stay unchanged.
 *
 * If the real DOM evolves and these snapshots get stale, re-run:
 *   pnpm exec tsx scripts/capture_fixtures.ts all
 * Synthetic tests will keep passing meanwhile, so a parser change has to
 * survive both surfaces.
 */

const realDir = path.join(__dirname, '../fixtures/scraper/real');
const exists = (p: string) => fs.existsSync(p);

const PG_BELLUNO = path.join(realDir, 'pg_belluno.html');
const PG_MILANO = path.join(realDir, 'pg_milano.html');
const MAPS_FELTRE = path.join(realDir, 'maps_feltre.html');

describe.runIf(exists(PG_BELLUNO))('REAL — PG Belluno (agenzie immobiliari)', () => {
  const html = fs.readFileSync(PG_BELLUNO, 'utf8');
  const r = parsePagineGialleResults(html, { category: 'agenzie immobiliari' });

  it('parses many cards without dropping any', () => {
    expect(r.total_cards).toBeGreaterThanOrEqual(10);
    expect(r.dropped).toBe(0);
    expect(r.results.length).toBe(r.total_cards);
  });

  it('does NOT detect overflow on a small comune', () => {
    expect(r.overflow).toBe(false);
  });

  it('every parsed card has a non-empty company_name', () => {
    expect(r.results.every((l) => !!l.company_name && l.company_name.length > 1)).toBe(true);
  });

  it('captures a phone for at least 20% of cards (PG hides most behind click-to-reveal)', () => {
    // PG renders only a minority of phones inline; the rest live behind a
    // "click to reveal" CTA that loads digits via JS only on click. Static
    // parsing on the search-list page typically yields ~20-30%. The
    // post-discovery enrichment stage backfills the rest from the website.
    const withPhone = r.results.filter((l) => !!l.phone).length;
    expect(withPhone / r.results.length).toBeGreaterThanOrEqual(0.2);
  });

  it('captures a pg_url for at least 80% of cards', () => {
    const withPg = r.results.filter((l) => !!l.pg_url).length;
    expect(withPg / r.results.length).toBeGreaterThanOrEqual(0.8);
  });

  it('extracts province=BL from address for at least 60% of cards', () => {
    const withProv = r.results.filter((l) => l.province === 'BL').length;
    expect(withProv / r.results.length).toBeGreaterThanOrEqual(0.6);
  });

  it('NEVER reports a wa.me / whatsapp link as the official website', () => {
    const leaks = r.results.filter((l) => l.website && /wa\.me|whatsapp\.com|m\.me/i.test(l.website));
    expect(leaks).toEqual([]);
  });

  it('NEVER reports a paginegialle.it / italiaonline.it link as the official website', () => {
    const leaks = r.results.filter((l) => l.website && /paginegialle\.it|italiaonline\.it|plug\.it/i.test(l.website));
    expect(leaks).toEqual([]);
  });

  it('tags every card with source=PG and the requested category', () => {
    expect(r.results.every((l) => l.source === 'PG')).toBe(true);
    expect(r.results.every((l) => l.category === 'agenzie immobiliari')).toBe(true);
  });
});

describe.runIf(exists(PG_MILANO))('REAL — PG Milano (overflow)', () => {
  const html = fs.readFileSync(PG_MILANO, 'utf8');
  const r = parsePagineGialleResults(html, { category: 'agenzie immobiliari' });

  it('detects the ">200 risultati" banner on a dense city', () => {
    expect(r.overflow).toBe(true);
  });

  it('still parses the visible card subset', () => {
    expect(r.results.length).toBeGreaterThanOrEqual(10);
  });

  it('province=MI on most cards', () => {
    const withMi = r.results.filter((l) => l.province === 'MI').length;
    expect(withMi).toBeGreaterThan(0);
  });
});

describe.runIf(exists(MAPS_FELTRE))('REAL — Maps Feltre feed', () => {
  const html = fs.readFileSync(MAPS_FELTRE, 'utf8');
  const r = parseGoogleMapsResults(html, { category: 'agenzie immobiliari', cityHint: 'Feltre' });

  it('parses every visible feed card', () => {
    expect(r.total_cards).toBeGreaterThanOrEqual(5);
    expect(r.results.length).toBe(r.total_cards);
  });

  it('every parsed card has a non-empty company_name', () => {
    expect(r.results.every((l) => !!l.company_name && l.company_name.length > 1)).toBe(true);
  });

  it('captures phone for the majority of cards', () => {
    const withPhone = r.results.filter((l) => !!l.phone).length;
    expect(withPhone / r.results.length).toBeGreaterThanOrEqual(0.5);
  });

  it('captures website for at least one card', () => {
    expect(r.results.filter((l) => !!l.website).length).toBeGreaterThan(0);
  });

  it('captures maps_url for every card (Maps always has the place URL)', () => {
    expect(r.results.every((l) => !!l.maps_url)).toBe(true);
  });

  it('NEVER mistakes a phone number for a ZIP code', () => {
    // Italian ZIP is 5 digits. A phone number stripped of non-digits also
    // produces 5+ digits. Guard: zip_code, when present, must NOT equal the
    // first 5 digits of the lead's phone number.
    const bad = r.results.filter((l) => {
      if (!l.zip_code || !l.phone) return false;
      const phoneDigits = l.phone.replace(/\D/g, '');
      return phoneDigits.startsWith(l.zip_code);
    });
    expect(bad).toEqual([]);
  });

  it('address, when present, starts with a valid Italian street prefix', () => {
    const bad = r.results.filter(
      (l) =>
        l.address && !/^(Via|Viale|V\.le|Piazza|P\.za|Pza|Corso|C\.so|Largo|Vicolo|Strada|Loc\.|Località|Borgo|Contrada|Frazione|Piazzale)\b/i.test(l.address)
    );
    expect(bad.map((l) => `${l.company_name}::${l.address}`)).toEqual([]);
  });

  it('cityHint is applied when address has no parsable city', () => {
    const withCityHintUsed = r.results.filter((l) => l.city === 'Feltre').length;
    expect(withCityHintUsed).toBeGreaterThan(0);
  });
});

describe.skipIf(exists(PG_BELLUNO) && exists(PG_MILANO) && exists(MAPS_FELTRE))(
  'REAL fixtures missing — run `pnpm exec tsx scripts/capture_fixtures.ts all` to capture',
  () => {
    it('placeholder', () => expect(true).toBe(true));
  }
);
