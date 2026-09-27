#!/usr/bin/env bash
# VERSIONED, data-driven campaign driver: reads sectors from
# data/reference/sectors.json and comuni from data/reference/comuni_nord.json.
# Adding a sector/provincia does NOT require touching this script.
#
# Now that the pipeline is hardened (single checkpoint by default, in-pipeline
# retry, preflight that degrades to PG-only) the driver is SIMPLE: no more
# --checkpoint, --skip-preflight or manual checkpoint cleanup. What remains:
#   - idempotent SKIP only with the <slug>_<PROV>_raw.complete.json marker
#   - a light BACKSTOP retry for whole-cell crashes (the resume picks up)
#   - self-wrap in `caffeinate -i` on macOS → the Mac doesn't sleep during the run
#     (post-mortem: sleep was the #1 cause of network disconnects).
#
# Usage:
#   bash scripts/campaign.sh PD VR VI VE TV RO BL
#   SECTORS=immobiliare,ristorazione MAPS=1 MAXPAGES=25 bash scripts/campaign.sh MI BG
# Env: MAPS(1) MAXPAGES(25) RETRIES(3) BASE_BACKOFF(120) OUTDIR(output/recall)
#      SECTORS(all) SUPPRESSION_LIST(auto: <OUTDIR>/suppression.csv if present)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Self-wrap in caffeinate (only once) to prevent the Mac from sleeping.
if [ "${PG4_CAFFEINATED:-}" != "1" ] && command -v caffeinate >/dev/null 2>&1; then
  export PG4_CAFFEINATED=1
  exec caffeinate -i bash "${BASH_SOURCE[0]}" "$@"
fi

COMUNI_JSON=data/reference/comuni_nord.json
SECTORS_JSON=data/reference/sectors.json
OUT="${OUTDIR:-output/recall}"
mkdir -p "$OUT"
LOG="$OUT/_campaign.log"
MAPS="${MAPS:-1}"; MAXPAGES="${MAXPAGES:-25}"; RETRIES="${RETRIES:-3}"; BASE_BACKOFF="${BASE_BACKOFF:-120}"
SECTOR_FILTER="${SECTORS:-}"

# GDPR suppression: explicit if the file exists (otherwise the CLI auto-discovers it).
if [ -z "${SUPPRESSION_LIST:-}" ] && [ -f "$OUT/suppression.csv" ]; then
  export SUPPRESSION_LIST="$OUT/suppression.csv"
fi

[ -f "$COMUNI_JSON" ] || { echo "manca $COMUNI_JSON" >&2; exit 2; }
[ -f "$SECTORS_JSON" ] || { echo "manca $SECTORS_JSON" >&2; exit 2; }
PROVINCES=("$@"); [ ${#PROVINCES[@]} -eq 0 ] && PROVINCES=(PD VR VI VE TV RO BL)

# read-loop instead of `mapfile` (missing in macOS bash 3.2)
SECTOR_ROWS=()
while IFS= read -r __row; do [ -n "$__row" ] && SECTOR_ROWS+=("$__row"); done < <(node -e '
  const fs=require("fs");
  const cat=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).sectors||[];
  const filter=(process.argv[2]||"").split(",").map(s=>s.trim()).filter(Boolean);
  for(const s of cat){ if(filter.length && !filter.includes(s.slug)) continue; process.stdout.write(s.slug+"\t"+s.keyword+"\n"); }
' "$SECTORS_JSON" "$SECTOR_FILTER")
maps_flags=""; [ "$MAPS" = "1" ] && maps_flags="--maps --coverage full"

cell_complete() {
  local csv="$1"
  pnpm exec tsx src/scripts/verify_completion.ts "$csv"
}

cell_pending_recovery() {
  local cell="$1" state="$OUT/.recovery/$1.json"
  [ -f "$state" ] && node - "$state" <<'NODE'
const fs = require('fs');
try {
  const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const valid = state && state.version === 1 && state.cell === process.argv[2].split('/').pop().replace(/\.json$/, '') &&
    ['pending', 'blocked', 'complete'].includes(state.status);
  // A corrupted queue must hold the cell for inspection rather than allowing
  // campaign to run concurrently with an unknown recovery lifecycle.
  process.exit(valid && ['pending', 'blocked'].includes(state.status) ? 0 : valid ? 1 : 0);
} catch {
  process.exit(0);
}
NODE
}

echo "[$(date +%H:%M:%S)] CAMPAIGN START — province: ${PROVINCES[*]} · settori: ${#SECTOR_ROWS[@]} · MAPS=$MAPS · MAXPAGES=$MAXPAGES · suppression=${SUPPRESSION_LIST:-auto}" >> "$LOG"
campaign_partial=0
campaign_blocked=0
campaign_failed=0
for prov in "${PROVINCES[@]}"; do
  comuni=$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write((j[process.argv[2]]||[]).join(","));' "$COMUNI_JSON" "$prov")
  ncom=$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String((j[process.argv[2]]||[]).length));' "$COMUNI_JSON" "$prov")
  [ -z "$comuni" ] && { echo "[$(date +%H:%M:%S)] SKIP $prov (0 comuni)" >> "$LOG"; continue; }
  for row in "${SECTOR_ROWS[@]}"; do
    slug="${row%%$'\t'*}"; kw="${row#*$'\t'}"
    out="$OUT/${slug}_${prov}_raw.csv"
    if cell_complete "$out"; then
      echo "[$(date +%H:%M:%S)] SKIP $slug $prov (gia' fatto: $(($(wc -l < "$out")-1)) lead)" >> "$LOG"; continue
    fi
    if cell_pending_recovery "${slug}_${prov}"; then
      campaign_blocked=1
      echo "[$(date +%H:%M:%S)] BLOCKED $slug $prov (recovery agent pending)" >> "$LOG"; continue
    fi
    echo "[$(date +%H:%M:%S)] START $slug $prov ($ncom comuni)" >> "$LOG"
    try=0; rc=1; backoff=$BASE_BACKOFF
    while [ $try -lt $RETRIES ]; do
      try=$((try+1))
      timeout 28800 npx tsx src/cli/scrape.ts --category "$kw" --comuni "$comuni" \
        --out "$out" --max-pages "$MAXPAGES" $maps_flags >> "$OUT/${slug}_${prov}.runlog" 2>&1
      rc=$?
      [ $rc -eq 0 ] && break
      if [ $rc -eq 1 ]; then
        command_json="$(node -e 'const [kw,comuni,out,max,maps]=process.argv.slice(1);const a=["pnpm","run","scrape","--","--category",kw,"--comuni",comuni,"--out",out,"--max-pages",max];if(maps==="1")a.push("--maps","--coverage","full");console.log(JSON.stringify(a));' "$kw" "$comuni" "$out" "$MAXPAGES" "$MAPS")"
        bash scripts/recovery_coordinator.sh enqueue --out "$OUT" --cell "${slug}_${prov}" --envelope "${out%.csv}.recovery.json" --command-json "$command_json" >> "$OUT/_recovery.log" 2>&1 || true
        echo "[$(date +%H:%M:%S)] PARTIAL $slug $prov rc=1 — recovery queued" >> "$LOG"
        campaign_partial=1
        break
      fi
      echo "[$(date +%H:%M:%S)] RETRY $slug $prov try=$try rc=$rc — attendo ${backoff}s (backstop cella)" >> "$LOG"
      sleep "$backoff"; backoff=$(( backoff*2 )); [ $backoff -gt 1800 ] && backoff=1800
    done
    n=0; [ -f "$out" ] && n=$(( $(wc -l < "$out") - 1 ))
    if [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ]; then
      echo "[$(date +%H:%M:%S)] DONE  $slug $prov rc=$rc leads=$n tries=$try" >> "$LOG"
    else
      campaign_failed=1
      echo "[$(date +%H:%M:%S)] FAILED $slug $prov rc=$rc leads=$n tries=$try" >> "$LOG"
      # A fatal/preflight/timeout condition cannot be made healthy by the
      # watchdog starting the same cell forever. Persist an explicit incident
      # and let the operator inspect it; SIGINT/SIGTERM remains restartable.
      if [ "$rc" -ne 130 ]; then
        bash scripts/recovery_coordinator.sh block --out "$OUT" --cell "${slug}_${prov}" \
          --reason "scrape exited $rc after $try campaign attempt(s)" >> "$OUT/_recovery.log" 2>&1 || true
        campaign_blocked=1
      fi
    fi
  done
done
if [ "$campaign_partial" -eq 1 ] || [ "$campaign_blocked" -eq 1 ] || [ "$campaign_failed" -eq 1 ]; then
  echo "[$(date +%H:%M:%S)] CAMPAIGN INCOMPLETE — province: ${PROVINCES[*]} (recovery pending, blocked incident, or interrupted cell)" >> "$LOG"
  exit 1
fi
echo "[$(date +%H:%M:%S)] CAMPAIGN COMPLETE — province: ${PROVINCES[*]}" >> "$LOG"
