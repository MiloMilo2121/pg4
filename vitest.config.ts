import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Hermetic boundary: strip live API keys/flags from the operator's .env so
    // unit tests never hit external services (Apify/Perplexity/Serper/…).
    setupFiles: ['./tests/setup/neutralize_external_env.ts'],
    // The campaign/recovery orchestration tests run REAL waits (watchdog loops,
    // lock heartbeats: ~2-2.6s each in isolation). Under 122-file parallel CPU
    // contention they overshoot vitest's 5s default and flake (measured
    // 2026-07-18: timeouts only, never assertion failures; serialized run is
    // 100% green). 30s keeps a hang guard without punishing honest slowness.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // CLI wrappers auto-execute main() on import — they are exercised by
      // the smoke/E2E paths, not unit tests. Types are erased at runtime.
      exclude: ['src/cli/scrape.ts', 'src/cli/enrich.ts', 'src/cli/run.ts', 'src/cli/benchmark.ts', 'src/cli/lookup.ts', 'src/types/**', 'src/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Ratchet, not a target. The floors come from the first measurement on
      // vitest 5 (67.60 / 62.64 / 69.72 / 69.67) minus two points, so the gate
      // blocks a regression without demanding an improvement nobody scheduled.
      // Raise a floor in the same PR that raises coverage, never in a cleanup PR.
      //
      // Do not compare these numbers with pre-v5 output. vitest 4 changed how
      // the v8 provider remaps coverage: it now reports against the original
      // TypeScript instead of the transpiled JS, which drops the statement and
      // line denominators and raises the branch one. The old run reported
      // 72.79/78.69/82.82 — those were measured against a different unit, and
      // the apparent drop is the remapping, not a regression in the tests.
      thresholds: {
        statements: 65,
        branches: 60,
        functions: 67,
        lines: 67,
      },
    },
  },
});
