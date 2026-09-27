import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSandboxedPath, SandboxViolation } from '../../src/server/mcp_args';

/** A throwaway repo root: .env secret, output/ with a result, and a symlink pointing at the secret. */
let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-mcp-'));
  fs.writeFileSync(path.join(root, '.env'), 'APIFY_API_KEY=secret\n');
  fs.mkdirSync(path.join(root, 'output', 'run1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'output', 'enriched.csv'), 'a;b\n');
  fs.writeFileSync(path.join(root, 'data.csv'), 'a;b\n');
  fs.symlinkSync(path.join(root, '.env'), path.join(root, 'output', 'innocent.csv'));
  fs.symlinkSync(os.tmpdir(), path.join(root, 'output', 'escape'));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const inOutput = (p: string, ext?: readonly string[]) => resolveSandboxedPath(root, 'output', p, { extensions: ext });

describe('resolveSandboxedPath — MCP agent paths', () => {
  it('allows a result file under output/', () => {
    expect(inOutput('output/enriched.csv', ['.csv'])).toBe(path.join(root, 'output', 'enriched.csv'));
  });

  it('allows a NOT-yet-existing output path (tools write there)', () => {
    expect(inOutput('output/run1/new.csv')).toBe(path.join(root, 'output', 'run1', 'new.csv'));
  });

  it.each([
    ['.env', 'the secrets file at the repo root'],
    ['output/../.env', 'traversal back to the root'],
    ['../outside.csv', 'traversal out of the repo'],
    ['/etc/passwd', 'an absolute path elsewhere'],
    ['data.csv', 'a repo file outside output/'],
    ['output/.hidden.csv', 'a hidden file inside output/'],
    ['', 'an empty path'],
  ])('rejects %s (%s)', (p) => {
    expect(() => inOutput(p)).toThrow(SandboxViolation);
  });

  it('rejects a symlink inside output/ that points at .env', () => {
    expect(() => inOutput('output/innocent.csv')).toThrow(/symlink/);
  });

  it('rejects a new file under a symlinked dir that escapes output/', () => {
    expect(() => inOutput('output/escape/x.csv')).toThrow(/symlink/);
  });

  it('enforces the extension allowlist when given', () => {
    expect(() => inOutput('output/enriched.csv', ['.jsonl'])).toThrow(/only \.jsonl/);
  });

  it('inputs may live anywhere in the repo, but never in hidden paths', () => {
    expect(resolveSandboxedPath(root, '.', 'data.csv')).toBe(path.join(root, 'data.csv'));
    expect(() => resolveSandboxedPath(root, '.', '.env')).toThrow(SandboxViolation);
    expect(() => resolveSandboxedPath(root, '.', '.git/config')).toThrow(SandboxViolation);
  });
});
