# Recovery automation

A raw CSV is no longer completion evidence. Every live scrape writes:

- `<target>.coverage.json`: all completed, verified-empty, and failed PG/Maps queries.
- `<target>.complete.json`: exists only when there are no failures.
- `<target>.recovery.json`: compact, redacted incident envelope when recovery is needed.

`scripts/campaign.sh` skips only the completion marker. A partial cell returns exit code `1`, keeps its output for inspection, and queues the failed checkpoint keys for recovery.

## GitHub configuration

Create the repository secret `OPENROUTER_API_KEY`. The recovery workflow defaults to `anthropic/claude-opus-4-8` through OpenRouter. Give the recovery workflow token or GitHub App permission to create branches/PRs and merge its own PR after the CI checks pass; branch protection must explicitly allow that bot.

On the VPS set `GH_REPOSITORY` and `GH_RECOVERY_TOKEN` with permission to dispatch and read Actions runs. The coordinator sends only the incident envelope and exact rerun command. It does not upload lead CSV, JSONL, screenshots, page HTML, or provider keys.

## Runtime behavior

The GitHub workflow creates a recovery branch, requests a constrained source/test patch, runs typecheck, tests, lint and a separate AI review, then auto-merges only if all gates pass. The VPS polls that named workflow, fast-forwards `main`, and re-runs the one affected cell. A repeated failure of the same incident is marked `blocked` after the second occurrence; no endless retry loop is allowed.
