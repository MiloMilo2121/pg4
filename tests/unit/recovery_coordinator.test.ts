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

describe('recovery coordinator', () => {
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

  it('does not start a second wait-and-resume while the cell lock is held', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-recovery-lock-'));
    dirs.push(dir);
    const out = path.join(dir, 'out');
    const queue = path.join(out, '.recovery');
    fs.mkdirSync(path.join(queue, '.centro_estetico_BL.lock'), { recursive: true });
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
});
