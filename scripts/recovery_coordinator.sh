#!/usr/bin/env bash
# Durable bridge between a partial VPS scrape and the GitHub Actions recovery agent.
# The queue contains only the compact recovery envelope, never CSV/JSONL lead data.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
ACTION="${1:-}"; shift || true
OUT=""; CELL=""; ENVELOPE=""; COMMAND_JSON=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --cell) CELL="$2"; shift 2 ;;
    --envelope) ENVELOPE="$2"; shift 2 ;;
    --command-json) COMMAND_JSON="$2"; shift 2 ;;
    *) echo "unknown recovery option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "--out required" >&2; exit 2; }
QUEUE="$OUT/.recovery"; mkdir -p "$QUEUE"

state_path() { printf '%s/%s.json' "$QUEUE" "$1"; }

block_state() {
  local state="$1" reason="$2"
  node - "$state" "$reason" <<'NODE'
const fs = require('fs');
const [statePath, reason] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.status = 'blocked';
state.block_reason = reason;
state.updated_at = new Date().toISOString();
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
NODE
}

case "$ACTION" in
  enqueue)
    [ -n "$CELL" ] && [ -n "$ENVELOPE" ] && [ -n "$COMMAND_JSON" ] || { echo "enqueue needs --cell --envelope --command-json" >&2; exit 2; }
    [ -f "$ENVELOPE" ] || { echo "recovery envelope missing: $ENVELOPE" >&2; exit 2; }
    LOCK="$QUEUE/.${CELL}.lock"
    if ! mkdir "$LOCK" 2>/dev/null; then echo "recovery state locked for $CELL" >&2; exit 1; fi
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
    STATE="$(state_path "$CELL")"
    STATE_JSON="$(node - "$STATE" "$ENVELOPE" "$CELL" "$COMMAND_JSON" <<'NODE'
const fs = require('fs');
const [statePath, envelopePath, cell, commandJson] = process.argv.slice(2);
const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
let state = {};
try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
const same = state.incident_id === envelope.incident_id;
const attempts = same ? Number(state.attempts || 0) + 1 : 1;
state = {
  version: 1, cell, incident_id: envelope.incident_id, envelope,
  command: JSON.parse(commandJson), attempts,
  status: attempts >= 2 ? 'blocked' : 'pending',
  updated_at: new Date().toISOString(),
};
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
process.stdout.write(JSON.stringify(state));
NODE
)"
    echo "$STATE_JSON"
    status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).status)' "$STATE_JSON")"
    if [ "$status" = "pending" ] && { [ -z "${GH_RECOVERY_TOKEN:-}" ] || [ -z "${GH_REPOSITORY:-}" ]; }; then
      node - "$STATE" <<'NODE'
const fs = require('fs'); const p = process.argv[2]; const state = JSON.parse(fs.readFileSync(p, 'utf8'));
state.status = 'blocked'; state.block_reason = 'GitHub recovery credentials are not configured'; state.updated_at = new Date().toISOString();
fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
NODE
      echo "GitHub recovery credentials are not configured; recovery blocked" >&2
      exit 1
    fi
    if [ "$status" = "pending" ]; then
      payload="$(node -e 'const s=JSON.parse(process.argv[1]); console.log(JSON.stringify({event_type:"pg4_recovery_requested",client_payload:{incident_id:s.incident_id, envelope:s.envelope, command:s.command}}))' "$STATE_JSON")"
      if ! curl -fsSL -X POST \
        -H "Authorization: Bearer $GH_RECOVERY_TOKEN" \
        -H 'Accept: application/vnd.github+json' \
        -H 'X-GitHub-Api-Version: 2022-11-28' \
        -H 'Content-Type: application/json' \
        "https://api.github.com/repos/$GH_REPOSITORY/dispatches" \
        --data "$payload" >/dev/null; then
        node - "$STATE" <<'NODE'
const fs = require('fs'); const p = process.argv[2]; const state = JSON.parse(fs.readFileSync(p, 'utf8'));
state.status = 'blocked'; state.block_reason = 'GitHub recovery dispatch failed'; state.updated_at = new Date().toISOString();
fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
NODE
        exit 1
      fi
    fi
    ;;
  pending)
    node - "$QUEUE" <<'NODE'
const fs = require('fs'), path = require('path');
const pending = fs.readdirSync(process.argv[2]).filter(x => x.endsWith('.json')).some(x => {
  try { return JSON.parse(fs.readFileSync(path.join(process.argv[2], x), 'utf8')).status === 'pending'; } catch { return false; }
});
process.exit(pending ? 0 : 1);
NODE
    ;;
  blocked)
    node - "$QUEUE" <<'NODE'
const fs = require('fs'), path = require('path');
const blocked = fs.readdirSync(process.argv[2]).filter(x => x.endsWith('.json')).some(x => {
  try { return JSON.parse(fs.readFileSync(path.join(process.argv[2], x), 'utf8')).status === 'blocked'; } catch { return false; }
});
process.exit(blocked ? 0 : 1);
NODE
    ;;
  wait-and-resume)
    [ -n "${GH_RECOVERY_TOKEN:-}" ] && [ -n "${GH_REPOSITORY:-}" ] || { echo "GH_RECOVERY_TOKEN and GH_REPOSITORY required" >&2; exit 2; }
    STATE="$(state_path "$CELL")"; [ -f "$STATE" ] || { echo "recovery state missing for $CELL" >&2; exit 2; }
    state_status="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).status)' "$STATE")"
    [ "$state_status" = "pending" ] || { echo "recovery for $CELL is $state_status" >&2; exit 1; }
    # The workflow run name contains the incident id. Polling avoids exposing a VPS webhook.
    timeout="${RECOVERY_WAIT_SECONDS:-3600}"; started="$(date +%s)"
    while [ $(( $(date +%s) - started )) -lt "$timeout" ]; do
      runs="$(curl -fsSL -H "Authorization: Bearer $GH_RECOVERY_TOKEN" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$GH_REPOSITORY/actions/workflows/recovery-agent.yml/runs?event=repository_dispatch&per_page=30" || true)"
      outcome="$(node - "$STATE" "$runs" <<'NODE'
const fs = require('fs'); const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let payload = {}; try { payload = JSON.parse(process.argv[3]); } catch {}
const run = (payload.workflow_runs || []).find(r => String(r.display_title || '').includes(state.incident_id));
process.stdout.write(run ? `${run.status}:${run.conclusion || ''}` : 'missing:');
NODE
)"
      case "$outcome" in
        completed:success)
          git pull --ff-only origin main
          node - "$STATE" <<'NODE'
const { spawnSync } = require('child_process'); const fs = require('fs');
const statePath = process.argv[2]; const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const result = spawnSync(state.command[0], state.command.slice(1), { stdio: 'inherit' });
const status = result.status ?? 1;
if (status !== 0) {
  // A successful auto-fix followed by another failed recovery is the second
  // occurrence for this fingerprint. Stop here instead of looping forever.
  state.attempts = Number(state.attempts || 0) + 1;
  state.status = state.attempts >= 2 ? 'blocked' : 'pending';
  state.last_resume_exit = status;
  state.updated_at = new Date().toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}
process.exit(status);
NODE
          exit $? ;;
        completed:*)
          block_state "$STATE" "GitHub recovery workflow ended: $outcome"
          echo "recovery workflow ended: $outcome" >&2
          exit 1 ;;
      esac
      sleep 30
    done
    block_state "$STATE" "GitHub recovery workflow timed out"
    echo "recovery workflow timed out for $CELL" >&2; exit 1
    ;;
  *) echo "usage: $0 enqueue|pending|blocked|wait-and-resume --out ..." >&2; exit 2 ;;
esac
