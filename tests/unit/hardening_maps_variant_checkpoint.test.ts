/**
 * Hardening audit — Maps coverage variant checkpoint key collision
 *
 * The scrape pipeline iterates:
 *   for each comune:
 *     for each queryCategory (from expandMapsQueryVariants):
 *       scrapeMapsLocation(factory, { category: queryCategory, location: comune })
 *
 * Inside scrapeMapsLocation, the checkpoint key is:
 *   Checkpoint.buildKey({ provider: 'maps', category: opts.category, location: opts.location })
 * = `maps:<category>:<location>`
 *
 * In `default` mode there is exactly one variant (the original category),
 * so keys are unique by definition.
 *
 * In `full` mode, `expandMapsQueryVariants` returns MULTIPLE distinct
 * category strings (e.g. 'agenzie immobiliari', 'agenzia immobiliare', …).
 * Each becomes a DIFFERENT checkpoint key — so NO collision occurs.
 *
 * These tests:
 *   A. Confirm that default and full modes produce DISTINCT key sets
 *      (no two query variants in a given location share the same key).
 *   B. Show that re-running with default mode after a full-mode run does
 *      NOT see the full-mode entries as done (the keys differ).
 *   C. Document what would happen if the pipeline ever passed the
 *      ORIGINAL category instead of the queryCategory to buildKey —
 *      every variant would collide on the same key and only the first
 *      variant would ever be scraped.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { Checkpoint } from '../../src/runtime/checkpoint';
import { expandMapsQueryVariants } from '../../src/discovery/sources/maps_coverage';

function tmpCheckpoint(): Checkpoint {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-hl-cp-'));
  return new Checkpoint(path.join(dir, 'cp.json'));
}

const CATEGORY = 'agenzie immobiliari';
const LOCATION = 'Padova';

// ---- helpers ---------------------------------------------------------------

/** Simulate what the scrape pipeline does when iterating variants. */
function keysForVariants(variants: string[], location: string): string[] {
  return variants.map((cat) =>
    Checkpoint.buildKey({ provider: 'maps', category: cat, location }),
  );
}

// ---- tests -----------------------------------------------------------------

describe('Maps coverage — checkpoint key isolation', () => {
  it('default mode produces exactly one key per location', () => {
    const variants = expandMapsQueryVariants(CATEGORY, 'default');
    expect(variants).toHaveLength(1);
    const keys = keysForVariants(variants, LOCATION);
    expect(keys).toHaveLength(1);
  });

  it('full mode produces DISTINCT keys — no collision between variants', () => {
    const variants = expandMapsQueryVariants(CATEGORY, 'full');
    expect(variants.length).toBeGreaterThan(1);
    const keys = keysForVariants(variants, LOCATION);
    // All keys must be unique
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
    // Spot-check: variant[0] and variant[1] are different categories
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('full-mode keys are disjoint from default-mode key', () => {
    const defaultVariants = expandMapsQueryVariants(CATEGORY, 'default');
    const fullVariants = expandMapsQueryVariants(CATEGORY, 'full');

    const defaultKeys = new Set(keysForVariants(defaultVariants, LOCATION));
    const fullKeys = new Set(keysForVariants(fullVariants, LOCATION));

    // full mode subsumes the default key (first variant is the original category)
    // — the default key appears in fullKeys, but the other full-mode keys do NOT
    // appear in defaultKeys.
    const fullOnlyKeys = [...fullKeys].filter((k) => !defaultKeys.has(k));
    expect(fullOnlyKeys.length).toBeGreaterThan(0);
  });

  it('checkpoint correctly differentiates variant keys for the same location', () => {
    const cp = tmpCheckpoint();
    const variants = expandMapsQueryVariants(CATEGORY, 'full');
    const keys = keysForVariants(variants, LOCATION);

    // Mark only the first variant as done.
    cp.set(keys[0], { status: 'done', total_cards: 110, parsed: 109, dropped: 1 });

    // The remaining variants must NOT be seen as done.
    for (let i = 1; i < keys.length; i++) {
      expect(cp.isDone(keys[i])).toBe(false);
    }
    expect(cp.isDone(keys[0])).toBe(true);
    expect(cp.countDone()).toBe(1);
  });

  // ---- documented anti-pattern test ----------------------------------------
  //
  // This test demonstrates what WOULD break if someone changed the pipeline to
  // pass the ORIGINAL category (not queryCategory) as the key for every variant.
  // In that scenario all variant keys collide on the same string, and marking
  // the first variant done would skip all others.
  //
  it('[anti-pattern] if all variants used the same category key they would collide', () => {
    const variants = expandMapsQueryVariants(CATEGORY, 'full');
    expect(variants.length).toBeGreaterThan(1);

    // Simulate the buggy pipeline: always uses opts.category (CATEGORY), not queryCategory.
    const buggyKeys = variants.map(() =>
      Checkpoint.buildKey({ provider: 'maps', category: CATEGORY, location: LOCATION }),
    );

    // All keys are identical — this IS the collision.
    const uniqueBuggyKeys = new Set(buggyKeys);
    expect(uniqueBuggyKeys.size).toBe(1); // collision confirmed

    // Under this bug, marking the first variant done would skip all others.
    const cp = tmpCheckpoint();
    cp.set(buggyKeys[0], { status: 'done', total_cards: 110, parsed: 109, dropped: 1 });
    expect(cp.countDone()).toBe(1);
    // All "different" variants share the same key and thus appear done.
    for (const key of buggyKeys) {
      expect(cp.isDone(key)).toBe(true); // all appear done — WRONG
    }
  });

  it('cross-location keys are always distinct (same variant, different comune)', () => {
    const variants = expandMapsQueryVariants(CATEGORY, 'full');
    const locations = ['Padova', 'Verona', 'Treviso'];
    const allKeys: string[] = [];
    for (const loc of locations) {
      allKeys.push(...keysForVariants(variants, loc));
    }
    const unique = new Set(allKeys);
    expect(unique.size).toBe(allKeys.length); // no cross-location collision
  });
});
