# Contributing

## Dev Setup

Use Node 24 and pnpm.

```bash
pnpm install
cp .env.example .env
```

Keep `.env` local. The offline example and unit tests do not require API keys.

## Test Policy

Before opening a PR, every gate must be green (CI runs the same ones):

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm --dir web run typecheck && pnpm --dir web run lint && pnpm --dir web run build   # if you touched web/
pnpm --dir web run test:e2e   # web UI changes: axe + keyboard + 360px smoke on the demo dataset (starts `pnpm demo` if needed; local, not in CI yet)
```

Every bug fix comes with a test that fails without the fix.

Smoke tests are opt-in because they touch real network/browser surfaces:

```bash
RUN_SMOKE=1 pnpm run test:smoke
```

Do not make smoke tests part of CI unless the required network policy and secrets are explicit.

## PR Style

Keep changes scoped to one behavior or documentation goal. Include the command output you used to validate the change, and call out any benchmark or smoke step that was skipped. Do not commit `.env`, API keys, real customer data, or generated `output/`, `dist/`, or `node_modules/` artifacts.

## Comment Policy

A comment earns its place by explaining something the code cannot say. Keep it short and write it in English, in the present tense.

**Do** explain the *why* — the constraint, the failure it prevents, the source of a magic value:

```ts
// The Ad Library retires each Graph API version after ~2 years; a retired
// version answers 400 with no hint, which reads as a quota problem.
const GRAPH_API_VERSION = 'v26.0';
```

**Do not** narrate the change history. A changelog tag in a comment (`[ENRICH-3]`, `[R2]`, `[Phase D]`, `§4.2`, `[pg3]`) goes stale the moment the code changes and tells a reader nothing the git history has not already recorded. The commit message and `CHANGELOG.md` are the history; the comment is the reasoning.

**Do not** describe the obvious. `// increment i` above `i++` is noise. TypeScript already states the types, and names already state the intent.

Test names follow the same rule: `describe('router — falls back to the free tier when a paid provider is blocked')` reads well in the failure output. `describe('[R4] router')` reads as a reference into a document that no longer exists.

