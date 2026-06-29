import path from 'path';
import fs from 'fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { logger } from '../runtime/logger';
import { DEFAULTS } from '../config/defaults';
import { getEnv } from '../config/env';

/**
 * Single-page Playwright session for live scraping.
 *
 * Distinct from the (planned) BrowserPool: BrowserFactory keeps ONE
 * long-lived Chromium context across many navigations of the same site
 * so cookies / consent state persist. The Pool is for concurrent short-
 * lived URL checks during enrichment.
 *
 * Phase 4 (live PG + Maps scraping) uses BrowserFactory; later
 * enrichment phases will compose with a separate BrowserPool.
 *
 * Configuration:
 *   - Italian UA / locale / timezone
 *   - Persistent storage state under `pg4/.browser-state/<id>` (or a
 *     custom path via `stateDir`)
 *   - Proactive restart every N navigations (defends against memory
 *     creep + accumulated WAF state)
 *   - Configurable headless / timeouts via DEFAULTS / env / opts
 *   - No Patchright import unless `PATCHRIGHT_ENABLED=true` in env.
 */

export interface BrowserFactoryOptions {
  /** Identifier used inside `stateDir` so multiple sessions don't collide. */
  id?: string;
  stateDir?: string;
  headless?: boolean;
  navigationTimeoutMs?: number;
  restartEvery?: number;
  /** Inter-page delay applied by call sites; not enforced here. */
  interPageDelayMs?: number;
}

const IT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class BrowserFactory {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private navCount = 0;
  private readonly opts: Required<BrowserFactoryOptions>;

  constructor(opts: BrowserFactoryOptions = {}) {
    const env = getEnv();
    this.opts = {
      id: opts.id ?? 'default',
      stateDir: opts.stateDir ?? path.join(process.cwd(), '.browser-state'),
      headless: opts.headless ?? env.PLAYWRIGHT_HEADLESS,
      navigationTimeoutMs: opts.navigationTimeoutMs ?? DEFAULTS.pipeline.requestTimeoutMs * 4,
      restartEvery: opts.restartEvery ?? DEFAULTS.scraper.browserRefreshEvery,
      interPageDelayMs: opts.interPageDelayMs ?? DEFAULTS.scraper.interPageDelayMs,
    };
    fs.mkdirSync(this.opts.stateDir, { recursive: true });
  }

  /** Lazily create / reuse the Chromium context + page. */
  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      if (this.navCount > 0 && this.navCount % this.opts.restartEvery === 0) {
        logger.info({ navCount: this.navCount }, '[BrowserFactory] proactive restart');
        await this.close();
      } else {
        return this.page;
      }
    }
    return this.spawn();
  }

  /** Mark a navigation as completed. Used by call sites to drive restarts. */
  noteNavigation(): void {
    this.navCount += 1;
  }

  /**
   * Read-only diagnostic snapshot of the factory state. Useful for tests
   * and for the CLI to log before/after a long batch.
   */
  describe(): { id: string; navCount: number; restartEvery: number; headless: boolean; stateDir: string } {
    return {
      id: this.opts.id,
      navCount: this.navCount,
      restartEvery: this.opts.restartEvery,
      headless: this.opts.headless,
      stateDir: this.opts.stateDir,
    };
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.context = null;
    this.browser = null;
    this.page = null;
  }

  // ---- internal ----
  private async spawn(): Promise<Page> {
    const env = getEnv();
    // Lazy-load playwright/patchright so the import doesn't slow down
    // unrelated CLI commands (typecheck, fixture parse, etc).
    const driver = env.PATCHRIGHT_ENABLED
      ?  
        await dynamicImport('patchright').catch(() => null)
      : await dynamicImport('playwright');
    if (!driver) throw new Error('BrowserFactory: playwright driver not loadable');
    const chromium = (driver as { chromium: typeof import('playwright').chromium }).chromium;

    // Phase F finding — Playwright's default SIGINT handler closes the
    // browser and calls process.exit(130), pre-empting pg4's graceful
    // drain (partial outputs were never emitted, the lock was left on
    // disk). pg4's lifecycle owns shutdown: the interrupt handler aborts
    // the comuni/page loops, the pipeline emits partial outputs, releases
    // the lock and exits 130 itself. handleSIGTERM is disabled for the
    // same reason; SIGHUP keeps Playwright's default (terminal close is
    // not a graceful-drain scenario).
    this.browser = await chromium.launch({
      headless: this.opts.headless,
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    const sessionStatePath = path.join(this.opts.stateDir, `${this.opts.id}.json`);
    const storageState = fs.existsSync(sessionStatePath) ? sessionStatePath : undefined;
    this.context = await this.browser.newContext({
      locale: 'it-IT',
      timezoneId: 'Europe/Rome',
      userAgent: IT_USER_AGENT,
      viewport: { width: 1366, height: 900 },
      storageState,
    });
    this.context.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs);
    this.context.setDefaultTimeout(this.opts.navigationTimeoutMs);
    this.page = await this.context.newPage();
    logger.info(this.describe(), '[BrowserFactory] session up');
    return this.page;
  }

  /**
   * Persist the storage state (cookies + localStorage) for the next run.
   * Call sites should invoke this opportunistically (e.g. once consent
   * was accepted) and again before close.
   */
  async saveSessionState(): Promise<void> {
    if (!this.context) return;
    const sessionPath = path.join(this.opts.stateDir, `${this.opts.id}.json`);
    try {
      await this.context.storageState({ path: sessionPath });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[BrowserFactory] failed to save session state');
    }
  }
}

/** Avoids the require-vs-import friction with playwright/patchright. */
async function dynamicImport(name: string): Promise<unknown> {
  const importer = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
  return importer(name);
}
