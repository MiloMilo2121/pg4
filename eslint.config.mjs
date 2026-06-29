// Phase E.3 — minimal pragmatic ESLint config. typescript-eslint
// recommended, NO style/formatting rules (formatting stays as-is by
// convention). Goal: catch real defects (unused vars, floating promises
// are NOT included — that needs type-aware linting, deferred), not
// bikeshed.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      // pg4 uses `any` deliberately at a few error/meta boundaries; the
      // strict tsconfig already prevents implicit any. Warning keeps them
      // visible without blocking the gate.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Intentionally empty catch blocks are a pg4 idiom for best-effort
      // cleanup paths; they all carry comments.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `_`-prefixed args are the convention for intentionally unused.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'output/', '*.config.*'],
  }
);
