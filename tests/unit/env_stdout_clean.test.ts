import { execFileSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * dotenv 17+ prints an "injecting env (N) from .env" banner on stdout unless
 * it is told to stay quiet. The MCP server speaks JSON-RPC on stdout, so that
 * banner would be interleaved into a response frame and the client would fail
 * to parse it.
 *
 * This spawns a real child process (module-load-time state cannot be observed
 * from inside the already-imported module graph) and asserts that importing
 * `src/config/env` writes nothing at all to stdout.
 */
const REPO_ROOT = path.resolve(__dirname, '../..');

function stdoutOf(entry: string): string {
  return execFileSync(process.execPath, ['-r', 'tsx/cjs', '-e', entry], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, LOG_FORMAT: 'json' },
  });
}

describe('env loading stays off stdout', () => {
  it('importing the env schema prints no dotenv banner', () => {
    const out = stdoutOf("require('./src/config/env')");
    expect(out).toBe('');
  });

  it('the MCP tool module graph prints no banner either', () => {
    // env.ts is the single module that loads .env; every entry point that
    // configures logging pulls it in. If this is clean, stdout is a clean
    // JSON-RPC channel.
    const out = stdoutOf("require('./src/config/env'); require('./src/runtime/logger')");
    expect(out).toBe('');
  });
});
