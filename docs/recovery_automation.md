# Recovery automation

A raw CSV is no longer completion evidence. Every live scrape writes:

- `<target>.coverage.json`: all completed, verified-empty, and failed PG/Maps queries.
- `<target>.complete.json`: exists only when there are no failures.
- `<target>.recovery.json`: compact, redacted incident envelope when recovery is needed.

`scripts/campaign.sh` skips only the completion marker. A partial cell returns exit code `1`, keeps its output for inspection, and queues the failed checkpoint keys for recovery. A graceful interrupt writes a `partial` manifest without a completion marker (and without an empty recovery envelope), so the watchdog resumes it rather than silently skipping the cell.

## GitHub configuration

Create the repository secret `OPENROUTER_API_KEY`. The recovery workflow defaults to `anthropic/claude-opus-4-8` through OpenRouter. Give the recovery workflow token or GitHub App permission to create branches/PRs and merge its own PR after the CI checks pass; branch protection must explicitly allow that bot.

On the VPS set `GH_REPOSITORY` and `GH_RECOVERY_TOKEN` with permission to dispatch and read Actions runs. The coordinator sends only the incident envelope and exact rerun command. It does not upload lead CSV, JSONL, screenshots, page HTML, or provider keys.

## Runtime behavior

The GitHub workflow creates a recovery branch, requests a constrained source/test patch, runs typecheck, tests, lint and a separate AI review, then auto-merges only if all gates pass. `OPENROUTER_API_KEY` is scoped only to the two model-invocation steps, never to install, test, lint, or the generated patch itself. The VPS persists both an incident id and a recovery-attempt number before dispatching; this prevents a retry from matching an older successful Actions run. A verified rerun closes the queue state. A repeated fingerprint receives at most two complete recovery cycles; a different fingerprint starts a fresh cycle, while a third recurrence is marked `blocked`. Fatal/preflight/timeout failures exhausted by the campaign backstop are also persisted as explicit blocked incidents instead of being reported as campaign completion.
