#!/usr/bin/env bash
# Watchdog: mantiene viva la campagna finché TUTTE le celle richieste hanno il
# loro <slug>_<PROV>_raw.csv. Se il processo muore (tipicamente: sospensione del
# Mac che uccide il nohup) la rilancia — le celle già fatte vengono saltate.
# Gira sotto caffeinate. Il completamento è verificato sui FILE (non sul log
# condiviso), quindi è specifico del set di province richiesto.
#
# Uso: bash scripts/watchdog.sh PD VR VI VE TV RO BL
# Env: CHECK_EVERY(60) OUTDIR(output/recall) SECTORS MAPS MAXPAGES (passati alla campagna)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"

if [ "${PG4_CAFFEINATED:-}" != "1" ] && command -v caffeinate >/dev/null 2>&1; then
  export PG4_CAFFEINATED=1
  exec caffeinate -i bash "${BASH_SOURCE[0]}" "$@"
fi

OUT="${OUTDIR:-output/recall}"; mkdir -p "$OUT"
CHECK_EVERY="${CHECK_EVERY:-60}"
PROVINCES=("$@"); [ ${#PROVINCES[@]} -eq 0 ] && PROVINCES=(PD VR VI VE TV RO BL)

# slugs dei settori richiesti (rispetta il filtro SECTORS).
# read-loop invece di `mapfile` (assente in bash 3.2 di macOS).
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
# Liveness via PID-file di proprietà di QUESTO watchdog: pgrep sulla command
# line matcherebbe anche le campagne di ALTRI worktree sulla stessa macchina
# (misurato: lo scrape di un worktree gemello teneva questo watchdog in attesa
# per sempre, campagna mai lanciata). kill -0 sul PID del NOSTRO nohup è
# worktree-specifico per costruzione.
CAMPAIGN_PIDFILE="$OUT/.watchdog_campaign.pid"
campaign_running() {
  local pid
  [ -f "$CAMPAIGN_PIDFILE" ] || return 1
  pid="$(cat "$CAMPAIGN_PIDFILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Il percorso di recovery via GitHub Actions esiste SOLO con le credenziali
# configurate. Senza (setup laptop: la decisione documentata è "bastano
# watchdog + checkpoint + gate"), ogni cella PARTIAL produce uno stato
# `blocked: credentials not configured` e i rami sotto congelerebbero il
# watchdog per sempre ("intervento manuale richiesto" in loop) — misurato:
# la campagna logistica non partiva. Il recupero locale è già il resume
# da checkpoint della campagna, quindi senza credenziali i rami si saltano.
RECOVERY_ENABLED=0
[ -n "${GH_RECOVERY_TOKEN:-}" ] && [ -n "${GH_REPOSITORY:-}" ] && RECOVERY_ENABLED=1

echo "[watchdog $(date +%H:%M:%S)] avvio — province: ${PROVINCES[*]} · settori: ${#SLUGS[@]} · recovery GH: $RECOVERY_ENABLED"
restarts=0
while true; do
  if all_cells_done; then
    echo "[watchdog $(date +%H:%M:%S)] tutte le celle presenti — fine"
    break
  fi
  if [ "$RECOVERY_ENABLED" = "1" ] && bash scripts/recovery_coordinator.sh blocked --out "$OUT" --cells "$RECOVERY_CELLS_CSV"; then
    echo "[watchdog $(date +%H:%M:%S)] recovery bloccata — intervento manuale richiesto"
    sleep "$CHECK_EVERY"
    continue
  fi
  if [ "$RECOVERY_ENABLED" = "1" ] && bash scripts/recovery_coordinator.sh pending --out "$OUT" --cells "$RECOVERY_CELLS_CSV"; then
    echo "[watchdog $(date +%H:%M:%S)] recovery pending — waiting for GitHub Actions"
    # Cells are resumed by the coordinator after a successful auto-merge.
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
    echo $! > "$CAMPAIGN_PIDFILE"
    sleep 15
  fi
  sleep "$CHECK_EVERY"
done
