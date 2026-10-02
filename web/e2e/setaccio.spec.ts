import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const VIEWS = [
  'Panoramica', 'Dataset', 'Aziende', 'Mappa Italia', 'Arricchimento e imbuto',
  'Valutazione', 'Analytics', 'Run e crediti', 'Liste finali',
];

/** Open a view from the sidebar, through the Menu button when it is off-canvas. */
async function goTo(page: Page, label: string) {
  const item = page.locator('.sx-nav__item', { hasText: label }).first();
  if (!(await item.isVisible())) await page.getByRole('button', { name: 'Menu' }).click();
  await item.click();
  await expect(item).toHaveAttribute('aria-current', 'page');
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.sx-app')).toBeVisible();
});

test('every view passes axe (serious/critical) and does not scroll sideways', async ({ page }) => {
  for (const label of VIEWS) {
    await goTo(page, label);
    await page.waitForTimeout(400);
    expect(await axe(page), label).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `${label}: horizontal overflow`).toBe(false);
  }
});

test('overlays are dialogs: focus moves in, Escape closes, focus returns', async ({ page }) => {
  // Milo tour
  const fab = page.getByRole('button', { name: /Apri Milo/ });
  await fab.focus();
  await page.keyboard.press('Enter');
  const milo = page.getByRole('dialog', { name: 'Come funziona Setaccio' });
  await expect(milo).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(milo).toBeHidden();
  await expect(fab).toBeFocused();

  // Wizard
  const cta = page.getByRole('button', { name: 'Mappa il mercato' });
  await cta.click();
  const wizard = page.getByRole('dialog', { name: 'Settore, categoria, parole chiave' });
  await expect(wizard).toBeVisible();
  await expect(wizard.getByRole('button', { name: 'Software B2B SaaS' })).toHaveAttribute('aria-pressed', 'true');
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(wizard).toBeHidden();
  await expect(cta).toBeFocused();

  // Company drawer
  await goTo(page, 'Aziende');
  const first = page.locator('.sx-rowbtn').first();
  const name = (await first.textContent()) ?? '';
  await first.click();
  const drawer = page.getByRole('dialog', { name });
  await expect(drawer).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(first).toBeFocused();
});

test('tabs follow the ARIA pattern with arrow keys', async ({ page }) => {
  await goTo(page, 'Analytics');
  const overview = page.getByRole('tab', { name: 'Overview' });
  await overview.focus();
  await page.keyboard.press('ArrowRight');
  const mercato = page.getByRole('tab', { name: 'Mercato' });
  await expect(mercato).toHaveAttribute('aria-selected', 'true');
  await expect(mercato).toBeFocused();
  await expect(page.getByRole('tabpanel')).toBeVisible();
});

test('the Italia map is usable from the keyboard', async ({ page }) => {
  await goTo(page, 'Mappa Italia');
  const veneto = page.getByRole('button', { name: /^Veneto:/ });
  await veneto.focus();
  await expect(page.locator('.sx-tooltip')).toContainText('Veneto');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Veneto', exact: true })).toHaveAttribute('aria-current', 'location');
});

test('reduced motion: nothing animates', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
  expect(running).toBe(0);
});

test('⌘K palette: find a company and open it', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Cerca o comanda' });
  await expect(palette).toBeVisible();
  expect(await axe(page)).toEqual([]);
  const input = palette.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('aegison');
  const first = palette.getByRole('option').first();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  const name = (await first.locator('.sx-palette__label').textContent()) ?? '';
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.getByRole('dialog', { name })).toBeVisible();
});

test('keyboard shortcuts: g + letter, / and ?', async ({ page }) => {
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await blur();
  await page.keyboard.press('g');
  await page.keyboard.press('n');
  await expect(page.locator('.sx-nav__item', { hasText: 'Analytics' }).first()).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('/');
  await expect(page.getByLabel('Cerca nell’archivio')).toBeFocused();
  await blur();
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Scorciatoie' });
  await expect(help).toBeVisible();
  expect(await axe(page)).toEqual([]);
});

test('market picker is a keyboard listbox', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'the picker is hidden below 420px');
  const picker = page.getByRole('combobox', { name: 'Mercato attivo' });
  await expect(picker).toBeEnabled();
  await picker.focus();
  await page.keyboard.press('ArrowDown');
  const list = page.getByRole('listbox', { name: 'Mercati' });
  await expect(list).toBeVisible();
  expect(await axe(page)).toEqual([]);
  const second = list.getByRole('option').nth(1);
  const label = (await second.locator('.sx-select__name').textContent()) ?? '';
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await expect(picker).toContainText(label);
  await expect(picker).toBeFocused();
});

test('status bar reports the engine with a measured latency', async ({ page }) => {
  const bar = page.locator('.sx-statusbar');
  await expect(bar).toContainText('motore pronto');
  await expect(bar).toContainText(/api \d+ ms/);
});
