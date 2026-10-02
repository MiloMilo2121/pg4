import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The read-side commands (benchmark, coverage, judge) take their input from an
 * enriched output that may predate a suppression request. Each resolves the same
 * list as scrape/enrich and drops suppressed companies before counting or
 * emitting them. Spawned for real: the CLI entry runs `main()` at import time.
 */
const REPO_ROOT = path.resolve(__dirname, '../..');

function runCli(entry: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, LOG_FORMAT: 'json' };
  delete env.SUPPRESSION_LIST;
  return execFileSync(process.execPath, ['-r', 'tsx/cjs', entry, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env });
}

describe('benchmark CLI honours the suppression list', () => {
  it('does not count a suppressed company', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-cli-suppr-'));
    const input = path.join(dir, 'enriched.csv');
    fs.writeFileSync(input, 'company_name,vat_code,email\nKept Srl,,info@kept.it\nGone Srl,01234567897,info@gone.it\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'suppression.csv'), 'phone,vat,email,reason,date\n,01234567897,,gdpr_deletion,2026-05-20\n', 'utf8');

    const out = runCli('src/cli/benchmark.ts', ['--input', input]);
    expect(out).toMatch(/leads: 1\b/);
  });
});
