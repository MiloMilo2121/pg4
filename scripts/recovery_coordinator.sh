#!/usr/bin/env bash
# Durable bridge between a partial VPS scrape and the GitHub Actions recovery agent.
# The queue contains only the compact recovery envelope, never CSV/JSONL lead data.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
ACTION="${1:-}"; shift || true
OUT=""; CELL=""; ENVELOPE=""; COMMAND_JSON=""; REASON=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --cell) CELL="$2"; shift 2 ;;
    --envelope) ENVELOPE="$2"; shift 2 ;;
    --command-json) COMMAND_JSON="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    *) echo "unknown recovery option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "--out required" >&2; exit 2; }
QUEUE="$OUT/.recovery"; mkdir -p "$QUEUE"

state_path() { printf '%s/%s.json' "$QUEUE" "$1"; }

validate_cell() {
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || {
    echo "invalid recovery cell (use only letters, digits, _ and -): $1" >&2
    exit 2
  }
}

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

dispatch_state() {
  local state="$1" state_json payload
  state_json="$(cat "$state")"
  payload="$(node -e 'const s=JSON.parse(process.argv[1]); console.log(JSON.stringify({event_type:"pg4_recovery_requested",client_payload:{incident_id:s.incident_id,recovery_attempt:Number(s.attempts || 1), envelope:s.envelope, command:s.command}}))' "$state_json")"
  if ! curl -fsSL -X POST \
    -H "Authorization: Bearer $GH_RECOVERY_TOKEN" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -H 'Content-Type: application/json' \
    "https://api.github.com/repos/$GH_REPOSITORY/dispatches" \
    --data "$payload" >/dev/null; then
    node - "$state" <<'NODE'
const fs = require('fs'); const p = process.argv[2]; const state = JSON.parse(fs.readFileSync(p, 'utf8'));
state.status = 'blocked'; state.block_reason = 'GitHub recovery dispatch failed'; state.updated_at = new Date().toISOString();
fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
NODE
    return 1
  fi
  node - "$state" <<'NODE'
const fs = require('fs'); const p = process.argv[2]; const state = JSON.parse(fs.readFileSync(p, 'utf8'));
state.dispatched_attempt = Number(state.attempts || 1);
state.dispatched_at = new Date().toISOString();
fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
NODE
}

case "$ACTION" in
  block)
    [ -n "$CELL" ] && [ -n "$REASON" ] || { echo "block needs --cell --reason" >&2; exit 2; }
    validate_cell "$CELL"
    LOCK="$QUEUE/.${CELL}.lock"
    if ! mkdir "$LOCK" 2>/dev/null; then echo "recovery state locked for $CELL" >&2; exit 1; fi
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
    STATE="$(state_path "$CELL")"
    node - "$STATE" "$CELL" "$REASON" <<'NODE'
const fs = require('fs');
const [statePath, cell, reason] = process.argv.slice(2);
let state = {};
try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
state = { ...state, version: 1, cell, status: 'blocked', block_reason: reason, updated_at: new Date().toISOString() };
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
NODE
    ;;
  enqueue)
    [ -n "$CELL" ] && [ -n "$ENVELOPE" ] && [ -n "$COMMAND_JSON" ] || { echo "enqueue needs --cell --envelope --command-json" >&2; exit 2; }
    validate_cell "$CELL"
    [ -f "$ENVELOPE" ] || { echo "recovery envelope missing: $ENVELOPE" >&2; exit 2; }
    LOCK="$QUEUE/.${CELL}.lock"
    if ! mkdir "$LOCK" 2>/dev/null; then echo "recovery state locked for $CELL" >&2; exit 1; fi
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
    STATE="$(state_path "$CELL")"
    STATE_JSON="$(node - "$STATE" "$ENVELOPE" "$CELL" "$COMMAND_JSON" <<'NODE'
const fs = require('fs');
const [statePath, envelopePath, cell, commandJson] = process.argv.slice(2);
const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
let previous = {};
try { previous = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
const same = previous.incident_id === envelope.incident_id;
// A duplicate enqueue is not a second recovery cycle. The cell may be seen by
// campaign and watchdog at the same time; only a completed workflow followed
// by a failed rerun is allowed to consume the next recovery attempt.
const state = same
  ? previous
  : {
      version: 1, cell, incident_id: envelope.incident_id, envelope,
      command: JSON.parse(commandJson), attempts: 1,
      status: 'pending', updated_at: new Date().toISOString(),
    };
if (!same) fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
process.stdout.write(JSON.stringify({ ...state, _dispatch: !same }));
NODE
)"
    echo "$STATE_JSON"
    status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).status)' "$STATE_JSON")"
    should_dispatch="$(node -e 'process.stdout.write(JSON.parse(process.argv[1])._dispatch ? "yes" : "no")' "$STATE_JSON")"
    if [ "$status" = "pending" ] && { [ -z "${GH_RECOVERY_TOKEN:-}" ] || [ -z "${GH_REPOSITORY:-}" ]; }; then
      node - "$STATE" <<'NODE'
const fs = require('fs'); const p = process.argv[2]; const state = JSON.parse(fs.readFileSync(p, 'utf8'));
state.status = 'blocked'; state.block_reason = 'GitHub recovery credentials are not configured'; state.updated_at = new Date().toISOString();
fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n');
NODE
      echo "GitHub recovery credentials are not configured; recovery blocked" >&2
      exit 1
    fi
    if [ "$status" = "pending" ] && [ "$should_dispatch" = "yes" ]; then
      if ! dispatch_state "$STATE"; then exit 1; fi
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
    validate_cell "$CELL"
    LOCK="$QUEUE/.${CELL}.lock"
    if ! mkdir "$LOCK" 2>/dev/null; then echo "recovery state locked for $CELL" >&2; exit 1; fi
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
    STATE="$(state_path "$CELL")"; [ -f "$STATE" ] || { echo "recovery state missing for $CELL" >&2; exit 2; }
    state_status="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).status)' "$STATE")"
    [ "$state_status" = "pending" ] || { echo "recovery for $CELL is $state_status" >&2; exit 1; }
    # A crash after persisting `pending` but before the GitHub dispatch must not
    # strand the queue: dispatch attempt N exactly once before waiting for run N.
    needs_dispatch="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));process.stdout.write(Number(s.dispatched_attempt||0) === Number(s.attempts||1) ? "no" : "yes")' "$STATE")"
    if [ "$needs_dispatch" = "yes" ]; then
      echo "dispatch missing for recovery $CELL attempt $(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));process.stdout.write(String(s.attempts||1))' "$STATE"); dispatching"
      if ! dispatch_state "$STATE"; then exit 1; fi
    fi
    # The workflow run name contains the incident id. Polling avoids exposing a VPS webhook.
    timeout="${RECOVERY_WAIT_SECONDS:-3600}"; started="$(date +%s)"
    while [ $(( $(date +%s) - started )) -lt "$timeout" ]; do
      runs="$(curl -fsSL -H "Authorization: Bearer $GH_RECOVERY_TOKEN" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$GH_REPOSITORY/actions/workflows/recovery-agent.yml/runs?event=repository_dispatch&per_page=30" || true)"
      outcome="$(node - "$STATE" "$runs" <<'NODE'
const fs = require('fs'); const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let payload = {}; try { payload = JSON.parse(process.argv[3]); } catch {}
const label = `Recovery ${state.incident_id} attempt ${Number(state.attempts || 1)}`;
const run = (payload.workflow_runs || []).find(r => String(r.display_title || '').includes(label));
process.stdout.write(run ? `${run.status}:${run.conclusion || ''}` : 'missing:');
NODE
)"
      case "$outcome" in
        completed:success)
          git pull --ff-only origin main
          resume_rc=0
          node - "$STATE" <<'NODE' || resume_rc=$?
const { spawnSync } = require('child_process'); const fs = require('fs');
const statePath = process.argv[2]; const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const result = spawnSync(state.command[0], state.command.slice(1), { stdio: 'inherit' });
const status = result.status ?? 1;
state.last_resume_exit = status;
state.updated_at = new Date().toISOString();
if (status === 0) {
  // The rerun wrote its verified completion marker. Leaving this state pending
  // makes watchdog poll the already-finished workflow and re-run the cell
  // forever, so close the queue entry durably before returning.
  state.status = 'complete';
  state.completed_at = state.updated_at;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
} else {
  if (status === 130) {
    // An operator/host interruption is not evidence that the code patch failed.
    // Keep this recovery cycle pending so watchdog can resume the cell without
    // dispatching or burning another recovery attempt.
    state.status = 'pending';
    state.resume_interrupted = true;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
    process.exit(status);
  }
  const outputCsv = typeof state.envelope?.output_csv === 'string' ? state.envelope.output_csv : '';
  const recoveryPath = outputCsv.replace(/\.csv$/i, '.recovery.json');
  let nextEnvelope = null;
  try { nextEnvelope = JSON.parse(fs.readFileSync(recoveryPath, 'utf8')); } catch {}
  if (nextEnvelope?.incident_id && nextEnvelope.incident_id !== state.incident_id) {
    // The rerun has reached a NEW diagnosed failure. It gets its own recovery
    // cycle; only a repeated fingerprint counts toward the two-attempt stop.
    const nextState = {
      version: 1, cell: state.cell, incident_id: nextEnvelope.incident_id,
      envelope: nextEnvelope, command: state.command, attempts: 1,
      status: 'pending', updated_at: state.updated_at,
    };
    fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2) + '\n');
    process.exit(10);
  }
  // The first recurrence earns one more recovery cycle. Once two workflows
  // have already been applied to the same evidence fingerprint, stop with an
  // explicit incident rather than dispatching an infinite patch loop.
  const attempts = Number(state.attempts || 1);
  if (attempts >= 2) {
    state.status = 'blocked';
    state.block_reason = 'same evidence fingerprint remained after two recovery cycles';
  } else {
    state.attempts = attempts + 1;
    state.status = 'pending';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
    process.exit(10);
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}
process.exit(status);
NODE
          if [ "$resume_rc" -eq 10 ]; then
            echo "recovery cycle still needed for $CELL; dispatching the next bounded cycle"
            dispatch_state "$STATE"
            exit $?
          fi
          exit "$resume_rc" ;;
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
