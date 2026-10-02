import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildTsxCommand, resolveTsxExecutable } from '../../src/server/tsx_command';

/**
 * Fase 5.2 — MCP e API non devono più passare da `npx tsx` (rete + versione
 * non pinnata a runtime): usano il tsx locale del repo, con fallback al
 * `tsx` in PATH quando il repo non ha node_modules (es. smoke da checkout).
 * Questo test verifica il comando COSTRUITO, senza spawnare nulla.
 */
function fakeRepoRoot(withLocalTsx: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-tsx-'));
  if (withLocalTsx) {
    const bin = path.join(root, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'tsx'), '#!/usr/bin/env node\n', 'utf8');
  }
  return root;
}

describe('resolveTsxExecutable', () => {
  it('prefers the repo-local node_modules/.bin/tsx', () => {
    const root = fakeRepoRoot(true);
    expect(resolveTsxExecutable(root)).toBe(path.join(root, 'node_modules', '.bin', 'tsx'));
  });

  it('falls back to PATH tsx when the repo has no local install', () => {
    expect(resolveTsxExecutable(fakeRepoRoot(false))).toBe('tsx');
  });
});

describe('buildTsxCommand', () => {
  it('builds an npx-free command for an MCP-style CLI invocation', () => {
    const root = fakeRepoRoot(true);
    const cmd = buildTsxCommand(root, ['src/cli/scrape.ts', '--out', 'output/raw.csv']);
    expect(cmd.file).toBe(path.join(root, 'node_modules', '.bin', 'tsx'));
    expect(cmd.args).toEqual(['src/cli/scrape.ts', '--out', 'output/raw.csv']);
    expect(cmd.file).not.toContain('npx');
    expect(cmd.args).not.toContain('npx');
  });

  it('strips the legacy leading tsx of the dashboard scrape argv (spawn npx tsx …)', () => {
    const root = fakeRepoRoot(true);
    const cmd = buildTsxCommand(root, ['tsx', 'src/cli/run.ts', '--category', 'Fabbri']);
    expect(cmd.args).toEqual(['src/cli/run.ts', '--category', 'Fabbri']);
  });

  it('falls back to PATH tsx without changing the argv shape', () => {
    const cmd = buildTsxCommand(fakeRepoRoot(false), ['src/cli/run.ts', '--province', 'PD']);
    expect(cmd).toEqual({ file: 'tsx', args: ['src/cli/run.ts', '--province', 'PD'] });
  });
});
