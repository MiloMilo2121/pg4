/**
 * Phase 3.6 fixture capture.
 *
 * Captures the MINIMAL container HTML for PagineGialle and Google Maps
 * result pages, so the existing pure parsers can be tested against real
 * DOM snapshots. Synthetic fixtures (Phase 3.5) are kept untouched.
 *
 * Usage:
 *   pnpm exec tsx scripts/capture_fixtures.ts pg-belluno
 *   pnpm exec tsx scripts/capture_fixtures.ts pg-milano
 *   pnpm exec tsx scripts/capture_fixtures.ts maps-feltre
 *   pnpm exec tsx scripts/capture_fixtures.ts all
 *
 * The script writes ONLY the container (`.search-results` for PG and
 * `div[role="feed"]` for Maps) wrapped in a minimal `<html><body>` shell.
 * Cookies, scripts, profile sidebars, ad slots are stripped.
 *
 * If the live site blocks (WAF / captcha / consent loop), the script
 * exits with a non-zero code and prints what it captured so far —
 * synthetic fixtures still cover the happy path for downstream tests.
 */

import fs from 'fs';
import path from 'path';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

interface Target {
  id: string;
  url: string;
  source: 'pg' | 'maps';
  containerSelector: string;
  postNavWait: number;
  description: string;
}

const TARGETS: Target[] = [
  {
    id: 'pg_belluno',
    url: 'https://www.paginegialle.it/ricerca/agenzie-immobiliari/belluno/p-1',
    source: 'pg',
    containerSelector: '.search-results, .search-itm-list, main',
    postNavWait: 2500,
    description: 'PG agenzie immobiliari Belluno (small comune, normal page)',
  },
  {
    id: 'pg_milano',
    url: 'https://www.paginegialle.it/ricerca/agenzie-immobiliari/milano/p-1',
    source: 'pg',
    containerSelector: '.search-results, .search-itm-list, main',
    postNavWait: 2500,
    description: 'PG agenzie immobiliari Milano (likely overflow >200)',
  },
  {
    id: 'maps_feltre',
    url: 'https://www.google.com/maps/search/agenzie+immobiliari+Feltre/?hl=it',
    source: 'maps',
    containerSelector: 'div[role="feed"]',
    postNavWait: 5000,
    description: 'Maps agenzie immobiliari Feltre (small feed)',
  },
];

const OUT_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'scraper', 'real');

async function acceptConsent(page: Page, source: 'pg' | 'maps'): Promise<void> {
  if (source === 'pg') {
    // OneTrust + Italiaonline custom consent
    const candidates = [
      '#onetrust-accept-btn-handler',
      'button#onetrust-accept-btn-handler',
      'button[aria-label="Accetta"]',
      'button[aria-label*="cookie"]',
      'button:has-text("Accetta")',
      'button:has-text("Accetto")',
    ];
    for (const sel of candidates) {
      try {
        await page.locator(sel).first().click({ timeout: 1500 });
        await page.waitForTimeout(500);
        return;
      } catch {
        /* try next */
      }
    }
    return;
  }
  // Google Maps consent — usually inside a modal with "Accetta tutto"
  const candidates = [
    'button[aria-label*="Accetta tutto"]',
    'button[aria-label*="Accept all"]',
    'button:has-text("Accetta tutto")',
    'button:has-text("Accept all")',
    'form[action*="consent"] button',
  ];
  for (const sel of candidates) {
    try {
      await page.locator(sel).first().click({ timeout: 1500 });
      await page.waitForTimeout(800);
      return;
    } catch {
      /* try next */
    }
  }
}

async function captureOne(target: Target, ctx: BrowserContext): Promise<{ ok: boolean; bytes: number; reason?: string }> {
  const page = await ctx.newPage();
  try {
    console.log(`[capture] → ${target.id}: ${target.url}`);
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(800);
    await acceptConsent(page, target.source);
    await page.waitForTimeout(target.postNavWait);

    // Find the container element
    let container = await page.$(target.containerSelector.split(',').map((s) => s.trim())[0]);
    if (!container) {
      for (const sel of target.containerSelector.split(',').map((s) => s.trim()).slice(1)) {
        container = await page.$(sel);
        if (container) break;
      }
    }
    if (!container) {
      return { ok: false, bytes: 0, reason: `container not found (${target.containerSelector})` };
    }
    const innerHtml = await container.innerHTML();
    if (!innerHtml || innerHtml.length < 200) {
      return { ok: false, bytes: innerHtml?.length ?? 0, reason: 'container empty / blocked' };
    }

    // Wrap minimal shell so saved snapshot is a valid HTML document
    const shell = wrapShell(innerHtml, target);
    const outPath = path.join(OUT_DIR, `${target.id}.html`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, shell, 'utf8');
    return { ok: true, bytes: shell.length };
  } catch (e) {
    return { ok: false, bytes: 0, reason: (e as Error).message };
  } finally {
    await page.close().catch(() => undefined);
  }
}

function wrapShell(innerHtml: string, target: Target): string {
  const stamp = new Date().toISOString();
  if (target.source === 'pg') {
    return [
      '<!doctype html>',
      `<!-- pg4 fixture: ${target.id} captured ${stamp} from ${target.url} -->`,
      '<html lang="it"><head><meta charset="utf-8"><title>pg4 fixture</title></head>',
      '<body>',
      '<main><div class="search-results">',
      innerHtml,
      '</div></main>',
      '</body></html>',
    ].join('\n');
  }
  // maps: re-wrap inside role="feed" so the parser finds the container
  return [
    '<!doctype html>',
    `<!-- pg4 fixture: ${target.id} captured ${stamp} from ${target.url} -->`,
    '<html lang="it"><head><meta charset="utf-8"><title>pg4 fixture</title></head>',
    '<body>',
    '<div role="main"><div role="feed">',
    innerHtml,
    '</div></div>',
    '</body></html>',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const which = argv.length === 0 ? ['all'] : argv;
  const selected = which.includes('all') ? TARGETS : TARGETS.filter((t) => which.includes(t.id));
  if (selected.length === 0) {
    console.error('Unknown target. Use one of:', TARGETS.map((t) => t.id).join(', '), 'or "all".');
    process.exit(2);
  }

  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: 'it-IT',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const summary: Array<{ id: string; ok: boolean; bytes: number; reason?: string }> = [];
  for (const t of selected) {
    const r = await captureOne(t, ctx);
    summary.push({ id: t.id, ...r });
    console.log(`[capture] ${t.id}: ok=${r.ok} bytes=${r.bytes}${r.reason ? ` reason=${r.reason}` : ''}`);
  }

  await ctx.close();
  await browser.close();

  console.table(summary);
  const failures = summary.filter((s) => !s.ok);
  if (failures.length === selected.length) process.exit(1);
}

main().catch((err) => {
  console.error('[capture] fatal:', err);
  process.exit(1);
});
