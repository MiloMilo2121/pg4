# Contributing

## Dev Setup

Use Node 22 and pnpm.

```bash
pnpm install
cp .env.example .env
```

Keep `.env` local. The offline example and unit tests do not require API keys.

## Test Policy

Before opening a PR:

```bash
pnpm run typecheck
pnpm test
```

Smoke tests are opt-in because they touch real network/browser surfaces:

```bash
RUN_SMOKE=1 pnpm run test:smoke
```

Do not make smoke tests part of CI unless the required network policy and secrets are explicit.

## PR Style

Keep changes scoped to one behavior or documentation goal. Include the command output you used to validate the change, and call out any benchmark or smoke step that was skipped. Do not commit `.env`, API keys, real customer data, or generated `output/`, `dist/`, or `node_modules/` artifacts.
