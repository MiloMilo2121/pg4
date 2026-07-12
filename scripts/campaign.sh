#!/usr/bin/env bash
# Campaign driver VERSIONATO e data-driven: legge i settori da
# data/reference/sectors.json e i comuni da data/reference/comuni_nord.json.
# Aggiungere un settore/provincia NON richiede toccare questo script.
#
# Ora che la pipeline è indurita (checkpoint unico di default, retry in-pipeline,
# preflight che degrada a PG-only) il driver è SEMPLICE: niente più --checkpoint,
# --skip-preflight o pulizia manuale dei checkpoint. Resta:
#   - SKIP idempotente (cella con <slug>_<PROV>_raw.csv già presente = fatta)
#   - un retry leggero di BACKSTOP per crash dell'intera cella (il resume riprende)
#   - self-wrap in `caffeinate -i` su macOS → il Mac non si sospende durante il run
#     (post-mortem: la sospensione era la causa #1 delle disconnessioni di rete).
#
# Uso:
#   bash scripts/campaign.sh PD VR VI VE TV RO BL
#   SECTORS=immobiliare,ristorazione MAPS=1 MAXPAGES=25 bash scripts/campaign.sh MI BG
# Env: MAPS(1) MAXPAGES(25) RETRIES(3) BASE_BACKOFF(120) OUTDIR(output/recall)
#      SECTORS(tutti) SUPPRESSION_LIST(auto: <OUTDIR>/suppression.csv se presente)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Self-wrap in caffeinate (una sola volta) per impedire la sospensione del Mac.
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

# Suppression GDPR: esplicita se il file esiste (altrimenti la CLI la auto-scopre).
if [ -z "${SUPPRESSION_LIST:-}" ] && [ -f "$OUT/suppression.csv" ]; then
  export SUPPRESSION_LIST="$OUT/suppression.csv"
fi

[ -f "$COMUNI_JSON" ] || { echo "manca $COMUNI_JSON" >&2; exit 2; }
[ -f "$SECTORS_JSON" ] || { echo "manca $SECTORS_JSON" >&2; exit 2; }
PROVINCES=("$@"); [ ${#PROVINCES[@]} -eq 0 ] && PROVINCES=(PD VR VI VE TV RO BL)

# read-loop invece di `mapfile` (assente in bash 3.2 di macOS)
SECTOR_ROWS=()
while IFS= read -r __row; do [ -n "$__row" ] && SECTOR_ROWS+=("$__row"); done < <(node -e '
  const fs=require("fs");
  const cat=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).sectors||[];
  const filter=(process.argv[2]||"").split(",").map(s=>s.trim()).filter(Boolean);
  for(const s of cat){ if(filter.length && !filter.includes(s.slug)) continue; process.stdout.write(s.slug+"\t"+s.keyword+"\n"); }
' "$SECTORS_JSON" "$SECTOR_FILTER")
maps_flags=""; [ "$MAPS" = "1" ] && maps_flags="--maps --coverage full"

echo "[$(date +%H:%M:%S)] CAMPAIGN START — province: ${PROVINCES[*]} · settori: ${#SECTOR_ROWS[@]} · MAPS=$MAPS · MAXPAGES=$MAXPAGES · suppression=${SUPPRESSION_LIST:-auto}" >> "$LOG"
for prov in "${PROVINCES[@]}"; do
  comuni=$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write((j[process.argv[2]]||[]).join(","));' "$COMUNI_JSON" "$prov")
  ncom=$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String((j[process.argv[2]]||[]).length));' "$COMUNI_JSON" "$prov")
  [ -z "$comuni" ] && { echo "[$(date +%H:%M:%S)] SKIP $prov (0 comuni)" >> "$LOG"; continue; }
  for row in "${SECTOR_ROWS[@]}"; do
    slug="${row%%$'\t'*}"; kw="${row#*$'\t'}"
    out="$OUT/${slug}_${prov}_raw.csv"
    if [ -f "$out" ]; then
      echo "[$(date +%H:%M:%S)] SKIP $slug $prov (gia' fatto: $(($(wc -l < "$out")-1)) lead)" >> "$LOG"; continue
    fi
    echo "[$(date +%H:%M:%S)] START $slug $prov ($ncom comuni)" >> "$LOG"
    try=0; rc=1; backoff=$BASE_BACKOFF
    while [ $try -lt $RETRIES ]; do
      try=$((try+1))
      timeout 28800 npx tsx src/cli/scrape.ts --category "$kw" --comuni "$comuni" \
        --out "$out" --max-pages "$MAXPAGES" $maps_flags >> "$OUT/${slug}_${prov}.runlog" 2>&1
      rc=$?
      [ $rc -eq 0 ] && break
      echo "[$(date +%H:%M:%S)] RETRY $slug $prov try=$try rc=$rc — attendo ${backoff}s (backstop cella)" >> "$LOG"
      sleep "$backoff"; backoff=$(( backoff*2 )); [ $backoff -gt 1800 ] && backoff=1800
    done
    n=0; [ -f "$out" ] && n=$(( $(wc -l < "$out") - 1 ))
    echo "[$(date +%H:%M:%S)] DONE  $slug $prov rc=$rc leads=$n tries=$try" >> "$LOG"
  done
done
echo "[$(date +%H:%M:%S)] CAMPAIGN COMPLETE — province: ${PROVINCES[*]}" >> "$LOG"
