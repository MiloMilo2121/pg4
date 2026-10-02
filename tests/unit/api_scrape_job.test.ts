import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parseScrapeRequest } from '../../src/server/scrape_request';
import { newScrapeJob, runScrapeJob, type CliOutcome, type ScrapeJobDeps } from '../../src/server/scrape_job';
import { CLI_RUN_TIMEOUT_MS } from '../../src/server/cli_timeout';

describe('dashboard scrape request — every wizard combination', () => {
  it('expands categories × provinces and turns maps on only when selected', () => {
    const r = parseScrapeRequest({ categories: ['Carpenteria', 'Tornerie'], provinces: ['PD', 'VR'], sources: ['pg', 'maps'] });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.value.targets).toEqual([
      { category: 'Carpenteria', province: 'PD' },
      { category: 'Carpenteria', province: 'VR' },
      { category: 'Tornerie', province: 'PD' },
      { category: 'Tornerie', province: 'VR' },
    ]);
    expect(r.value.maps).toBe(true);
    const pgOnly = parseScrapeRequest({ categories: ['Carpenteria'], provinces: ['PD'], sources: ['pg'] });
    expect(pgOnly.ok && pgOnly.value.maps).toBe(false);
  });

  it('keeps the single category/province body working, on PagineGialle only', () => {
    const r = parseScrapeRequest({ category: 'Imprese edili', province: 'PD' });
    expect(r).toEqual({ ok: true, value: { targets: [{ category: 'Imprese edili', province: 'PD' }], maps: false } });
  });

  it('maps a wizard province name to its code when the engine has its comuni list', () => {
    const r = parseScrapeRequest({ categories: ['Fabbri'], provinces: ['Vicenza', 'Bergamo', 'vr'], sources: ['pg'] });
    expect(r.ok && r.value.targets.map((t) => t.province)).toEqual(['VI', 'Bergamo', 'VR']);
  });

  it('turns the rapido depth into the capital, one page; other depths keep the whole province', () => {
    const r = parseScrapeRequest({ categories: ['Fabbri'], provinces: ['BL', 'Bergamo'], sources: ['pg'], depth: 'rapido' });
    expect(r.ok && r.value.targets).toEqual([
      { category: 'Fabbri', province: 'BL', comuni: 'Belluno', maxPages: 1 },
      { category: 'Fabbri', province: 'Bergamo', comuni: 'Bergamo', maxPages: 1 },
    ]);
    for (const depth of ['completo', 'esteso']) {
      const full = parseScrapeRequest({ categories: ['Fabbri'], provinces: ['BL'], sources: ['pg'], depth });
      expect(full.ok && full.value.targets).toEqual([{ category: 'Fabbri', province: 'BL' }]);
    }
    expect(parseScrapeRequest({ categories: ['Fabbri'], provinces: ['BL'], depth: 'turbo' })).toMatchObject({ ok: false, status: 400 });
    expect(parseScrapeRequest({ categories: ['Fabbri'], provinces: ['BL'], depth: 1 })).toMatchObject({ ok: false, status: 400 });
  });

  it('drops duplicate selections', () => {
    const r = parseScrapeRequest({ categories: ['Fabbri', 'Fabbri'], provinces: ['PD', 'Padova'], sources: ['pg'] });
    expect(r.ok && r.value.targets).toEqual([{ category: 'Fabbri', province: 'PD' }]);
  });

  it('refuses flag-like values anywhere in the lists', () => {
    expect(parseScrapeRequest({ categories: ['Fabbri', '--enable-paid'], provinces: ['PD'], sources: ['pg'] })).toMatchObject({ ok: false, status: 400 });
    expect(parseScrapeRequest({ categories: ['Fabbri'], provinces: ['--fresh'], sources: ['pg'] })).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses what the CLI cannot do instead of silently doing something else', () => {
    // PagineGialle is the discovery source of every run.
    expect(parseScrapeRequest({ categories: ['Fabbri'], provinces: ['PD'], sources: ['maps'] })).toMatchObject({ ok: false, status: 422 });
    // Paid enrichment sources are not reachable from the free dashboard scrape.
    const paid = parseScrapeRequest({ categories: ['Fabbri'], provinces: ['PD'], sources: ['pg', 'fi', 'oa'] });
    expect(paid).toMatchObject({ ok: false, status: 422 });
    expect(!paid.ok && paid.error).toMatch(/fi, oa/);
    expect(parseScrapeRequest({ categories: ['Fabbri'], provinces: ['PD'], sources: ['pg', 'x'] })).toMatchObject({ ok: false, status: 422 });
    // The legacy page's paid toggle used to be ignored silently.
    expect(parseScrapeRequest({ categories: ['Fabbri'], provinces: ['PD'], sources: ['pg'], paidEnabled: true })).toMatchObject({ ok: false, status: 422 });
    expect(parseScrapeRequest({ categories: ['Fabbri'], provinces: ['PD'], sources: ['pg'], paidEnabled: false })).toMatchObject({ ok: true });
  });

  it('requires at least one category and province, and bounds the number of runs', () => {
    expect(parseScrapeRequest({ categories: [], provinces: ['PD'], sources: ['pg'] })).toMatchObject({ ok: false, status: 422 });
    expect(parseScrapeRequest({ categories: ['Fabbri'], sources: ['pg'] })).toMatchObject({ ok: false, status: 422 });
    expect(parseScrapeRequest({ categories: 'Fabbri', provinces: ['PD'] })).toMatchObject({ ok: false, status: 400 });
    const many = parseScrapeRequest({ categories: Array.from({ length: 5 }, (_, i) => `Cat${i}`), provinces: ['PD', 'VR', 'VI', 'TV', 'VE'], sources: ['pg'] });
    expect(many).toMatchObject({ ok: false, status: 422 });
  });
});

function tmpBase(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-scrape-')), 'dash');
}

function writeJsonl(file: string, rows: object[]): void {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

interface FakeCall {
  args: string[];
  timeoutMs: number;
}

function fakeDeps(script: (call: FakeCall, index: number) => CliOutcome | Promise<CliOutcome>, opts: { stopping?: () => boolean } = {}) {
  const calls: FakeCall[] = [];
  const ingested: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: ScrapeJobDeps = {
    runCli: async (args, timeoutMs) => {
      const call = { args, timeoutMs };
      calls.push(call);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      const out = await script(call, calls.length - 1);
      inFlight -= 1;
      return out;
    },
    ingest: async (file) => {
      ingested.push(path.basename(file));
      if (!fs.existsSync(file)) return { rows: 0, added: 0 };
      const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      // A row whose company is already in the store merges instead of adding one.
      return { rows: rows.length, added: rows.filter((l) => !l.includes('"known"')).length };
    },
    isStopping: opts.stopping ?? (() => false),
    now: () => 1_000,
  };
  return { deps, calls, ingested, maxInFlight: () => maxInFlight };
}

const outArg = (args: string[]): string => args[args.indexOf('--out') + 1];

describe('dashboard scrape job — runs', () => {
  it('runs one CLI invocation per combination, one at a time, with --maps iff selected', async () => {
    const base = tmpBase();
    const job = newScrapeJob('sjob_1', base, { targets: [{ category: 'Fabbri', province: 'PD' }, { category: 'Fabbri', province: 'VR' }], maps: true });
    const f = fakeDeps((call) => {
      writeJsonl(`${outArg(call.args)}_enriched.jsonl`, [{ company_name: 'A' }]);
      return { ok: true };
    });
    await runScrapeJob(job, f.deps);
    expect(f.calls).toHaveLength(2);
    expect(f.maxInFlight()).toBe(1);
    expect(f.calls[0].args).toEqual(['tsx', 'src/cli/run.ts', '--category', 'Fabbri', '--province', 'PD', '--out', `${base}_1`, '--maps']);
    expect(f.calls[1].args).toContain('VR');
    expect(job).toMatchObject({ status: 'done', added: 2, finishedAt: 1_000 });
    expect(job.runs.map((r) => r.status)).toEqual(['done', 'done']);
  });

  it('omits --maps when maps is not selected', async () => {
    const job = newScrapeJob('sjob_2', tmpBase(), { targets: [{ category: 'Fabbri', province: 'PD' }], maps: false });
    const f = fakeDeps(() => ({ ok: true }));
    await runScrapeJob(job, f.deps);
    expect(f.calls[0].args).not.toContain('--maps');
  });

  it('runs a rapido target on its one location with a page cap', async () => {
    const base = tmpBase();
    const job = newScrapeJob('sjob_r', base, { targets: [{ category: 'Fabbri', province: 'BL', comuni: 'Belluno', maxPages: 1 }], maps: false });
    const f = fakeDeps(() => ({ ok: true }));
    await runScrapeJob(job, f.deps);
    expect(f.calls[0].args).toEqual(['tsx', 'src/cli/run.ts', '--category', 'Fabbri', '--comuni', 'Belluno', '--out', `${base}_1`, '--max-pages', '1']);
  });

  it('gives every run the same timeout as the MCP tools', async () => {
    const job = newScrapeJob('sjob_3', tmpBase(), { targets: [{ category: 'Fabbri', province: 'PD' }], maps: false });
    const f = fakeDeps(() => ({ ok: true }));
    await runScrapeJob(job, f.deps);
    expect(f.calls[0].timeoutMs).toBe(CLI_RUN_TIMEOUT_MS);
    expect(CLI_RUN_TIMEOUT_MS).toBe(12 * 60 * 60 * 1000);
    const mcpSource = fs.readFileSync(path.join(__dirname, '../../src/server/mcp_server.ts'), 'utf8');
    expect(mcpSource).toMatch(/timeout: CLI_RUN_TIMEOUT_MS/);
  });

  it('keeps what a timed-out run wrote and marks the job partial', async () => {
    const job = newScrapeJob('sjob_4', tmpBase(), { targets: [{ category: 'Fabbri', province: 'PD' }, { category: 'Fabbri', province: 'VR' }], maps: false });
    const f = fakeDeps((call, i) => {
      const out = outArg(call.args);
      if (i === 0) {
        // Killed during enrich: some rows enriched, the rest only scraped.
        writeJsonl(`${out}_enriched.jsonl`, [{ company_name: 'A' }]);
        writeJsonl(`${out}_raw.jsonl`, [{ company_name: 'B' }, { company_name: 'C' }]);
        return { ok: false, timedOut: true, message: 'killed' };
      }
      writeJsonl(`${out}_enriched.jsonl`, [{ company_name: 'D' }]);
      return { ok: true };
    });
    await runScrapeJob(job, f.deps);
    expect(f.ingested.slice(0, 2)).toEqual(['dash_1_enriched.jsonl', 'dash_1_raw.jsonl']);
    expect(job.runs[0]).toMatchObject({ status: 'partial', added: 3 });
    expect(job.runs[0].error).toMatch(/timed out after 12 h/);
    expect(job.runs[1]).toMatchObject({ status: 'done', added: 1 });
    expect(job).toMatchObject({ status: 'partial', added: 4 });
    expect(job.error).toMatch(/1 of 2 runs incomplete/);
  });

  it('calls a failed run partial when its rows only merged into known companies', async () => {
    const job = newScrapeJob('sjob_8', tmpBase(), { targets: [{ category: 'Fabbri', province: 'PD' }], maps: false });
    const f = fakeDeps((call) => {
      writeJsonl(`${outArg(call.args)}_raw.jsonl`, [{ company_name: 'known' }]);
      return { ok: false, timedOut: false, message: 'exit 1' };
    });
    await runScrapeJob(job, f.deps);
    expect(job.runs[0]).toMatchObject({ status: 'partial', added: 0 });
    expect(job.status).toBe('partial');
  });

  it('marks the job error when every run failed without writing anything', async () => {
    const job = newScrapeJob('sjob_5', tmpBase(), { targets: [{ category: 'Fabbri', province: 'PD' }], maps: false });
    const f = fakeDeps(() => ({ ok: false, timedOut: false, message: 'exit 3: preflight failed' }));
    await runScrapeJob(job, f.deps);
    expect(job).toMatchObject({ status: 'error', added: 0 });
    expect(job.runs[0]).toMatchObject({ status: 'error', error: 'exit 3: preflight failed' });
  });

  it('starts no further run once the server is shutting down', async () => {
    let stopping = false;
    const job = newScrapeJob('sjob_6', tmpBase(), { targets: [{ category: 'Fabbri', province: 'PD' }, { category: 'Fabbri', province: 'VR' }], maps: false });
    const f = fakeDeps(
      () => {
        stopping = true;
        return { ok: false, timedOut: false, message: 'signal SIGTERM' };
      },
      { stopping: () => stopping },
    );
    await runScrapeJob(job, f.deps);
    expect(f.calls).toHaveLength(1);
    expect(job.runs[1]).toMatchObject({ status: 'error', error: expect.stringMatching(/not started/) });
    expect(job.status).toBe('error');
  });

  it('adds up the cost each run recorded in its ledger', async () => {
    const job = newScrapeJob('sjob_7', tmpBase(), { targets: [{ category: 'Fabbri', province: 'PD' }], maps: false });
    const f = fakeDeps((call) => {
      const out = outArg(call.args);
      // A killed run can leave a half-written last line; the summary row repeats the total.
      fs.writeFileSync(
        `${out}_enriched.cost-ledger.jsonl`,
        '{"provider":"serper","cost_eur":0.001}\n{"provider":"openapi","cost_eur":0.05}\n{"kind":"summary","cost_eur":0.051}\n{"provider":"x","cost_e',
        'utf8',
      );
      return { ok: true };
    });
    await runScrapeJob(job, f.deps);
    expect(job.costEur).toBeCloseTo(0.051, 6);
  });

  it('counts 0 for a run that never opened a ledger (nothing was recorded)', async () => {
    const job = newScrapeJob('sjob_9', tmpBase(), { targets: [{ category: 'Fabbri', province: 'PD' }], maps: false });
    await runScrapeJob(job, fakeDeps(() => ({ ok: false, timedOut: true, message: 'killed' })).deps);
    expect(job.costEur).toBe(0);
  });
});

describe('dashboard scrape job — live ingest', () => {
  it('grows the counts while the CLI runs, without counting a company twice', async () => {
    const store = new Map<string, Record<string, unknown>>();
    const ingest = async (file: string) => {
      if (!fs.existsSync(file)) return { rows: 0, added: 0 };
      let rows = 0;
      let added = 0;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let lead: Record<string, unknown>;
        try {
          lead = JSON.parse(line);
        } catch {
          continue; // a half-written last line is picked up on the next tick
        }
        rows += 1;
        const cur = store.get(lead.phone as string);
        if (cur) for (const [k, v] of Object.entries(lead)) cur[k] ??= v;
        else {
          store.set(lead.phone as string, { ...lead });
          added += 1;
        }
      }
      return { rows, added };
    };
    const tick = () => new Promise((r) => setTimeout(r, 40));
    const seen: Array<{ added: number; scraped?: number; enriched?: number }> = [];
    const job = newScrapeJob('sjob_live', tmpBase(), { targets: [{ category: 'Fabbri', province: 'BL' }], maps: false });
    const deps: ScrapeJobDeps = {
      runCli: async (args) => {
        const out = outArg(args);
        const snap = () => seen.push({ added: job.added, scraped: job.runs[0].scraped, enriched: job.runs[0].enriched });
        fs.writeFileSync(`${out}_raw.jsonl`, '{"phone":"1","company_name":"A"}\n{"phone":"2","company_name":"B"}\n{"phone":"3","comp');
        await tick();
        snap();
        fs.writeFileSync(`${out}_raw.jsonl`, '{"phone":"1","company_name":"A"}\n{"phone":"2","company_name":"B"}\n{"phone":"3","company_name":"C"}\n');
        fs.writeFileSync(`${out}_enriched.jsonl`, '{"phone":"1","company_name":"A","official_website":"https://1.example"}\n');
        await tick();
        snap();
        fs.writeFileSync(
          `${out}_enriched.jsonl`,
          ['1', '2', '3'].map((p) => JSON.stringify({ phone: p, official_website: `https://${p}.example` })).join('\n') + '\n',
        );
        return { ok: true };
      },
      ingest,
      isStopping: () => false,
      now: () => 1_000,
      liveIngestMs: 5,
    };
    await runScrapeJob(job, deps);
    expect(seen[0]).toMatchObject({ added: 2, scraped: 2 });
    expect(seen[1]).toMatchObject({ added: 3, scraped: 3, enriched: 1 });
    expect(job).toMatchObject({ status: 'done', added: 3 });
    expect(job.runs[0]).toMatchObject({ status: 'done', added: 3, scraped: 3, enriched: 3 });
    expect([...store.values()].map((c) => c.official_website)).toEqual(['https://1.example', 'https://2.example', 'https://3.example']);
  });

  it('stops ingesting once the run has ended', async () => {
    const calls: string[] = [];
    const job = newScrapeJob('sjob_stop', tmpBase(), { targets: [{ category: 'Fabbri', province: 'BL' }], maps: false });
    await runScrapeJob(job, {
      runCli: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true };
      },
      ingest: async (file) => {
        calls.push(path.basename(file));
        return { rows: 0, added: 0 };
      },
      isStopping: () => false,
      now: () => 1_000,
      liveIngestMs: 5,
    });
    const after = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(after);
    expect(calls.at(-1)).toBe('dash_1_enriched.jsonl');
  });
});
