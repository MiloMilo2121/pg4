#!/usr/bin/env bash
# Watchdog: keeps the campaign alive until ALL requested cells have their
# <slug>_<PROV>_raw.csv. If the process dies (typically: Mac sleep killing the
# nohup) it relaunches it — cells already done are skipped.
# Runs under caffeinate. Completion is verified on the FILES (not on the shared
# log), so it is specific to the requested set of provinces.
#
# Usage: bash scripts/watchdog.sh PD VR VI VE TV RO BL
# Env: CHECK_EVERY(60) OUTDIR(output/recall) SECTORS MAPS MAXPAGES (passed to the campaign)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"

if [ "${PG4_CAFFEINATED:-}" != "1" ] && command -v caffeinate >/dev/null 2>&1; then
  export PG4_CAFFEINATED=1
  exec caffeinate -i bash "${BASH_SOURCE[0]}" "$@"
fi

OUT="${OUTDIR:-output/recall}"; mkdir -p "$OUT"
CHECK_EVERY="${CHECK_EVERY:-60}"
PROVINCES=("$@"); [ ${#PROVINCES[@]} -eq 0 ] && PROVINCES=(PD VR VI VE TV RO BL)

# Slugs of the requested sectors (honours the SECTORS filter).
# read-loop instead of `mapfile` (missing in macOS bash 3.2).
SLUGS=()
while IFS= read -r __s; do [ -n "$__s" ] && SLUGS+=("$__s"); done < <(node -e '
  const fs=require("fs");
  const f=(process.env.SECTORS||"").split(",").map(x=>x.trim()).filter(Boolean);
  for(const s of JSON.parse(fs.readFileSync("data/reference/sectors.json","utf8")).sectors){
    if(f.length && !f.includes(s.slug)) continue; console.log(s.slug);
  }')

# Recovery state is scoped to the campaign this watchdog owns. An old blocked
# incident from another province/sector must not freeze unrelated healthy work.
RECOVERY_CELLS=()
for __prov in "${PROVINCES[@]}"; do
  for __slug in "${SLUGS[@]}"; do
    RECOVERY_CELLS+=("${__slug}_${__prov}")
  done
done
RECOVERY_CELLS_CSV="$(IFS=,; printf '%s' "${RECOVERY_CELLS[*]}")"

all_cells_done() {
  local prov slug
  for prov in "${PROVINCES[@]}"; do
    for slug in "${SLUGS[@]}"; do
      pnpm exec tsx src/scripts/verify_completion.ts "$OUT/${slug}_${prov}_raw.csv" >/dev/null 2>&1 || return 1
    done
  done
  return 0
}
# Liveness via a PID file owned by THIS watchdog: pgrep on the command line
# would also match campaigns from OTHER worktrees on the same machine
# (measured: a sibling worktree's scrape kept this watchdog waiting forever,
# campaign never launched). The PID of OUR nohup is worktree-specific by
# construction; pid + start-time + command line (see scripts/lib/pidfile.sh)
# make it immune to PID reuse after sleep/reboot.
# shellcheck source=lib/pidfile.sh
. "$ROOT/scripts/lib/pidfile.sh"
CAMPAIGN_PIDFILE="$OUT/.watchdog_campaign.pid"
campaign_running() {
  pidfile_alive "$CAMPAIGN_PIDFILE" "scripts/campaign.sh"
}

# The GitHub Actions recovery path exists ONLY with credentials configured.
# Without them (laptop setup: the documented decision is "watchdog +
# checkpoint + gate are enough"), every PARTIAL cell produces a
# `blocked: credentials not configured` state and the branches below would
# freeze the watchdog forever ("intervento manuale richiesto" in a loop) —
# measured: the logistics campaign never started. Local recovery is already
# the campaign's checkpoint resume, so without credentials the branches are skipped.
RECOVERY_ENABLED=0
[ -n "${GH_RECOVERY_TOKEN:-}" ] && [ -n "${GH_REPOSITORY:-}" ] && RECOVERY_ENABLED=1

echo "[watchdog $(date +%H:%M:%S)] avvio — province: ${PROVINCES[*]} · settori: ${#SLUGS[@]} · recovery GH: $RECOVERY_ENABLED"
restarts=0
while true; do
  if all_cells_done; then
    echo "[watchdog $(date +%H:%M:%S)] tutte le celle presenti — fine"
    rm -f "$CAMPAIGN_PIDFILE"
    break
  fi
  if [ "$RECOVERY_ENABLED" = "1" ] && bash scripts/recovery_coordinator.sh blocked --out "$OUT" --cells "$RECOVERY_CELLS_CSV"; then
    echo "[watchdog $(date +%H:%M:%S)] recovery bloccata — intervento manuale richiesto"
    sleep "$CHECK_EVERY"
    continue
  fi
  if [ "$RECOVERY_ENABLED" = "1" ] && bash scripts/recovery_coordinator.sh pending --out "$OUT" --cells "$RECOVERY_CELLS_CSV"; then
    echo "[watchdog $(date +%H:%M:%S)] recovery pending — waiting for GitHub Actions"
    # Cells are resumed by the coordinator once the recovery PR is merged.
    for cell in "${RECOVERY_CELLS[@]}"; do
      state="$OUT/.recovery/$cell.json"
      [ -f "$state" ] || continue
      bash scripts/recovery_coordinator.sh wait-and-resume --out "$OUT" --cell "$cell" || true
    done
    sleep "$CHECK_EVERY"
    continue
  fi
  if ! campaign_running; then
    restarts=$((restarts+1))
    echo "[watchdog $(date +%H:%M:%S)] campagna non attiva — (ri)lancio #$restarts"
    nohup bash scripts/campaign.sh "${PROVINCES[@]}" >> "$OUT/_watchdog_driver.out" 2>&1 &
    pidfile_write "$CAMPAIGN_PIDFILE" "$!"
    sleep 15
  fi
  sleep "$CHECK_EVERY"
done
