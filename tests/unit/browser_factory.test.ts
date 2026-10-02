import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserFactory } from '../../src/browser/factory';

/**
 * BrowserFactory lifecycle against a fake Playwright driver: no Chromium is
 * launched. Each fake browser records whether it was closed, so a leaked
 * process shows up as a launched browser that never saw close().
 */
interface FakeBrowser {
  closed: boolean;
  page: { crashed: boolean };
}

const launched: FakeBrowser[] = [];

// vi.mock is hoisted above the imports, so the factory's lazy import of
// 'playwright' resolves to this fake.
vi.mock('playwright', () => ({
  chromium: {
    launch: async () => {
      const page = {
        crashed: false,
        isClosed() {
          return this.crashed;
        },
      };
      const browser: FakeBrowser & Record<string, unknown> = {
        closed: false,
        page,
        newContext: async () => ({
          setDefaultNavigationTimeout: () => {},
          setDefaultTimeout: () => {},
          newPage: async () => page,
          close: async () => {},
          storageState: async () => {},
        }),
        close: async () => {
          browser.closed = true;
        },
      };
      launched.push(browser);
      return browser;
    },
  },
}));

let stateDir: string;
beforeEach(() => {
  launched.length = 0;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-factory-'));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe('BrowserFactory', () => {
  it('reuses the live page between calls', async () => {
    const factory = new BrowserFactory({ stateDir, restartEvery: 10 });
    const first = await factory.getPage();
    expect(await factory.getPage()).toBe(first);
    expect(launched).toHaveLength(1);
  });

  it('closes the old browser before respawning after a page crash', async () => {
    const factory = new BrowserFactory({ stateDir, restartEvery: 10 });
    await factory.getPage();
    launched[0].page.crashed = true;

    await factory.getPage();

    expect(launched).toHaveLength(2);
    expect(launched[0].closed).toBe(true);
    expect(launched[1].closed).toBe(false);
  });

  it('restarts once per cycle even while navigations keep failing', async () => {
    const factory = new BrowserFactory({ stateDir, restartEvery: 2 });
    await factory.getPage();
    factory.noteNavigation();
    factory.noteNavigation();

    // Proactive restart at the cycle boundary.
    await factory.getPage();
    expect(launched).toHaveLength(2);
    expect(launched[0].closed).toBe(true);
    expect(factory.describe()).toMatchObject({ navCount: 0, totalNavigations: 2 });

    // Failed navigations never call noteNavigation(); the fresh session must
    // be reused instead of relaunching on every getPage().
    await factory.getPage();
    await factory.getPage();
    expect(launched).toHaveLength(2);
  });
});
