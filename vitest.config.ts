import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Hermetic boundary: strip live API keys/flags from the operator's .env so
    // unit tests never hit external services (Apify/Perplexity/Serper/…).
    setupFiles: ['./tests/setup/neutralize_external_env.ts'],
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
