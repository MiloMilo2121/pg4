import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Checkpoint } from '../../src/runtime/checkpoint';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-cp-'));

describe('Checkpoint', () => {
  it('persists across instances (round-trip)', () => {
    const dir = tmp();
    const file = path.join(dir, 'cp.json');
    const a = new Checkpoint(file);
    a.set('pg:cat:loc:p1', { status: 'done', total_cards: 25, parsed: 25, dropped: 0, overflow: false });
    const b = new Checkpoint(file);
    expect(b.isDone('pg:cat:loc:p1')).toBe(true);
    expect(b.get('pg:cat:loc:p1')?.total_cards).toBe(25);
  });

  it('returns false for unknown keys', () => {
    const cp = new Checkpoint(path.join(tmp(), 'x.json'));
    expect(cp.has('nope')).toBe(false);
    expect(cp.isDone('nope')).toBe(false);
  });

  it('countDone counts only status=done', () => {
    const cp = new Checkpoint(path.join(tmp(), 'x.json'));
    cp.set('a', { status: 'done' });
    cp.set('b', { status: 'failed' });
    cp.set('c', { status: 'pending' });
    cp.set('d', { status: 'done' });
    expect(cp.countDone()).toBe(2);
  });

  it('clear empties the store and the file', () => {
    const dir = tmp();
    const file = path.join(dir, 'x.json');
    const cp = new Checkpoint(file);
    cp.set('a', { status: 'done' });
    cp.clear();
    expect(cp.isDone('a')).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
  });

  it('survives a corrupt file by starting fresh', () => {
    const dir = tmp();
    const file = path.join(dir, 'corrupt.json');
    fs.writeFileSync(file, 'this is not json {{{');
    const cp = new Checkpoint(file);
    expect(cp.has('anything')).toBe(false);
    cp.set('foo', { status: 'done' });
    expect(cp.isDone('foo')).toBe(true);
  });

  it('buildKey produces stable string', () => {
    expect(Checkpoint.buildKey({ provider: 'pg', category: 'Agenzie Immobiliari', location: 'Belluno', page: 2 })).toBe(
      'pg:agenzie immobiliari:belluno:p2'
    );
    expect(Checkpoint.buildKey({ provider: 'maps', category: 'a', location: 'b' })).toBe('maps:a:b');
  });

  it('write is durable per call (atomic via tmp+rename)', () => {
    const dir = tmp();
    const file = path.join(dir, 'atomic.json');
    const cp = new Checkpoint(file);
    cp.set('a', { status: 'done' });
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false); // rename should clean up
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(content.a.status).toBe('done');
  });
});
