// Captures the dashboard screenshots used by the README into docs/assets/.
// Needs `pnpm demo` running (API :8787 + web :3000).
//   pnpm --dir web exec node scripts/capture-screenshots.mjs [outDir]
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT = path.resolve(process.argv[2] ?? '../docs/assets');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

/** Fresh page with the engine connected and the data loaded. */
async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 600 });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.locator('.sx-statusbar').getByText('motore pronto').waitFor();
  await page.locator('.sx-stat__value').first().waitFor();
  await page.waitForTimeout(900);
  return page;
}

async function goTo(page, label) {
  const item = page.locator('.sx-nav__item', { hasText: label }).first();
  if (!(await item.isVisible())) await page.getByRole('button', { name: 'Menu' }).click();
  await item.click();
  await page.waitForTimeout(700);
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

// ---- desktop 1600×1000 ----
{
  const page = await open({ width: 1600, height: 1000 });
  await shot(page, 'dashboard-cockpit.png');

  await goTo(page, 'Aziende');
  await shot(page, 'dashboard-aziende.png');

  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Cerca o comanda' }).getByRole('combobox').fill('qubit');
  await page.waitForTimeout(500);
  await shot(page, 'dashboard-palette.png');
  await page.keyboard.press('Escape');

  await goTo(page, 'Mappa Italia');
  await page.getByRole('img', { name: /^Lombardia:/ }).hover();
  await page.waitForTimeout(700);
  await shot(page, 'dashboard-italia.png');

  await page.getByRole('button', { name: /^Veneto:/ }).click();
  await page.getByRole('button', { name: /^Padova:/ }).click();
  await page.getByRole('img', { name: /^Padova: / }).hover();
  await page.waitForTimeout(700);
  await shot(page, 'dashboard-padova.png');

  await goTo(page, 'Analytics');
  await shot(page, 'dashboard-analytics.png');
  await page.context().close();
}

// ---- mobile 360×760, three panels side by side on a 1176×808 sheet ----
{
  const page = await open({ width: 360, height: 760 });
  const frames = [];
  const grab = async () => frames.push((await page.screenshot()).toString('base64'));
  await grab();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.waitForTimeout(500);
  await grab();
  await page.locator('.sx-nav__item', { hasText: 'Aziende' }).first().click();
  await page.waitForTimeout(700);
  await grab();
  await page.context().close();

  const sheet = await browser.newPage({ viewport: { width: 1176, height: 808 } });
  await sheet.setContent(
    `<body style="margin:0;background:#ebe9e4;display:flex;gap:24px;padding:24px">${frames
      .map((f) => `<img width="360" height="760" src="data:image/png;base64,${f}">`)
      .join('')}</body>`,
  );
  await shot(sheet, 'dashboard-mobile.png');
}

await browser.close();
console.log(`screenshots in ${OUT}`);
