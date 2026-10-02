import { createRequire } from 'node:module';
import * as espree from 'espree';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

// Two shims for eslint-config-next 16 on ESLint 10. Both go away once Next's
// config supports ESLint 10 natively.
//
// eslint-plugin-react's `version: 'detect'` calls `context.getFilename()`, which
// ESLint 10 removed. Reading the installed version here gives the same answer
// without the removed API, and cannot drift from package.json.
const { version: reactVersion } = createRequire(import.meta.url)('react/package.json');

export default defineConfig([
  ...nextVitals,
  { settings: { react: { version: reactVersion } } },
  {
    // Next parses plain JS with its bundled Babel parser, whose scope manager
    // lacks the `addGlobals()` ESLint 10 calls. The JS here is config and
    // scripts with no JSX, so ESLint's own parser is the right one anyway.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { parser: espree },
  },
  {
    // Design System v2 "Grafite" guards. Colours come from tokens (var(--…)),
    // never as numeric hex/rgb in TSX; the DS bans the em dash in copy and
    // italics everywhere. Comments are not checked: these are string rules.
    files: ['app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'Literal[value=/\u2014/]', message: 'DS v2: no em dash in copy. Use a colon, a comma or a full stop (EMPTY for missing values).' },
        { selector: 'TemplateElement[value.raw=/\u2014/]', message: 'DS v2: no em dash in copy. Use a colon, a comma or a full stop.' },
        { selector: 'JSXText[value=/\u2014/]', message: 'DS v2: no em dash in copy. Use a colon, a comma or a full stop.' },
        { selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$|rgba?[(] *[0-9]/]', message: 'DS v2: colours come from tokens (var(--…) or rgba(var(--x-rgb),a)), not literals.' },
        { selector: "Property[key.name='fontStyle'][value.value='italic']", message: 'DS v2: no italics. Emphasis is sand, not slant.' },
        { selector: "Property[key.name=/^(borderRadius|boxShadow)$/]", message: 'App variant: corners and shadows come from the --r-* / --shadow-* tokens via CSS classes, not inline styles.' },
      ],
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);
