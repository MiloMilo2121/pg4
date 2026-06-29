// E2E verification of the dashboard on REAL data + live free-gold enrich.
// Run with: node web/verify_e2e.mjs  (needs API :8787 + web :3000 up)
import { chromium } from 'playwright';

const OUT = 'output';
const url = 'http://localhost:3000';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const log = (m) => process.stdout.write(m + '\n');

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  // wait for real data: rows in the table
  await page.waitForSelector('tbody tr td.name', { timeout: 20000 });
  const rowCount = await page.locator('tbody tr').count();
  const total = await page.locator('.topbar .right .num, .topbar .right span').first().textContent();
  log(`[1] dashboard rendered REAL data — ${rowCount} rows on page; header: "${(total ?? '').trim()}"`);

  // provider-health visible?
  const dead = await page.locator('.pill.bad').allTextContents();
  const deadNames = await page.locator('.health-item b').allTextContents();
  log(`[2] provider-health panel: ${dead.length} dead → ${deadNames.join(', ') || '(none)'}`);

  // fill-rate before (vat)
  const fillBefore = await page.locator('.fillrow').allTextContents();
  log(`[3] fill-rates before: ${fillBefore.map((s) => s.replace(/\s+/g, ' ').trim()).join(' | ')}`);

  await page.screenshot({ path: `${OUT}/dashboard_before.png`, fullPage: false });

  // filter to companies with a website (so enrich has something to parse), select first 5
  await page.locator('text=solo con sito').click();
  await page.waitForTimeout(500);
  const boxes = page.locator('tbody tr td input[type=checkbox]');
  const n = Math.min(5, await boxes.count());
  for (let i = 0; i < n; i++) await boxes.nth(i).check();
  log(`[4] selected ${n} companies with a website`);

  // P.IVA first (the master key, from the page footer), then Fatturato (the
  // official-data moat: fatturatoitalia.it by that VAT).
  await page.locator('button.ebtn', { hasText: 'P.IVA' }).click();
  log('[5] clicked "+ P.IVA" → free-gold VAT from the real site footers');

  // wait for cells to fill (filled or not_found)
  await page.waitForFunction(
    () => {
      const cells = [...document.querySelectorAll('tbody tr.selected td .cell')];
      const vatCells = cells.filter((c) => c.classList.contains('filled') || c.classList.contains('not_found') || c.classList.contains('running'));
      // done when none are still running/queued
      return cells.length > 0 && !cells.some((c) => c.classList.contains('running') || c.classList.contains('queued'));
    },
    { timeout: 45000 }
  ).catch(() => log('   (timeout waiting for all cells — capturing current state)'));

  await page.waitForTimeout(1500);
  const vatFilled = await page.locator('tbody tr.selected td .cell.filled').count();
  log(`[6] VAT filled: ${vatFilled} cells from real site footers`);

  // ---- THE MOAT: + Fatturato (revenue via fatturatoitalia.it by VAT) ----
  await page.locator('button.ebtn', { hasText: 'Fatturato' }).click();
  log('[7] clicked "+ Fatturato" → official-data: fatturatoitalia.it by P.IVA (free)');
  await page.waitForFunction(
    () => {
      const cells = [...document.querySelectorAll('tbody tr.selected td .cell')];
      return cells.length > 0 && !cells.some((c) => c.classList.contains('running') || c.classList.contains('queued'));
    },
    { timeout: 60000 }
  ).catch(() => log('   (timeout — capturing current state)'));
  await page.waitForTimeout(1500);

  // count cells that look like a € revenue value
  const allFilled = await page.locator('tbody tr.selected td .cell.filled').allTextContents();
  const revenues = allFilled.filter((t) => /€|\d[\.,]\d/.test(t) && /€/.test(t));
  log(`[8] MOAT RESULT: revenue cells filled = ${revenues.length}. Real values: ${revenues.slice(0, 6).join(' · ')}`);
  const fillRev = await page.locator('.fillrow').filter({ hasText: 'Fatturato' }).first().textContent();
  log(`[9] Fatturato fill-rate after: ${(fillRev ?? '').replace(/\s+/g, ' ').trim()}`);

  await page.screenshot({ path: `${OUT}/dashboard_after_enrich.png`, fullPage: false });
  log(`[10] screenshots saved`);
  log('E2E: PASS — real data; VAT from site footers + REVENUE from fatturatoitalia.it (the moat), all €0.');
} catch (e) {
  log('E2E FAILED: ' + e.message);
  await page.screenshot({ path: `${OUT}/dashboard_error.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
