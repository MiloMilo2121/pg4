# Recovery automation

A raw CSV is no longer completion evidence. Every live scrape writes:

- `<target>.coverage.json`: every started PG/Maps query, with terminal `success`, explicit `empty_verified`, or `failed` outcome.
- `<target>.complete.json`: a separate completion manifest, written only when every query is terminal and the CSV+JSONL artifacts exist.
- `<target>.recovery.json`: compact, redacted incident envelope when recovery is needed.

`scripts/campaign.sh` uses the same validator as the TypeScript runtime; it does not infer completion from a CSV. A partial cell returns exit code `1`, keeps its output for inspection, and queues only failed checkpoint keys for recovery. A graceful interrupt writes a `partial` manifest without a completion marker or recovery envelope, so the watchdog resumes pending work before any code-recovery dispatch. Unresolved browser failures retain a request URL, bounded title, DOM fingerprint, and a relative screenshot reference; no page HTML is persisted in the envelope. The local coverage manifest retains every failure, while the dispatched diagnostic envelope is bounded to 20 sanitized failures so it cannot become a log or data transfer channel.

## GitHub configuration

Create repository secrets `OPENROUTER_API_KEY` and `RECOVERY_GH_TOKEN`. The recovery workflow defaults to `anthropic/claude-opus-4-8` through OpenRouter. `RECOVERY_GH_TOKEN` must be a fine-grained token or GitHub App token with only the repository permissions needed to push a recovery branch, create/read/merge its PR, and read Actions checks; branch protection must explicitly allow that bot. It is deliberately not the ephemeral default Actions token, because PR checks triggered by that token can require human approval before they run.

On the VPS set `GH_REPOSITORY` and `GH_RECOVERY_TOKEN` with permission to dispatch and read Actions runs. The coordinator sends only the compact envelope; the rerun command remains in the local queue state. It does not upload lead CSV, JSONL, screenshots, page HTML, command output, or provider keys. A manual workflow dispatch must supply both the 24-character incident id and the same compact JSON envelope.

## Runtime behavior

The GitHub workflow validates the envelope before materializing it, serializes duplicate deliveries by incident id, requests a constrained source/test patch, runs typecheck, tests, lint and a separate AI review, then auto-merges only if all gates pass. `OPENROUTER_API_KEY` is scoped only to the two model-invocation steps, never to install, test, lint, or the generated patch itself. The VPS writes queue state atomically, persists dispatch intent before the HTTP call, reconciles a crash window with an Actions lookup, and reclaims only stale per-cell locks. A verified completion manifest is required after the rerun before the queue closes. A repeated fingerprint receives at most two complete recovery cycles; a different fingerprint starts a fresh cycle, while a third recurrence is marked `blocked`. Malformed queue state, fatal/preflight/timeout failures, and dispatches that fail three times are explicit operational incidents rather than campaign completion.

The ordinary CI also audits the exact installed production graph through npm's current bulk advisory API. This avoids `pnpm audit`'s retired legacy endpoint without creating a second lockfile that could drift from `pnpm-lock.yaml`.
