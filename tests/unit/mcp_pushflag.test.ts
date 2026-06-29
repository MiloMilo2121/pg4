import { describe, it, expect } from 'vitest';
import { pushFlag } from '../../src/server/mcp_args';

describe('mcp_server pushFlag — tool params -> CLI argv', () => {
  it('appends --name value for strings and numbers', () => {
    const argv: string[] = [];
    pushFlag(argv, 'province', 'PD');
    pushFlag(argv, 'max-pages', 3);
    expect(argv).toEqual(['--province', 'PD', '--max-pages', '3']);
  });

  it('appends a bare --name for true, nothing for false/undefined', () => {
    const argv: string[] = [];
    pushFlag(argv, 'maps', true);
    pushFlag(argv, 'enable-paid', false);
    pushFlag(argv, 'coverage', undefined);
    expect(argv).toEqual(['--maps']);
  });

  it('keeps insertion order across mixed flags', () => {
    const argv = ['--out', 'output/raw.csv', '--category', 'agenzie immobiliari'];
    pushFlag(argv, 'maps', true);
    pushFlag(argv, 'coverage', 'full');
    expect(argv).toEqual(['--out', 'output/raw.csv', '--category', 'agenzie immobiliari', '--maps', '--coverage', 'full']);
  });
});
