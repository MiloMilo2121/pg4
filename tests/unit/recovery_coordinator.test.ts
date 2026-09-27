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

// Each case spawns the real bash coordinator (+ node helpers): ~2s apiece, and
// past vitest's 5s default under a loaded full-suite run.
describe('recovery coordinator', { timeout: 30_000 }, () => {
  it('closes the queue entry after a successful workflow and successful resumed cell', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-recovery-coordinator-'));
    dirs.push(dir);
    const bin = path.join(dir, 'bin');
    const out = path.join(dir, 'out');
    const queue = path.join(out, '.recovery');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(queue, { recursive: true });

    makeExecutable(path.join(bin, 'git'), '#!/usr/bin/env bash\nexit 0\n');
    makeExecutable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    makeExecutable(path.join(bin, 'pnpm'), '#!/usr/bin/env bash\nexit 0\n');
    makeExecutable(
      path.join(bin, 'curl'),
      '#!/usr/bin/env bash\nprintf \'{"workflow_runs":[{"display_title":"Recovery incident-1 attempt 1","status":"completed","conclusion":"success"}]}\'\n',
    );

    const statePath = path.join(queue, 'centro_estetico_BL.json');
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      cell: 'centro_estetico_BL',
      incident_id: 'incident-1',
      envelope: { output_csv: path.join(out, 'centro_estetico_BL_raw.csv') },
      command: ['/bin/sh', '-c', 'exit 0'],
      attempts: 1,
      status: 'pending',
    }));

    const result = spawnSync(
      'bash',
      ['scripts/recovery_coordinator.sh', 'wait-and-resume', '--out', out, '--cell', 'centro_estetico_BL'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_RECOVERY_TOKEN: 'test-token',
          GH_REPOSITORY: 'owner/repo',
          RECOVERY_WAIT_SECONDS: '1',
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      status: 'complete',
      last_resume_exit: 0,
    });
  });

  it('never re-dispatches a run held for approval by the recovery-merge environment (status "waiting")', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-recovery-coordinator-'));
    dirs.push(dir);
    const bin = path.join(dir, 'bin');
    const out = path.join(dir, 'out');
    const queue = path.join(out, '.recovery');
    const curlLog = path.join(dir, 'curl.log');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(queue, { recursive: true });

    makeExecutable(path.join(bin, 'git'), '#!/usr/bin/env bash\nexit 0\n');
    makeExecutable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    makeExecutable(path.join(bin, 'pnpm'), '#!/usr/bin/env bash\nexit 0\n');
    makeExecutable(
      path.join(bin, 'curl'),
      `#!/usr/bin/env bash\necho "$@" >> '${curlLog}'\nprintf '{"workflow_runs":[{"display_title":"Recovery incident-1 attempt 1","status":"waiting","conclusion":null}]}'\n`,
    );

    const statePath = path.join(queue, 'centro_estetico_BL.json');
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      cell: 'centro_estetico_BL',
      incident_id: 'incident-1',
      envelope: { output_csv: path.join(out, 'centro_estetico_BL_raw.csv') },
      command: ['/bin/sh', '-c', 'exit 0'],
      attempts: 1,
      status: 'pending',
      dispatch_status: 'dispatching',
      dispatch_requested_at: '2020-01-01T00:00:00.000Z', // grace window long expired
    }));

    spawnSync(
      'bash',
      ['scripts/recovery_coordinator.sh', 'wait-and-resume', '--out', out, '--cell', 'centro_estetico_BL'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_RECOVERY_TOKEN: 'test-token',
          GH_REPOSITORY: 'owner/repo',
          RECOVERY_WAIT_SECONDS: '1',
        },
      },
    );

    const calls = fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8') : '';
    expect(calls).toContain('/runs');
    expect(calls).not.toContain('/dispatches');
  });

  it('dispatches a new incident instead of blocking a different recovery fingerprint', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-recovery-next-'));
    dirs.push(dir);
    const bin = path.join(dir, 'bin');
    const out = path.join(dir, 'out');
    const queue = path.join(out, '.recovery');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(queue, { recursive: true });

    makeExecutable(path.join(bin, 'git'), '#!/usr/bin/env bash\nexit 0\n');
    makeExecutable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    makeExecutable(
      path.join(bin, 'curl'),
      '#!/usr/bin/env bash\nprintf \'{"workflow_runs":[{"display_title":"Recovery incident-a attempt 1","status":"completed","conclusion":"success"}]}\'\n',
    );

    const outputCsv = path.join(out, 'centro_estetico_BL_raw.csv');
    const nextEnvelopePath = outputCsv.replace(/\.csv$/i, '.recovery.json');
    const nextEnvelope = { incident_id: 'incident-b', output_csv: outputCsv, failures: [{ key: 'maps:centro:belluno' }] };
    const command = `printf '%s' '${JSON.stringify(nextEnvelope)}' > ${JSON.stringify(nextEnvelopePath)}; exit 1`;
    const statePath = path.join(queue, 'centro_estetico_BL.json');
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      cell: 'centro_estetico_BL',
      incident_id: 'incident-a',
      envelope: { output_csv: outputCsv },
      command: ['/bin/sh', '-c', command],
      attempts: 1,
      status: 'pending',
    }));

    const result = spawnSync(
      'bash',
      ['scripts/recovery_coordinator.sh', 'wait-and-resume', '--out', out, '--cell', 'centro_estetico_BL'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_RECOVERY_TOKEN: 'test-token',
          GH_REPOSITORY: 'owner/repo',
          RECOVERY_WAIT_SECONDS: '1',
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      incident_id: 'incident-b',
      attempts: 1,
      status: 'pending',
    });
  });

  it('allows exactly two recovery cycles for the same fingerprint before blocking', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-recovery-repeat-'));
    dirs.push(dir);
    const bin = path.join(dir, 'bin');
    const out = path.join(dir, 'out');
    const queue = path.join(out, '.recovery');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(queue, { recursive: true });

    makeExecutable(path.join(bin, 'git'), '#!/usr/bin/env bash\nexit 0\n');
    makeExecutable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    makeExecutable(
      path.join(bin, 'curl'),
      '#!/usr/bin/env bash\nif [[ "$*" == *"/runs?"* ]]; then\n  printf \'{"workflow_runs":[{"display_title":"Recovery incident-repeat attempt 2","status":"completed","conclusion":"success"},{"display_title":"Recovery incident-repeat attempt 1","status":"completed","conclusion":"success"}]}\'\nfi\n',
    );

    const statePath = path.join(queue, 'centro_estetico_BL.json');
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1,
      cell: 'centro_estetico_BL',
      incident_id: 'incident-repeat',
      envelope: { output_csv: path.join(out, 'centro_estetico_BL_raw.csv') },
      command: ['/bin/sh', '-c', 'exit 1'],
      attempts: 1,
      status: 'pending',
    }));

    const options = {
      cwd: process.cwd(),
      encoding: 'utf8' as const,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_RECOVERY_TOKEN: 'test-token',
        GH_REPOSITORY: 'owner/repo',
        RECOVERY_WAIT_SECONDS: '1',
      },
    };
    const first = spawnSync('bash', ['scripts/recovery_coordinator.sh', 'wait-and-resume', '--out', out, '--cell', 'centro_estetico_BL'], options);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({ attempts: 2, status: 'pending' });

    const second = spawnSync('bash', ['scripts/recovery_coordinator.sh', 'wait-and-resume', '--out', out, '--cell', 'centro_estetico_BL'], options);
    expect(second.status, second.stderr).toBe(1);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      attempts: 2,
      status: 'blocked',
      block_reason: 'same evidence fingerprint remained after two recovery cycles',
    });
  });

  it('rejects an unsafe cell name before it can escape the recovery queue', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-recovery-cell-'));
    dirs.push(dir);
    const out = path.join(dir, 'out');
    const envelope = path.join(dir, 'incident.json');
    fs.writeFileSync(envelope, JSON.stringify({ incident_id: 'incident-1' }));

    const result = spawnSync(
      'bash',
      [
        'scripts/recovery_coordinator.sh', 'enqueue', '--out', out, '--cell', '../outside', '--envelope', envelope,
        '--command-json', '["/bin/true"]',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid recovery cell');
    expect(fs.existsSync(path.join(dir, 'outside.json'))).toBe(false);
  });

  it('rejects an envelope with an unrecognized error class before it enters the queue', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-recovery-envelope-'));
    dirs.push(dir);
    const out = path.join(dir, 'out');
    const envelope = path.join(dir, 'incident.json');
    fs.writeFileSync(envelope, JSON.stringify({
      version: 1,
      incident_id: '0123456789abcdef01234567',
      run_id: 'run-1',
      generated_at: '2026-07-15T00:00:00.000Z',
      output_csv: path.join(out, 'immobiliare_BL_raw.csv'),
      failures: [{
        key: 'maps:immobiliare:belluno', provider: 'maps', category: 'immobiliare', location: 'belluno',
        error_class: 'untrusted_prompt_payload',
      }],
    }));

    const result = spawnSync(
      'bash',
      [
        'scripts/recovery_coordinator.sh', 'enqueue', '--out', out, '--cell', 'immobiliare_BL', '--envelope', envelope,
        '--command-json', '["pnpm","run","scrape","--","--out","output/raw.csv"]',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid recovery enqueue input');
    expect(fs.existsSync(path.join(out, '.recovery', 'immobiliare_BL.json'))).toBe(false);
  });

  it('does not start a second wait-and-resume while the cell lock is held', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-recovery-lock-'));
    dirs.push(dir);
    const out = path.join(dir, 'out');
    const queue = path.join(out, '.recovery');
    fs.mkdirSync(path.join(queue, '.centro_estetico_BL.lock'), { recursive: true });
    fs.writeFileSync(path.join(queue, '.centro_estetico_BL.lock', 'owner'), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
    fs.writeFileSync(path.join(queue, 'centro_estetico_BL.json'), JSON.stringify({ status: 'pending' }));

    const result = spawnSync(
      'bash',
      ['scripts/recovery_coordinator.sh', 'wait-and-resume', '--out', out, '--cell', 'centro_estetico_BL'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, GH_RECOVERY_TOKEN: 'test-token', GH_REPOSITORY: 'owner/repo' },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('recovery state locked for centro_estetico_BL');
  });

  it('scopes blocked-state checks to the requested campaign cells', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-recovery-scope-'));
    dirs.push(dir);
    const out = path.join(dir, 'out');
    const queue = path.join(out, '.recovery');
    fs.mkdirSync(queue, { recursive: true });
    fs.writeFileSync(path.join(queue, 'old_campaign_MI.json'), JSON.stringify({
      version: 1, cell: 'old_campaign_MI', status: 'blocked', block_reason: 'unrelated historic incident',
    }));
    fs.writeFileSync(path.join(queue, 'immobiliare_BL.json'), JSON.stringify({
      version: 1, cell: 'immobiliare_BL', status: 'complete',
    }));

    const scoped = spawnSync(
      'bash', ['scripts/recovery_coordinator.sh', 'blocked', '--out', out, '--cells', 'immobiliare_BL'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    const unscoped = spawnSync(
      'bash', ['scripts/recovery_coordinator.sh', 'blocked', '--out', out],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(scoped.status).toBe(1);
    expect(unscoped.status).toBe(0);
  });

  it('treats malformed queue JSON as an explicit integrity incident, never an empty queue', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-recovery-corrupt-'));
    dirs.push(dir);
    const out = path.join(dir, 'out');
    const queue = path.join(out, '.recovery');
    fs.mkdirSync(queue, { recursive: true });
    fs.writeFileSync(path.join(queue, 'immobiliare_BL.json'), '{not-json');

    const result = spawnSync(
      'bash', ['scripts/recovery_coordinator.sh', 'blocked', '--out', out, '--cells', 'immobiliare_BL'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('recovery state integrity incident');
  });

  it('writes a newly blocked incident atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-recovery-atomic-'));
    dirs.push(dir);
    const out = path.join(dir, 'out');

    const result = spawnSync(
      'bash', ['scripts/recovery_coordinator.sh', 'block', '--out', out, '--cell', 'immobiliare_BL', '--reason', 'test incident'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    const queue = path.join(out, '.recovery');

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(queue, 'immobiliare_BL.json'), 'utf8'))).toMatchObject({ status: 'blocked' });
    expect(fs.readdirSync(queue).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
