import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function makeExecutable(filePath: string, body: string): void {
  fs.writeFileSync(filePath, body, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

describe('campaign failure handling', () => {
  it('does not log a fatal cell as complete or let watchdog retry it forever', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-campaign-failure-'));
    dirs.push(dir);
    const bin = path.join(dir, 'bin');
    const out = path.join(dir, 'out');
    fs.mkdirSync(bin, { recursive: true });
    makeExecutable(path.join(bin, 'npx'), '#!/usr/bin/env bash\nexit 2\n');
    makeExecutable(path.join(bin, 'timeout'), '#!/usr/bin/env bash\nshift\nexec "$@"\n');

    const result = spawnSync('bash', ['scripts/campaign.sh', 'BL'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PG4_CAFFEINATED: '1',
        OUTDIR: out,
        SECTORS: 'immobiliare',
        MAPS: '0',
        MAXPAGES: '1',
        RETRIES: '1',
        BASE_BACKOFF: '0',
      },
    });

    expect(result.status, result.stderr).toBe(1);
    const log = fs.readFileSync(path.join(out, '_campaign.log'), 'utf8');
    expect(log).toContain('FAILED immobiliare BL rc=2');
    expect(log).toContain('CAMPAIGN INCOMPLETE');
    expect(JSON.parse(fs.readFileSync(path.join(out, '.recovery', 'immobiliare_BL.json'), 'utf8'))).toMatchObject({
      status: 'blocked',
      block_reason: 'scrape exited 2 after 1 campaign attempt(s)',
    });
  });

  it('does not skip a cell for a copied or empty completion marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-campaign-marker-'));
    dirs.push(dir);
    const bin = path.join(dir, 'bin');
    const out = path.join(dir, 'out');
    const called = path.join(dir, 'npx-called');
    fs.mkdirSync(bin, { recursive: true });
    makeExecutable(path.join(bin, 'npx'), `#!/usr/bin/env bash\ntouch ${JSON.stringify(called)}\nexit 2\n`);
    makeExecutable(path.join(bin, 'timeout'), '#!/usr/bin/env bash\nshift\nexec "$@"\n');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'immobiliare_BL_raw.complete.json'), JSON.stringify({
      version: 1,
      output_csv: path.join(out, 'other.csv'),
      status: 'complete',
      failed_query_count: 0,
      queries: [],
    }));

    const result = spawnSync('bash', ['scripts/campaign.sh', 'BL'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PG4_CAFFEINATED: '1',
        OUTDIR: out,
        SECTORS: 'immobiliare',
        MAPS: '0',
        MAXPAGES: '1',
        RETRIES: '1',
        BASE_BACKOFF: '0',
      },
    });

    expect(result.status, result.stderr).toBe(1);
    expect(fs.existsSync(called)).toBe(true);
  });
});
