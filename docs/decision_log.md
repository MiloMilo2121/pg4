# pg4 decision log — production-readiness pass (2026-06-10)

Conservative defaults chosen autonomously during the hardening pass.
Each entry lists the alternatives and the migration path. None of these
are irreversible; all are config- or flag-gated.

## Reality-vs-plan discrepancies noted at Phase 0

1. `validate:output` script **already existed** in package.json (added by a
   concurrent session after the gap audit was written). Phase B.2 therefore
   only wires automatic post-run invocation.
2. `.env.example` **already documents** every EnvSchema variable. Phase B.4
   only appends the new observability variables.
3. `Checkpoint.set()` **already flushes synchronously** on every write —
   the "flush checkpoint on shutdown" requirement is satisfied by design;
   the graceful-shutdown work only needs to stop the loop and let the
   natural path complete.

## A.1 — Per-run log file

- **Default:** every CLI run writes a JSONL log to `<out>.log.jsonl`
  alongside the outputs. `LOG_FILE=<path>` overrides the location;
  `LOG_FILE=off` disables.
- **Alternatives considered:** opt-in only (operator forgets, loses
  forensics — rejected); rotating global log dir (adds config surface and
  detaches logs from the run artifacts they describe — rejected).
- **Migration:** set `LOG_FILE` env in the scheduler unit to centralize
  logs; or pipe to a shipper later. No call-site changes needed.

## A.2 — Run history location

- **Default:** `_runs.jsonl` in the same directory as the run's `--out`
  file. Underscore prefix sorts it apart from data files; the validator
  and retention sweep ignore it.
- **Alternatives:** single fixed `output/_runs.jsonl` (breaks when the
  operator writes outputs elsewhere); SQLite (new dependency, stateless-core
  invariant pressure).
- **Migration:** the file is plain JSONL — trivially importable into
  DuckDB/Postgres later.

## A.3 — Preflight canary

- **Default:** preflight ON for every live scrape; canary query is
  "agenzie immobiliari" / Padova (densest validated comune since R6).
  `--skip-preflight` opts out per-run.
- **Alternatives:** canary derived from the run's own category/comune
  (first-run categories have no known-good baseline — rejected);
  preflight as separate CLI (operator forgets — rejected).
- **Migration:** when a second category is validated at province scale,
  move `PREFLIGHT_CANARY` to config.

## A.4 — Yield anomaly threshold

- **Default:** warn when a comune yields < 30% of its historical average
  for the same category; advisory only (marks `suspect: true` in the run
  record, never fails the run). No history → no check.
- **Alternatives:** fail the run (false positives on genuinely shrinking
  markets — rejected); median instead of mean (fine, revisit with more
  history).

## A.5 — Notifier

- **Default:** `NOTIFY=local` — structured warn-level log line (lands in
  the run log file) + best-effort macOS `osascript` notification.
  `NOTIFY=off` silences.
- **OPERATOR DECISION PENDING:** alert channel (Slack webhook / Telegram /
  email). The `Notifier` interface takes one implementation + one line in
  `createNotifier` to add; call sites are final.
- **Per-lead ceiling events are notified once per run** (first occurrence);
  the total count lands in the ledger summary and run record. Rationale:
  many leads legitimately exhaust their budget; N pings would be spam.

## B.3 — Exit codes

- `0` ok · `1` partial (enrich row errors) · `2` fatal · `3` preflight
  failed · `130` interrupted. Stable contract for schedulers.
- pg4 CLIs have never prompted; `--non-interactive` is accepted as an
  inert flag by the parser (any unknown `--flag` parses as boolean true)
  and documented as such rather than implemented as special behavior.

## B.5 — Graceful shutdown

- First SIGINT/SIGTERM: abort signal → cooperative drain (in-flight leads
  finish, outputs close, ledger summary + run record written, lock
  released) → natural exit 130. Watchdog force-exits after 45 s if the
  drain wedges; a second signal force-exits immediately. The force path
  writes a fallback run record but may leave a partially flushed CSV —
  accepted as the escape hatch.

## B.1 — `run` command output layout

- **Default:** `--out <base>` produces `<base>_raw.csv`, `<base>_enriched.csv`
  (+ jsonl/ledger), `<base>.log.jsonl`. Each stage acquires its own
  output lock (same protection as the separate commands).
- **Alternative:** route everything into a per-campaign directory (more files
  to move for delivery — deferred).

## B.2 — Automatic post-run validation

- **Default:** `validateOutputs()` runs at the end of scrape (raw flavor) and at
  the end of enrich (enriched flavor). WARN-ONLY: a failure is logged + notified
  but does not change the exit code — the outputs are already on disk and hiding
  them does not help the operator.
- **Alternative:** a dedicated exit code for validation-failed (breaks the
  "exit≠0 = run not completed" semantics — rejected for now).

## B.3 — Scheduler

- **OPERATOR DECISION PENDING:** no scheduler installed (launchd,
  cron or GitHub Actions all work). CLIs are already non-interactive by design.

## B.4 — Secrets

- **Default:** `.env` remains the mechanism (conservative). `assertPaidSecrets()`
  fails fast, naming the missing variable, when `--enable-paid` is
  passed without any usable paid provider.
- **Scan performed (2026-06-10):** no key-shaped secrets in the pg4 working
  tree, in the git history of pg4 paths, or at HEAD of the entire repo;
  `.env` never committed. No CRITICAL findings.
- **OPERATOR DECISION PENDING:** upgrade to a secrets manager (1Password /
  SOPS / Doppler) for multi-operator use.

## C.1 — Schema versioning

- **Default:** `_schema_version=1` as the LAST column of both flavors
  + a JSONL field. The base columns are FROZEN (RAW_BASE / ENRICHED_BASE);
  every future addition goes into an APPENDED_COLUMNS_V* appendix.
- **Structural reason:** appending to RAW_CSV_COLUMNS directly would have
  INSERTED columns in the middle of the enriched CSV (which spreads raw first) —
  breaking positional readers. Hence the frozen bases.
- The validator requires the column with the expected value; pre-v1 files fail
  validation explicitly ("pre-v1 output?").

## C.2 — E.164

- **Default:** conservative normalization only for plausibly Italian
  numbers; the original is preserved in `phone_raw`. Unparseable numbers
  are left unchanged (better no normalization than a wrong one).

## C.3 — Near-duplicate review

- **Default:** auxiliary token-sorted name+city index; collisions are
  FLAGGED in `<out>.dedup-review.jsonl`, NEVER auto-merged ("Studio Casa" vs
  "Casa Studio" can be distinct registered businesses).

## C.4 — Closed businesses

- **Default:** "Chiuso definitivamente"/"Permanently closed" is captured by the
  Maps parser; enrich writes them as SKIPPED/SKIPPED_PERMANENTLY_CLOSED
  without burning provider calls. `--include-closed` to process them.
- Only data already present in the loaded pages — no extra navigation.

## D.1 — Suppression list

- **Default:** resolution order flag > env SUPPRESSION_LIST > `suppression.csv`
  auto-discovered next to the output > disabled. Matching leads are
  DROPPED (not written as SKIPPED): a do-not-contact data subject must not
  keep appearing in delivered files. An unreadable EXPLICIT path
  is a hard error (the operator asked for a protection they are not getting).

## D.2 — Retention

- **Default:** OFF (never delete anything without opt-in). `--retention-days N`
  / env RETENTION_DAYS. Always protected: `_runs.jsonl` (Art. 30 register),
  `suppression.csv`, `*.lock`.
- **OPERATOR DECISION PENDING:** the period N (GDPR decision).

## D.3 — Lookup (right-to-access/deletion)

- **Default:** `pnpm run lookup` is a READER: it reports file+line, deletion
  stays manual. Automatically rewriting artifacts already
  delivered would put them out of sync with the copies held by clients.

## D.4 — GDPR

- Posture documented in `docs/gdpr_posture.md`: implemented vs pending.
- **OPERATOR DECISIONS PENDING:** legal basis + balancing test, retention
  period, DPIA yes/no, Serper DPA (paid queries transmit names to a
  non-EU processor), Art. 14 notice, RPO check if telemarketing.

## E.1 — Coverage

- **Baseline (2026-06-10):** 70.44% lines · 83.76% branches · 81.79%
  functions (vitest --coverage, v8 provider; CLI wrapper entrypoint and
  src/types excluded). NO gate threshold set — the number is the
  baseline; the threshold is a later team decision.

## E.3 — ESLint

- **Default:** typescript-eslint recommended, zero formatting rules.
  `no-explicit-any` at warn (the `any`s at error/meta boundaries are
  deliberate; tsconfig strict already prevents implicit ones). 0 errors,
  0 warnings at the end of the pass.

## E.4 — Dependency audit

- **3 vulnerabilities found, all in the dev-tooling chain
  vitest→vite→esbuild** (1 critical vitest<3.2.6 UI-server file read;
  2 moderate vite/esbuild dev-server). Exploitation requires a dev/UI server
  listening — pg4 uses ONLY one-shot `vitest run`, no server is ever
  started. No vulnerabilities in production dependencies.
- **MAJOR BUMP DEFERRED (operator/next pass):** vitest 2→3 fixes all
  three. Not done in this pass because of the "patch-level only" rule.

## F — Real bugs found by live verification (and fixes)

1. **RateLimiter never wired** (since Phase 1): acquire() had no call site →
   SERP burst ~3.7 req/s → Bing soft-block 185/185 empty, silently.
   Fix: per-provider pacing in the router; bing_html/ddg_lite 0.5 req/s
   capacity 2; unconfigured providers = unchanged. Verified live: 0%→100%
   success, yield 0→17.8% (R11 baseline: 20.9%).
2. **Playwright's default handleSIGINT** pre-empted the graceful drain
   (its own exit(130) before ours): handleSIGINT/handleSIGTERM:false at
   launch + per-PAGE abort check in pg_live (a dense comune exceeded
   the watchdog). Verified live: natural drain in 1.7 s with partial
   outputs, lock released, checkpoint resume-ready.

## G.1 — Multi-tenant SaaS layer removed (2026-09-30)

- **Decision:** pg4 is a local tool with one operator. The unwired SaaS
  layer is removed: the HTTP control plane (`api/control_plane.ts`), the
  Postgres tenant adapter (`persistence/pg_tenant_db.ts`), the lead sinks,
  the SQL migrations with RLS (`db/migrations/`), the unused Openapi
  enrich path (`enrichment/openapi/openapi_enrich.ts`), the SERP evidence
  classifier and the pg3 CSV mapper. None of them was reachable from a CLI,
  the API server or the MCP server; only their own tests used them.
- **Kept:** the in-memory tenant repository the API server uses, so every
  company row stays tenant-scoped, and the per-field enrichment cache.
- **Alternatives:** wire Postgres + RLS for real (a week of work for a
  deployment nobody runs — rejected); keep the code dormant (it drifts and
  reads as a feature that exists — rejected).
- **Migration:** everything is recoverable from git at `01141dc`. The
  activation steps in `gdpr/PRODUCTION_ACTIVATION_CHECKLIST.md` §1 start
  from restoring those files.

## H — PR B: layer boundaries enforced in lint (2026-09-30)

- **Layers (bottom-up):** L0 `types/config/util/runtime/io/geo/api` (pure
  contracts, no business logic) → L1 `providers/persistence/compliance/browser`
  (reusable capabilities) → L2 `enrichment/judgment/discovery/coverage`
  (domain engines) → L3 `cli/server/scripts` (thin shells, may import
  anything). Enforced with `no-restricted-imports` in `eslint.config.mjs`;
  verified with probe imports that fail the lint in both directions.
- **`api/` is L0, not L3:** `src/api/types.ts` imports nothing — it is a pure
  contract the domain engines already import (`enrichment_pipeline`,
  `field_types`, `run_field_cascade`). Classifying it as a shell would have
  broken the gate on existing code.
- **`FinancialSource` moved** from `enrichment/financial/financial_types.ts`
  to `types/financial.ts`: it was the only upward edge (`types/lead.ts` →
  `enrichment/`). Type-only move, no importers left on the old path (knip
  confirms), all 1502 unit tests unchanged.
- **Deliberately not done:** no file moves (the tree is already layered —
  no `cli`↔`server` or engine→shell import exists today); tests stay exempt
  so fixtures can wire any layer.

## 2026-10-02 — PR B, file moves (structure and names)

- `src/scripts/` is gone: its four entry points live in `src/cli/`, and the
  output checks are a library in `src/io/validation/output_validator.ts` with a
  thin `src/cli/validate_output.ts` shell (the post-run hooks import the
  library, never a CLI).
- Geography lives in `src/geo/` (`italy_geo`, `regions`, `comune_lookup`), all L0.
- `src/api/types.ts` → `src/types/api.ts`: one home for contracts.
- `runtime/run_coverage.ts` → `discovery/scrape_completion.ts`: it decides when a
  scrape is complete, which is discovery policy, not runtime plumbing.
- `verify_candidates` → `enrichment/website/`; `pg_*` → `pagine_gialle_*`;
  `providers/openapi/` → `providers/openapi_it/`.
- `mock_http` stays in `src/cli/`: the `--mock-http` flag of the shipped CLI
  uses it, so it cannot move to `tests/helpers`.
- The recovery patch guard allowlist and the recovery agent's source context
  follow the new paths in the same change.
