/**
 * ATECO 2007 taxonomy (2-digit divisions) — loaded from
 * data/reference/ateco_divisions.json.
 *
 * The file lives under data/ (outside rootDir=src), so we read it at runtime
 * via fs instead of importing it, consistent with how api_server reads output/.
 */

import fs from 'fs';
import path from 'path';

export interface AtecoDivision {
  /** 2-digit division code, e.g. "68". */
  division: string;
  /** ATECO section (letter A..U). */
  section: string;
  /** Italian label. */
  label: string;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PATH = path.join(REPO_ROOT, 'data', 'reference', 'ateco_divisions.json');

let cache: AtecoDivision[] | undefined;

/** Loads (and caches) the list of ATECO divisions. */
export function loadAtecoDivisions(file: string = DEFAULT_PATH): AtecoDivision[] {
  if (cache && file === DEFAULT_PATH) return cache;
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as { divisions?: AtecoDivision[] };
  const divisions = parsed.divisions ?? [];
  if (file === DEFAULT_PATH) cache = divisions;
  return divisions;
}

/** division → AtecoDivision map for O(1) lookup. */
export function atecoIndex(file: string = DEFAULT_PATH): ReadonlyMap<string, AtecoDivision> {
  return new Map(loadAtecoDivisions(file).map((d) => [d.division, d]));
}

/**
 * Normalizes a raw ATECO code (any form: "68.31", "682010",
 * "68.20.01", "L68") to the 2-digit division ("68"). Returns undefined if it
 * cannot be extracted.
 */
export function atecoDivisionOf(rawAteco: string | undefined | null): string | undefined {
  if (!rawAteco) return undefined;
  // First run of 2+ digits in the code.
  const m = String(rawAteco).match(/\d{2,}/);
  if (!m) return undefined;
  return m[0].slice(0, 2);
}

/** Human-readable label of a division, or the division itself if unknown. */
export function atecoLabel(division: string, file: string = DEFAULT_PATH): string {
  return atecoIndex(file).get(division)?.label ?? division;
}
