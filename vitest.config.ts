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
      // Phase E.1 — baseline measurement only. NO thresholds: the number is
      // recorded in the readiness report; gates can come later once the
      // team agrees on a target. (Decision log E.1.)
    },
  },
});
