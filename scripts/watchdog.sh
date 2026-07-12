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

# slugs dei settori richiesti (rispetta il filtro SECTORS)
mapfile -t SLUGS < <(node -e '
  const fs=require("fs");
  const f=(process.env.SECTORS||"").split(",").map(x=>x.trim()).filter(Boolean);
  for(const s of JSON.parse(fs.readFileSync("data/reference/sectors.json","utf8")).sectors){
    if(f.length && !f.includes(s.slug)) continue; console.log(s.slug);
  }')

all_cells_done() {
  local prov slug
  for prov in "${PROVINCES[@]}"; do
    for slug in "${SLUGS[@]}"; do
      [ -f "$OUT/${slug}_${prov}_raw.csv" ] || return 1
    done
  done
  return 0
}
campaign_running() {
  pgrep -f "scripts/campaign.sh" >/dev/null 2>&1 || pgrep -f "cli/scrape.ts" >/dev/null 2>&1
}

echo "[watchdog $(date +%H:%M:%S)] avvio — province: ${PROVINCES[*]} · settori: ${#SLUGS[@]}"
restarts=0
while true; do
  if all_cells_done; then
    echo "[watchdog $(date +%H:%M:%S)] tutte le celle presenti — fine"
    break
  fi
  if ! campaign_running; then
    restarts=$((restarts+1))
    echo "[watchdog $(date +%H:%M:%S)] campagna non attiva — (ri)lancio #$restarts"
    nohup bash scripts/campaign.sh "${PROVINCES[@]}" >> "$OUT/_watchdog_driver.out" 2>&1 &
    sleep 15
  fi
  sleep "$CHECK_EVERY"
done
