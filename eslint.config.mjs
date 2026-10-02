// Minimal pragmatic ESLint config: typescript-eslint recommended, NO
// style/formatting rules (formatting stays as-is by convention). Goal: catch
// real defects, not bikeshed.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tools/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      // Use `unknown` + narrowing at error/meta/third-party boundaries.
      '@typescript-eslint/no-explicit-any': 'error',
      // Intentionally empty catch blocks are a pg4 idiom for best-effort
      // cleanup paths; they all carry comments.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `_`-prefixed args are the convention for intentionally unused.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Type-aware rules on the typechecked code (tsconfig.json covers src + tools).
    // A floating promise here is a silently lost error — or a paid call whose
    // failure nobody records.
    files: ['src/**/*.ts', 'tools/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // PR B — layer boundaries. pg4 is layered bottom-up:
    //
    //   L0 contracts & foundations: types, config, util, runtime, io, geo, api
    //     (pure shapes, env, clocks, pools, CSV/JSONL, geo lookups, the
    //     server↔dashboard contract — no business logic, no network)
    //   L1 capabilities: providers, persistence, compliance, browser
    //     (HTTP/SERP/registry clients, caches, the suppression list,
    //     Playwright — reusable, engine-agnostic)
    //   L2 domain engines: enrichment, judgment, discovery, coverage
    //     (the pipelines that compose L0 + L1)
    //   L3 entry points: cli, server
    //     (thin shells over L2; the only layers allowed to import anything)
    //
    // The rules below forbid the inversions that would silently recouple the
    // engine to its shells: a provider that imports the CLI cannot be reused
    // by the API server, and a foundation that imports the domain cannot be
    // reasoned about alone. `api/` is deliberately L0 (a pure contract the
    // domain engines already import), not L3. Tests are exempt: fixtures may
    // wire any layer.
    files: ['src/types/**/*.ts', 'src/config/**/*.ts', 'src/util/**/*.ts', 'src/runtime/**/*.ts', 'src/io/**/*.ts', 'src/geo/**/*.ts', 'src/api/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/cli/**', '**/server/**', '**/scripts/**'], message: 'L0 foundations cannot import entry points (cli/server/scripts): invert the dependency — the shell imports the foundation.' },
            { group: ['**/providers/**', '**/persistence/**', '**/compliance/**', '**/browser/**'], message: 'L0 foundations cannot import L1 capabilities: move the shared shape down into types/ or api/ instead.' },
            { group: ['**/enrichment/**', '**/judgment/**', '**/discovery/**', '**/coverage/**'], message: 'L0 foundations cannot import L2 domain engines: move the shared shape down into types/ or api/ instead.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/providers/**/*.ts', 'src/persistence/**/*.ts', 'src/compliance/**/*.ts', 'src/browser/**/*.ts', 'src/enrichment/**/*.ts', 'src/judgment/**/*.ts', 'src/discovery/**/*.ts', 'src/coverage/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/cli/**', '**/server/**', '**/scripts/**'], message: 'L1/L2 modules cannot import entry points (cli/server/scripts): entry points compose engines, never the reverse.' },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'output/', '*.config.*'],
  }
);
