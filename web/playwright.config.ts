import { defineConfig, devices } from '@playwright/test';

// Accessibility + interaction smoke for the Setaccio dashboard. It needs the
// engine API and the web app on the synthetic demo dataset: `pnpm demo` from
// the repo root starts both; the webServer below does the same when nothing
// is listening on :3000 yet.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'PG4_SEED_FILE=examples/demo/companies.jsonl node scripts/dev.mjs',
    cwd: '..',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 760 }, hasTouch: true } },
  ],
});
