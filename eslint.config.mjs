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
    ignores: ['dist/', 'node_modules/', 'coverage/', 'output/', '*.config.*'],
  }
);
