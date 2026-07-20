import { describe, expect, it } from 'vitest';
import { findContactLinks, mergeExtractions, deepExtractFromSite } from '../../src/enrichment/extract/deep_pages';
import type { BodyExtraction } from '../../src/enrichment/extract/extract_from_body';

/**
 * B.1 deep-pages golden — built from REAL-shaped Italian SMB markup (nav
 * "Contatti"/"Chi siamo" links, mailto only on the contact page, P.IVA footer).
 * The network lift itself is measured on real sites by probe_deep_pages; these
 * lock the pure discovery + merge logic that decides WHICH pages to fetch and
 * how their extractions combine.
 */

const empty = (): BodyExtraction => ({ vat_candidates: [], phones: [] });

describe('findContactLinks — same-site contact/about discovery (pure)', () => {
  const home = `<!doctype html><html><body>
    <nav>
      <a href="/">Home</a>
      <a href="/servizi">Servizi</a>
      <a href="/chi-siamo">Chi siamo</a>
      <a href="contatti.html">Contatti</a>
      <a href="#contatti">Vai ai contatti</a>
      <a href="mailto:x@y.it">scrivici</a>
      <a href="https://www.facebook.com/agenzia">Facebook</a>
      <a href="https://altrosito.it/contatti">Partner</a>
    </nav>
  </body></html>`;

  it('returns same-site contact/about absolute URLs, dedup + cap, excludes external/anchor/mailto', () => {
    const links = findContactLinks(home, 'https://www.agenziarossi.it');
    expect(links).toContain('https://www.agenziarossi.it/chi-siamo');
    expect(links).toContain('https://www.agenziarossi.it/contatti.html');
    // external partner contact page is NOT same registrable domain → excluded
    expect(links.some((l) => l.includes('altrosito.it'))).toBe(false);
    // anchor (#contatti) and mailto are not pages
    expect(links.some((l) => l.includes('#'))).toBe(false);
    expect(links.some((l) => l.startsWith('mailto'))).toBe(false);
  });

  it('respects the cap and returns [] without a site or html', () => {
    expect(findContactLinks(home, 'https://www.agenziarossi.it', 1)).toHaveLength(1);
    expect(findContactLinks(undefined, 'https://x.it')).toEqual([]);
    expect(findContactLinks(home, undefined)).toEqual([]);
  });
});

describe('mergeExtractions — fill-first scalars, union arrays (pure)', () => {
  it('adds only the fields the homepage lacked; homepage wins ties', () => {
    const base: BodyExtraction = { email: 'info@rossi.it', vat_candidates: ['09999990287'], phones: ['0498765432'] };
    const extra: BodyExtraction = {
      email: 'altra@rossi.it', // homepage email wins (not overwritten)
      instagram: 'https://instagram.com/rossi',
      vat_candidates: ['09999990287', '09999991285'], // one new
      phones: ['0498765432'],
    };
    const added = mergeExtractions(base, extra);
    expect(base.email).toBe('info@rossi.it'); // tie → homepage kept
    expect(base.instagram).toBe('https://instagram.com/rossi'); // newly added
    expect(base.vat_candidates).toEqual(['09999990287', '09999991285']); // union
    expect(added.sort()).toEqual(['instagram', 'vat']);
  });

  it('no double-add when extra brings nothing new', () => {
    const base: BodyExtraction = { email: 'info@rossi.it', vat_candidates: [], phones: [] };
    expect(mergeExtractions(base, empty())).toEqual([]);
  });

  it('propagates EVERY scalar applyBodyExtraction consumes (a /chi-siamo founder or TikTok must not be dropped)', () => {
    const base: BodyExtraction = { vat_candidates: [], phones: [] };
    const extra: BodyExtraction = {
      tiktok: 'https://tiktok.com/@rossi',
      youtube: 'https://youtube.com/@rossi',
      founder: 'Mario Rossi',
      founding_year: '1988',
      rating: '4.8',
      reviews_count: '120',
      site_name: 'Agenzia Rossi',
      vat_candidates: [],
      phones: [],
    };
    const added = mergeExtractions(base, extra);
    expect(base.tiktok).toBe('https://tiktok.com/@rossi');
    expect(base.youtube).toBe('https://youtube.com/@rossi');
    expect(base.founder).toBe('Mario Rossi');
    expect(base.founding_year).toBe('1988');
    expect(base.rating).toBe('4.8');
    expect(base.reviews_count).toBe('120');
    expect(base.site_name).toBe('Agenzia Rossi');
    expect(added.sort()).toEqual(['founder', 'founding_year', 'rating', 'reviews_count', 'site_name', 'tiktok', 'youtube']);
  });
});

describe('deepExtractFromSite — homepage + contact page, the email LIFT', () => {
  // Homepage hides the email; /contatti has the mailto — the real-world case
  // deepening is built for. Same-domain enforced, so precision is preserved.
  const pages: Record<string, string> = {
    'https://www.agenziarossi.it': `<html><body><nav><a href="/contatti">Contatti</a></nav>
      <footer>Agenzia Rossi SRL — P.IVA 09999990287</footer></body></html>`,
    'https://www.agenziarossi.it/contatti': `<html><body>
      <a href="mailto:info@agenziarossi.it">info@agenziarossi.it</a>
      <a href="https://www.instagram.com/agenziarossi">Instagram</a>
      </body></html>`,
  };
  const fetcher = async (url: string): Promise<string | undefined> => pages[url.replace(/\/$/, '')];

  it('lifts email + social from the contact page while keeping same-domain precision', async () => {
    const { extraction, pagesFetched, liftedFields } = await deepExtractFromSite('https://www.agenziarossi.it', fetcher);
    expect(extraction.email).toBe('info@agenziarossi.it'); // came from /contatti
    expect(extraction.instagram).toBe('https://instagram.com/agenziarossi'); // extractor strips www.
    expect(extraction.vat_candidates).toContain('09999990287'); // from homepage footer
    expect(pagesFetched).toEqual(['https://www.agenziarossi.it', 'https://www.agenziarossi.it/contatti']);
    expect(liftedFields).toContain('email');
  });

  it('reuses a provided homepage body (verifiedBody) without re-fetching it, still deepens contact pages', async () => {
    // The pipeline passes the already-fetched verified body as homepageHtml on
    // strong matches — deepExtractFromSite must NOT re-fetch the homepage, but
    // must still discover + fetch the contact page from that provided HTML.
    const requested: string[] = [];
    const recordingFetcher = async (url: string): Promise<string | undefined> => {
      requested.push(url.replace(/\/$/, ''));
      return pages[url.replace(/\/$/, '')];
    };
    const { extraction, pagesFetched } = await deepExtractFromSite(
      'https://www.agenziarossi.it',
      recordingFetcher,
      { homepageHtml: pages['https://www.agenziarossi.it'] },
    );
    // homepage came from the provided body → the fetcher was never asked for it
    expect(requested).not.toContain('https://www.agenziarossi.it');
    expect(requested).toContain('https://www.agenziarossi.it/contatti');
    expect(extraction.email).toBe('info@agenziarossi.it'); // lifted from /contatti
    expect(extraction.vat_candidates).toContain('09999990287'); // from the provided homepage footer
    expect(pagesFetched).toContain('https://www.agenziarossi.it/contatti');
  });

  it('degrades gracefully when the homepage is unreachable', async () => {
    const { extraction, pagesFetched } = await deepExtractFromSite('https://down.invalid', async () => undefined);
    expect(extraction).toEqual({ vat_candidates: [], phones: [] });
    expect(pagesFetched).toEqual([]);
  });

  it('SPACES same-domain fetches (per-domain rate-limit, no burst to the site)', async () => {
    // Unique domain → fresh per-domain bucket. homepage + 1 contact = 2 same-site fetches;
    // at ≤2 req/s the second waits ~0.5s. Verifies the bug#4-class guard on the web path.
    const dom = 'https://www.ratelimit-probe-xyz.it';
    const p: Record<string, string> = {
      [dom]: `<html><body><a href="/contatti">Contatti</a></body></html>`,
      [`${dom}/contatti`]: `<html><body><a href="mailto:info@ratelimit-probe-xyz.it">x</a></body></html>`,
    };
    const fast = async (url: string): Promise<string | undefined> => p[url.replace(/\/$/, '')];
    const started = Date.now();
    const { pagesFetched } = await deepExtractFromSite(dom, fast);
    const elapsed = Date.now() - started;
    expect(pagesFetched).toHaveLength(2); // both fetched
    expect(elapsed).toBeGreaterThanOrEqual(300); // second fetch was spaced, not bursted
  });
});
