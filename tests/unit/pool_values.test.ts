import { describe, expect, it } from 'vitest';
import { pool } from '../../src/runtime/pool';
import { has, str } from '../../src/util/values';

describe('pool', () => {
  it('processes every item once, never more than `concurrency` at a time', async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n, i) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      seen[i] = n;
      running -= 1;
    });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  it('handles empty input and rejects a non-positive concurrency', async () => {
    await expect(pool([], 4, async () => {})).resolves.toBeUndefined();
    await expect(pool([1], 0, async () => {})).rejects.toThrow(/concurrency/);
  });

  it('propagates the first error', async () => {
    await expect(pool([1, 2], 2, async (n) => { if (n === 2) throw new Error('x'); })).rejects.toThrow('x');
  });
});

describe('has / str', () => {
  it('has: blank strings, null and undefined are empty; 0 and false are values', () => {
    for (const v of [undefined, null, '', '   ']) expect(has(v)).toBe(false);
    for (const v of [0, false, 'a', ' a ']) expect(has(v)).toBe(true);
  });

  it('str: trims strings, stringifies finite numbers, drops the rest', () => {
    expect(str('  a ')).toBe('a');
    expect(str('   ')).toBeUndefined();
    expect(str(4.5)).toBe('4.5');
    expect(str(Number.NaN)).toBeUndefined();
    expect(str({})).toBeUndefined();
  });
});
