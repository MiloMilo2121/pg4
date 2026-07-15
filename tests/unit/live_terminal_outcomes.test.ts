import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserFactory } from '../../src/browser/factory';
import { Checkpoint } from '../../src/runtime/checkpoint';
import { runLiveMode } from '../../src/discovery/scrape_pipeline';
import { hasVerifiedMapsEmptyResults, scrapeMapsLocation } from '../../src/discovery/sources/maps_live';
import { scrapePgLocation } from '../../src/discovery/sources/pg_live';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempCheckpoint(): { dir: string; checkpoint: Checkpoint } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-terminal-outcome-'));
  dirs.push(dir);
  return { dir, checkpoint: new Checkpoint(path.join(dir, 'checkpoint.json')) };
}

function factoryFor(page: Record<string, unknown>): BrowserFactory {
  return {
    getPage: async () => page,
    noteNavigation: () => {},
  } as unknown as BrowserFactory;
}

function fakePage(options: {
  html: string;
  feedHtml?: string;
  title?: string;
  onEvaluate?: (expression: string) => unknown;
}): Record<string, unknown> {
  return {
    goto: async () => {},
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    locator: () => ({ first: () => ({ click: async () => { throw new Error('consent absent'); } }) }),
    $: async (selector: string) => selector === 'div[role="feed"]' && options.feedHtml !== undefined
      ? { innerHTML: async () => options.feedHtml }
      : null,
    content: async () => options.html,
    evaluate: async (expression: string) => options.onEvaluate?.(expression) ??
      (expression.includes('m6QErb') ? true : 0),
    isClosed: () => false,
    title: async () => options.title ?? 'Synthetic diagnostic title',
  };
}

describe('live terminal outcome contract', () => {
  it('marks PG cards that all fail parsing as selector drift, not an empty result', async () => {
    const { checkpoint } = tempCheckpoint();
    const html = `<main>${'<article class="search-itm"><div>broken card</div></article>'.repeat(3)}</main>`;

    const result = await scrapePgLocation(factoryFor(fakePage({ html, title: 'PG broken markup' })), {
      category: 'agenzie immobiliari', location: 'Belluno', maxPages: 1, interPageDelayMs: 0, checkpoint,
    });
    const key = Checkpoint.buildKey({ provider: 'pg', category: 'agenzie immobiliari', location: 'Belluno', page: 1 });

    expect(result.interrupted).toBe(false);
    expect(checkpoint.get(key)).toMatchObject({
      status: 'failed', reason: 'parser_dropped_all_cards', page_title: 'PG broken markup',
    });
  });

  it('records a PG zero-card page as empty only when the source rendered an explicit empty state', async () => {
    const { checkpoint } = tempCheckpoint();
    const html = '<main>Nessun risultato trovato per questa ricerca. Prova una categoria diversa.</main>';

    await scrapePgLocation(factoryFor(fakePage({ html })), {
      category: 'agenzie immobiliari', location: 'Belluno', maxPages: 2, interPageDelayMs: 0, checkpoint,
    });
    const key = Checkpoint.buildKey({ provider: 'pg', category: 'agenzie immobiliari', location: 'Belluno', page: 1 });

    expect(checkpoint.get(key)).toMatchObject({ status: 'done', parsed: 0, empty_verified: true });
    expect(checkpoint.has(Checkpoint.buildKey({ provider: 'pg', category: 'agenzie immobiliari', location: 'Belluno', page: 2 }))).toBe(false);
  });

  it('classifies Maps block pages as failures and preserves diagnostic metadata', async () => {
    const { checkpoint } = tempCheckpoint();
    const html = '<html><body><h1>Access denied</h1><p>Automated traffic is blocked for this request.</p></body></html>';

    const result = await scrapeMapsLocation(factoryFor(fakePage({ html, title: 'Access denied' })), {
      category: 'centro estetico', location: 'Belluno', checkpoint, initialRenderDelayMs: 0,
    });
    const key = Checkpoint.buildKey({ provider: 'maps', category: 'centro estetico', location: 'Belluno' });

    expect(result.interrupted).toBe(false);
    expect(checkpoint.get(key)).toMatchObject({ status: 'failed', reason: 'blocked_or_captcha', page_title: 'Access denied' });
  });

  it('distinguishes an explicit Maps empty-result state from an absent feed', async () => {
    const { checkpoint } = tempCheckpoint();
    const html = '<html><body><div>Non sono stati trovati risultati per questa ricerca.</div></body></html>';

    await scrapeMapsLocation(factoryFor(fakePage({ html })), {
      category: 'centro estetico', location: 'Belluno', checkpoint, initialRenderDelayMs: 0,
    });
    const key = Checkpoint.buildKey({ provider: 'maps', category: 'centro estetico', location: 'Belluno' });

    expect(hasVerifiedMapsEmptyResults(html)).toBe(true);
    expect(hasVerifiedMapsEmptyResults('<main>Access denied</main>')).toBe(false);
    expect(checkpoint.get(key)).toMatchObject({ status: 'done', parsed: 0, empty_verified: true });
  });

  it('keeps a Maps query pending when cancellation arrives inside the scroll loop', async () => {
    const { checkpoint } = tempCheckpoint();
    const abort = new AbortController();
    const html = '<html><body><div role="feed"><div class="Nv2PK">placeholder</div></div></body></html>';
    const page = fakePage({
      html,
      feedHtml: '<div class="Nv2PK">placeholder</div>',
      onEvaluate: (expression) => {
        if (expression.includes('scrollTop')) {
          abort.abort();
          return 1;
        }
        return false;
      },
    });

    const result = await scrapeMapsLocation(factoryFor(page), {
      category: 'centro estetico', location: 'Belluno', checkpoint, abortSignal: abort.signal,
      initialRenderDelayMs: 0, maxScrollAttempts: 5, scrollPauseMs: 60_000,
    });
    const key = Checkpoint.buildKey({ provider: 'maps', category: 'centro estetico', location: 'Belluno' });

    expect(result).toMatchObject({ interrupted: true, scroll_attempts: 1 });
    expect(checkpoint.get(key)).toMatchObject({ status: 'pending', reason: 'navigation_in_progress' });
  });

  it('emits a partial run after a pre-aborted pipeline and rejects zero max-pages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-pipeline-abort-'));
    dirs.push(dir);
    const abort = new AbortController();
    abort.abort();
    const out = path.join(dir, 'raw.csv');
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const summary = await runLiveMode({
        runId: 'pre-aborted', out, category: 'agenzie immobiliari', comuniCsv: 'Belluno',
        maxPages: 1, skipPreflight: true, abortSignal: abort.signal,
      });

      expect(summary.interrupted).toBe(true);
      expect(summary.coverage).toMatchObject({ status: 'partial', incomplete_reason: 'interrupted' });
      expect(fs.existsSync(out.replace(/\.csv$/i, '.complete.json'))).toBe(false);
      await expect(runLiveMode({
        runId: 'invalid-pages', out: path.join(dir, 'invalid.csv'), category: 'agenzie immobiliari',
        comuniCsv: 'Belluno', maxPages: 0,
      })).rejects.toThrow('--max-pages must be a positive integer');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
