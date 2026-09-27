#!/usr/bin/env bash
# Durable bridge between a partial VPS scrape and the GitHub Actions recovery agent.
# The queue contains only a compact recovery envelope, never CSV/JSONL lead data.
# State writes are delegated to recovery_state.js (validate + temp/rename).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
ACTION="${1:-}"; shift || true
OUT=""; CELL=""; ENVELOPE=""; COMMAND_JSON=""; REASON=""; CELLS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --cell) CELL="$2"; shift 2 ;;
    --cells) CELLS="$2"; shift 2 ;;
    --envelope) ENVELOPE="$2"; shift 2 ;;
    --command-json) COMMAND_JSON="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    *) echo "unknown recovery option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "--out required" >&2; exit 2; }
QUEUE="$OUT/.recovery"; mkdir -p "$QUEUE"
STATE_TOOL="$ROOT/scripts/recovery_state.js"
[ -f "$STATE_TOOL" ] || { echo "missing recovery state helper: $STATE_TOOL" >&2; exit 2; }

state_path() { printf '%s/%s.json' "$QUEUE" "$1"; }
state_read() { node "$STATE_TOOL" read "$1"; }
state_write() { node "$STATE_TOOL" write "$1"; }
state_patch() { node "$STATE_TOOL" patch "$1" "$2"; }
write_state_json() { printf '%s' "$2" | state_write "$1"; }

validate_cell() {
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || {
    echo "invalid recovery cell (use only letters, digits, _ and -): $1" >&2
    exit 2
  }
}

validate_cells() {
  [ -z "$CELLS" ] && return 0
  local candidate
  IFS=',' read -r -a _cells <<< "$CELLS"
  for candidate in "${_cells[@]}"; do
    validate_cell "$candidate"
  done
}

LOCK=""
LOCK_TTL_SECONDS="${RECOVERY_LOCK_TTL_SECONDS:-7200}"
lock_is_stale() {
  local owner="$1/owner" pid started now
  [ -f "$owner" ] || return 0
  read -r pid started < "$owner" || return 0
  [[ "$pid" =~ ^[0-9]+$ && "$started" =~ ^[0-9]+$ ]] || return 0
  now="$(date +%s)"
  [ $(( now - started )) -ge "$LOCK_TTL_SECONDS" ] && return 0
  kill -0 "$pid" 2>/dev/null || return 0
  return 1
}

acquire_lock() {
  LOCK="$QUEUE/.${CELL}.lock"
  if mkdir "$LOCK" 2>/dev/null; then
    printf '%s %s\n' "$$" "$(date +%s)" > "$LOCK/owner"
    return 0
  fi
  if lock_is_stale "$LOCK"; then
    echo "reclaiming stale recovery lock for $CELL" >&2
    rm -f "$LOCK/owner" 2>/dev/null || true
    rmdir "$LOCK" 2>/dev/null || {
      echo "could not reclaim stale recovery lock for $CELL" >&2
      return 1
    }
    if mkdir "$LOCK" 2>/dev/null; then
      printf '%s %s\n' "$$" "$(date +%s)" > "$LOCK/owner"
      return 0
    fi
  fi
  echo "recovery state locked for $CELL" >&2
  return 1
}

release_lock() {
  [ -n "$LOCK" ] || return 0
  rm -f "$LOCK/owner" 2>/dev/null || true
  rmdir "$LOCK" 2>/dev/null || true
}

json_block_patch() {
  node -e 'console.log(JSON.stringify({status:"blocked",block_reason:process.argv[1]}))' "$1"
}

block_state() {
  local state="$1" cell="$2" reason="$3" current patch fresh
  patch="$(json_block_patch "$reason")"
  if [ -f "$state" ]; then
    if ! current="$(state_read "$state")"; then
      echo "cannot overwrite corrupt recovery state: $state" >&2
      return 1
    fi
    state_patch "$state" "$patch" >/dev/null
    return 0
  fi
  fresh="$(node - "$cell" "$reason" <<'NODE'
const [cell, reason] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  version: 1, cell, status: 'blocked', block_reason: reason, updated_at: new Date().toISOString(),
}));
NODE
)"
  write_state_json "$state" "$fresh"
}

workflow_outcome() {
  local state="$1" state_json runs
  state_json="$(state_read "$state")" || return 65
  # 35 default cells exceeded the old `per_page=30` window. A title-matched
  # recovery cycle is always recent, and 100 covers the default campaign plus
  # headroom without silently losing the oldest five cells.
  runs="$(curl -fsSL -H "Authorization: Bearer $GH_RECOVERY_TOKEN" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$GH_REPOSITORY/actions/workflows/recovery-agent.yml/runs?event=repository_dispatch&per_page=100&page=1" || true)"
  node - "$state_json" "$runs" <<'NODE'
const state = JSON.parse(process.argv[2]);
let payload;
try { payload = JSON.parse(process.argv[3]); } catch { process.stdout.write('unavailable:'); process.exit(0); }
const label = `Recovery ${state.incident_id} attempt ${Number(state.attempts || 1)}`;
const run = (payload.workflow_runs || []).find((candidate) => String(candidate.display_title || '').includes(label));
process.stdout.write(run ? `${run.status}:${run.conclusion || ''}` : 'missing:');
NODE
}

dispatch_state() {
  local state="$1" state_json attempts payload failures patch
  state_json="$(state_read "$state")" || return 1
  attempts="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).attempts || 1))' "$state_json")"
  state_patch "$state" "$(node -e 'console.log(JSON.stringify({dispatch_status:"dispatching",dispatch_attempt:Number(process.argv[1]),dispatch_requested_at:new Date().toISOString()}))' "$attempts")" >/dev/null
  state_json="$(state_read "$state")" || return 1
  payload="$(node -e 'const s=JSON.parse(process.argv[1]); console.log(JSON.stringify({event_type:"pg4_recovery_requested",client_payload:{incident_id:s.incident_id,recovery_attempt:Number(s.attempts || 1),envelope:s.envelope}}))' "$state_json")"
  if curl -fsSL -X POST \
    -H "Authorization: Bearer $GH_RECOVERY_TOKEN" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -H 'Content-Type: application/json' \
    "https://api.github.com/repos/$GH_REPOSITORY/dispatches" \
    --data "$payload" >/dev/null; then
    state_patch "$state" "$(node -e 'console.log(JSON.stringify({dispatch_status:"dispatched",dispatched_attempt:Number(process.argv[1]),dispatched_at:new Date().toISOString(),dispatch_failures:0}))' "$attempts")" >/dev/null
    return 0
  fi
  state_json="$(state_read "$state")" || return 1
  failures="$(node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(String(Number(s.dispatch_failures || 0) + 1))' "$state_json")"
  if [ "$failures" -ge 3 ]; then
    state_patch "$state" "$(node -e 'console.log(JSON.stringify({status:"blocked",dispatch_failures:Number(process.argv[1]),block_reason:"GitHub recovery dispatch failed three times"}))' "$failures")" >/dev/null
  else
    state_patch "$state" "$(node -e 'console.log(JSON.stringify({dispatch_status:"dispatching",dispatch_failures:Number(process.argv[1]),last_dispatch_error:"GitHub recovery dispatch failed"}))' "$failures")" >/dev/null
  fi
  return 1
}

ensure_dispatch() {
  local state="$1" state_json dispatch_status elapsed outcome
  state_json="$(state_read "$state")" || return 1
  dispatch_status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).dispatch_status || "ready")' "$state_json")"
  case "$dispatch_status" in
    ready) dispatch_state "$state"; return $? ;;
    dispatched) return 0 ;;
    dispatching)
      outcome="$(workflow_outcome "$state")" || return 1
      case "$outcome" in
        # `waiting`/`pending`/`requested`: the run exists (e.g. held by the
        # recovery-merge environment approval) — never re-dispatch it.
        queued:*|in_progress:*|waiting:*|pending:*|requested:*|completed:*) return 0 ;;
      esac
      elapsed="$(node -e 'const s=JSON.parse(process.argv[1]);const t=Date.parse(s.dispatch_requested_at||"");process.stdout.write(String(Number.isFinite(t)?Math.max(0,Math.floor((Date.now()-t)/1000)):999999))' "$state_json")"
      if [ "$elapsed" -lt "${RECOVERY_DISPATCH_GRACE_SECONDS:-90}" ]; then
        echo "recovery dispatch for $CELL is being reconciled (${elapsed}s grace)" >&2
        return 0
      fi
      # A crash may have happened after persisting dispatching but before (or
      # during) the HTTP response. Re-dispatch only after a grace window; the
      # workflow concurrency group serializes any duplicate delivery.
      state_patch "$state" '{"dispatch_status":"ready"}' >/dev/null
      dispatch_state "$state"
      return $?
      ;;
    *) echo "invalid recovery dispatch state for $CELL" >&2; return 1 ;;
  esac
}

resume_after_success() {
  local state="$1"
  node - "$state" "$STATE_TOOL" "$ROOT" <<'NODE'
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const [statePath, stateTool, root] = process.argv.slice(2);
const readState = () => JSON.parse(execFileSync(process.execPath, [stateTool, 'read', statePath], { encoding: 'utf8' }));
const patchState = (patch) => execFileSync(process.execPath, [stateTool, 'patch', statePath, JSON.stringify(patch)], { stdio: 'ignore' });
const writeState = (state) => execFileSync(process.execPath, [stateTool, 'write', statePath], {
  input: JSON.stringify(state), stdio: ['pipe', 'ignore', 'inherit'],
});
const state = readState();
const result = spawnSync(state.command[0], state.command.slice(1), { stdio: 'inherit', cwd: root });
let status = result.status ?? 1;
patchState({ last_resume_exit: status });
if (status === 0) {
  const outputCsv = typeof state.envelope?.output_csv === 'string' ? state.envelope.output_csv : '';
  const verification = outputCsv
    ? spawnSync('pnpm', ['exec', 'tsx', 'src/scripts/verify_completion.ts', outputCsv], { stdio: 'inherit', cwd: root })
    : { status: 1 };
  if (verification.status === 0) {
    patchState({ status: 'complete', completed_at: new Date().toISOString(), resume_interrupted: undefined });
    process.exit(0);
  }
  patchState({ status: 'blocked', block_reason: 'resume exited 0 without a verified completion manifest' });
  process.exit(1);
}
if (status === 130) {
  patchState({ status: 'pending', resume_interrupted: true });
  process.exit(130);
}
const outputCsv = typeof state.envelope?.output_csv === 'string' ? state.envelope.output_csv : '';
const recoveryPath = outputCsv.replace(/\.csv$/i, '.recovery.json');
let nextEnvelope = null;
try { nextEnvelope = JSON.parse(fs.readFileSync(recoveryPath, 'utf8')); } catch {}
if (nextEnvelope && (typeof nextEnvelope.incident_id !== 'string' || nextEnvelope.incident_id.length === 0)) {
  patchState({ status: 'blocked', block_reason: 'rerun produced an invalid recovery envelope' });
  process.exit(1);
}
if (nextEnvelope?.incident_id && nextEnvelope.incident_id !== state.incident_id) {
  writeState({
    version: 1, cell: state.cell, incident_id: nextEnvelope.incident_id,
    envelope: nextEnvelope, command: state.command, attempts: 1,
    status: 'pending', dispatch_status: 'ready', updated_at: new Date().toISOString(),
  });
  process.exit(10);
}
const attempts = Number(state.attempts || 1);
if (attempts >= 2) {
  patchState({ status: 'blocked', block_reason: 'same evidence fingerprint remained after two recovery cycles' });
  process.exit(1);
}
patchState({ attempts: attempts + 1, status: 'pending', dispatch_status: 'ready', resume_interrupted: undefined });
process.exit(10);
NODE
}

queue_has_status() {
  local wanted="$1"
  node - "$QUEUE" "$wanted" "$CELLS" <<'NODE'
const fs = require('fs'), path = require('path');
const [queue, wanted, scoped] = process.argv.slice(2);
const cells = scoped ? scoped.split(',').filter(Boolean) : fs.readdirSync(queue).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
let found = false;
let corrupt = false;
for (const cell of cells) {
  const file = path.join(queue, `${cell}.json`);
  if (!fs.existsSync(file)) continue;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || state.version !== 1 || state.cell !== cell || !['pending', 'blocked', 'complete'].includes(state.status)) throw new Error('invalid recovery state shape');
    if (state.status === 'pending' &&
      (typeof state.incident_id !== 'string' || !state.envelope || !Array.isArray(state.command) ||
        !Number.isInteger(state.attempts) || state.attempts < 1)) throw new Error('incomplete pending recovery state');
    if (state.status === wanted) found = true;
  } catch (err) {
    corrupt = true;
    process.stderr.write(`recovery state integrity incident at ${file}: ${err.message}\n`);
  }
}
// A malformed queue is operationally blocked, never an empty queue. Both
// `pending` and `blocked` must return attention-required to the watchdog.
process.exit(found || corrupt ? 0 : 1);
NODE
}

case "$ACTION" in
  block)
    [ -n "$CELL" ] && [ -n "$REASON" ] || { echo "block needs --cell --reason" >&2; exit 2; }
    validate_cell "$CELL"
    acquire_lock || exit 1
    trap release_lock EXIT
    block_state "$(state_path "$CELL")" "$CELL" "$REASON"
    ;;
  enqueue)
    [ -n "$CELL" ] && [ -n "$ENVELOPE" ] && [ -n "$COMMAND_JSON" ] || { echo "enqueue needs --cell --envelope --command-json" >&2; exit 2; }
    validate_cell "$CELL"
    [ -f "$ENVELOPE" ] || { echo "recovery envelope missing: $ENVELOPE" >&2; exit 2; }
    acquire_lock || exit 1
    trap release_lock EXIT
    STATE="$(state_path "$CELL")"
    [ ! -f "$STATE" ] || state_read "$STATE" >/dev/null || exit 1
    STATE_JSON="$(node - "$STATE" "$ENVELOPE" "$CELL" "$COMMAND_JSON" <<'NODE'
const fs = require('fs');
const [statePath, envelopePath, cell, commandJson] = process.argv.slice(2);
const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
const command = JSON.parse(commandJson);
if (envelope.version !== 1 || !/^[a-f0-9]{24}$/.test(envelope.incident_id || '') ||
  typeof envelope.run_id !== 'string' || envelope.run_id.length === 0 || envelope.run_id.length > 256 ||
  typeof envelope.generated_at !== 'string' || !Number.isFinite(Date.parse(envelope.generated_at)) ||
  typeof envelope.output_csv !== 'string' || envelope.output_csv.length === 0 || envelope.output_csv.length > 2048 ||
  !Array.isArray(envelope.failures) || envelope.failures.length === 0 || envelope.failures.length > 20 ||
  (envelope.total_failed_query_count !== undefined &&
    (!Number.isInteger(envelope.total_failed_query_count) || envelope.total_failed_query_count < envelope.failures.length)) ||
  (envelope.failures_truncated !== undefined && typeof envelope.failures_truncated !== 'boolean')) {
  throw new Error('invalid compact recovery envelope');
}
const recoveryErrorClasses = new Set([
  'network_exhausted', 'maps_no_feed', 'selector_drift', 'consent_wall',
  'blocked_or_captcha', 'checkpoint_integrity', 'unknown',
]);
for (const failure of envelope.failures) {
  if (!failure || typeof failure.key !== 'string' || failure.key.length > 512 ||
    !['pg', 'maps'].includes(failure.provider) || typeof failure.category !== 'string' || failure.category.length > 256 ||
    typeof failure.location !== 'string' || failure.location.length > 256 ||
    !recoveryErrorClasses.has(failure.error_class) ||
    (failure.page !== undefined && (!Number.isInteger(failure.page) || failure.page < 1)) ||
    (failure.reason !== undefined && (typeof failure.reason !== 'string' || failure.reason.length > 800)) ||
    (failure.url !== undefined && (typeof failure.url !== 'string' || failure.url.length > 2048)) ||
    (failure.page_title !== undefined && (typeof failure.page_title !== 'string' || failure.page_title.length > 500)) ||
    (failure.screenshot_path !== undefined && (typeof failure.screenshot_path !== 'string' || failure.screenshot_path.length > 512 ||
      failure.screenshot_path.startsWith('/') || failure.screenshot_path.split(/[\\/]/).includes('..'))) ||
    (failure.evidence_fingerprint !== undefined && !/^[a-f0-9]{8,64}$/i.test(failure.evidence_fingerprint))) {
    throw new Error('invalid recovery failure record');
  }
}
if (!Array.isArray(command) || command.length < 5 || !command.every((part) => typeof part === 'string') ||
  command[0] !== 'pnpm' || command[1] !== 'run' || command[2] !== 'scrape' || command[3] !== '--') {
  throw new Error('recovery resume command is not an approved scrape invocation');
}
let previous = null;
try { previous = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
if (previous && previous.incident_id === envelope.incident_id) {
  process.stdout.write(JSON.stringify({ state: previous, dispatch: false }));
} else {
  process.stdout.write(JSON.stringify({
    state: {
      version: 1, cell, incident_id: envelope.incident_id, envelope, command, attempts: 1,
      status: 'pending', dispatch_status: 'ready', updated_at: new Date().toISOString(),
    },
    dispatch: true,
  }));
}
NODE
)" || { echo "invalid recovery enqueue input" >&2; exit 2; }
    should_dispatch="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).dispatch ? "yes" : "no")' "$STATE_JSON")"
    state_payload="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).state))' "$STATE_JSON")"
    if [ "$should_dispatch" = "yes" ]; then
      write_state_json "$STATE" "$state_payload"
    else
      # Validate an existing queue state before trusting its status. Do not
      # overwrite malformed JSON with a new incident.
      state_read "$STATE" >/dev/null || exit 1
    fi
    status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).state.status)' "$STATE_JSON")"
    if [ "$status" = "pending" ] && { [ -z "${GH_RECOVERY_TOKEN:-}" ] || [ -z "${GH_REPOSITORY:-}" ]; }; then
      block_state "$STATE" "$CELL" "GitHub recovery credentials are not configured"
      echo "GitHub recovery credentials are not configured; recovery blocked" >&2
      exit 1
    fi
    if [ "$status" = "pending" ] && [ "$should_dispatch" = "yes" ]; then
      dispatch_state "$STATE" || exit 1
    fi
    ;;
  pending)
    validate_cells
    queue_has_status pending
    ;;
  blocked)
    validate_cells
    queue_has_status blocked
    ;;
  wait-and-resume)
    [ -n "${GH_RECOVERY_TOKEN:-}" ] && [ -n "${GH_REPOSITORY:-}" ] || { echo "GH_RECOVERY_TOKEN and GH_REPOSITORY required" >&2; exit 2; }
    [ -n "$CELL" ] || { echo "wait-and-resume needs --cell" >&2; exit 2; }
    validate_cell "$CELL"
    acquire_lock || exit 1
    trap release_lock EXIT
    STATE="$(state_path "$CELL")"; [ -f "$STATE" ] || { echo "recovery state missing for $CELL" >&2; exit 2; }
    state_json="$(state_read "$STATE")" || exit 1
    state_status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).status)' "$state_json")"
    [ "$state_status" = "pending" ] || { echo "recovery for $CELL is $state_status" >&2; exit 1; }
    ensure_dispatch "$STATE" || exit 1
    timeout="${RECOVERY_WAIT_SECONDS:-3600}"; started="$(date +%s)"
    while [ $(( $(date +%s) - started )) -lt "$timeout" ]; do
      outcome="$(workflow_outcome "$STATE")" || { sleep 30; continue; }
      case "$outcome" in
        completed:success)
          git pull --ff-only origin main
          resume_rc=0
          resume_after_success "$STATE" || resume_rc=$?
          if [ "$resume_rc" -eq 10 ]; then
            echo "recovery cycle still needed for $CELL; dispatching the next bounded cycle"
            dispatch_state "$STATE"
            exit $?
          fi
          exit "$resume_rc"
          ;;
        completed:*)
          block_state "$STATE" "$CELL" "GitHub recovery workflow ended: $outcome"
          echo "recovery workflow ended: $outcome" >&2
          exit 1
          ;;
      esac
      sleep 30
    done
    block_state "$STATE" "$CELL" "GitHub recovery workflow timed out"
    echo "recovery workflow timed out for $CELL" >&2; exit 1
    ;;
  *) echo "usage: $0 enqueue|pending|blocked|wait-and-resume --out ..." >&2; exit 2 ;;
esac
