import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../../src/config/env';

/**
 * Fase 5.3 — `.env.example` e lo schema zod di `src/config/env.ts` devono
 * restare sincronizzati: ogni chiave dello schema va documentata in example
 * (altrimenti l'operatore non sa che esiste), e ogni chiave di example deve
 * esistere nello schema OPPURE essere nella allowlist esplicita qui sotto
 * (variabili shell/server lette fuori dallo schema zod, giustificate una a una).
 */
const REPO_ROOT = path.resolve(__dirname, '../..');

// Non-zod vars, legitimately outside EnvSchema (read directly by scripts or
// the dev API server, not by getEnv()). Each one is justified:
const ALLOWLISTED_EXTRA = new Map<string, string>([
  // VPS recovery coordinator shell variables (scripts/recovery_coordinator.sh).
  ['GH_REPOSITORY', 'shell-only: recovery coordinator repo slug'],
  ['GH_RECOVERY_TOKEN', 'shell-only: recovery coordinator GitHub token'],
  // Dev API server binding, read directly in src/server/api_server.ts.
  ['PG4_API_PORT', 'server-only: dev API listen port'],
  ['PG4_API_HOST', 'server-only: dev API bind address (loopback-only)'],
  ['PG4_API_ALLOWED_ORIGIN', 'server-only: extra dashboard origin for the Host guard'],
  // Optional seed override for `pnpm demo` (scripts/dev.mjs → PG4_SEED_FILE).
  ['PG4_SEED_FILE', 'server-only: seed file override, read via process.env'],
  // Logger / compliance knobs read outside getEnv() (documented, optional).
  ['LOG_FILE', 'logger-only: per-run log file path, read by src/runtime/logger'],
  ['NOTIFY', 'logger-only: operator notification mode, read by src/runtime/notifier'],
  ['SUPPRESSION_LIST', 'compliance: do-not-contact list path, resolved per command'],
  ['RETENTION_DAYS', 'compliance: output retention window, see docs/gdpr_posture.md'],
]);

/** Every `KEY=` (commented or not) in .env.example. */
function exampleKeys(): Set<string> {
  const text = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

describe('.env.example ↔ EnvSchema sync', () => {
  it('every schema key is documented in .env.example', () => {
    const schemaKeys = new Set(Object.keys(EnvSchema.shape));
    const example = exampleKeys();
    const missing = [...schemaKeys].filter((k) => !example.has(k)).sort();
    expect(missing, `schema keys missing from .env.example: ${missing.join(', ')}`).toEqual([]);
  });

  it('every .env.example key is either in the schema or explicitly allowlisted', () => {
    const schemaKeys = new Set(Object.keys(EnvSchema.shape));
    const example = exampleKeys();
    const unknown = [...example].filter((k) => !schemaKeys.has(k) && !ALLOWLISTED_EXTRA.has(k)).sort();
    expect(unknown, `spurious .env.example keys (add to schema or allowlist): ${unknown.join(', ')}`).toEqual([]);
  });

  it('the allowlist only justifies keys that are really outside the schema', () => {
    const schemaKeys = new Set(Object.keys(EnvSchema.shape));
    for (const k of ALLOWLISTED_EXTRA.keys()) {
      expect(schemaKeys.has(k), `${k} is now in the schema — drop it from the allowlist`).toBe(false);
    }
  });
});
