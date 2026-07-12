#!/usr/bin/env bash
# Provisioning di un VPS Ubuntu 22.04/24.04 per far girare le campagne pg4 su una
# rete CABLATA e stabile — il fix definitivo alle disconnessioni del laptop in
# movimento (post-mortem: 3.626 net::ERR erano cadute di rete del client, non
# blocchi anti-bot). Idempotente-ish. Da eseguire SUL VPS, non in locale.
#
# Uso (sul VPS, come utente con sudo):
#   curl -fsSL <raw-url>/scripts/vps_setup.sh | bash
#   # oppure: git clone … && bash pg-omega/krakow/scripts/vps_setup.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MiloMilo2121/pg-omega.git}"
PKG_DIR="${PKG_DIR:-pg-omega/krakow}"   # il package pg4 vive nel sottodir krakow/

echo "==> 1/5 pacchetti di base"
sudo apt-get update -y
sudo apt-get install -y git tmux ca-certificates curl gnupg

echo "==> 2/5 Node 22 + pnpm"
if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable
corepack prepare pnpm@10.33.2 --activate

echo "==> 3/5 repo + dipendenze"
[ -d "$PKG_DIR/.git" ] || [ -d "pg-omega/.git" ] || git clone "$REPO_URL"
cd "$PKG_DIR"
pnpm install --frozen-lockfile

echo "==> 4/5 Playwright + Chromium + librerie di sistema"
pnpm dlx playwright install --with-deps chromium

echo "==> 5/5 .env"
if [ ! -f .env ]; then
  { [ -f .env.example ] && cp .env.example .env; } || : > .env
  echo "   creato .env (aggiungi le API key solo se userai i provider paid)"
fi

cat <<'DONE'

Setup completo. Per lanciare una campagna resiliente (sopravvive a reboot):

  tmux new -s campaign
  bash scripts/watchdog.sh PD VR VI VE TV RO BL     # watchdog + campaign
  # stacca con Ctrl-b d ; ricollegati con: tmux attach -t campaign

Progresso:  tail -f output/recall/_campaign.log
Conteggio:  cat output/recall/*_raw.jsonl | wc -l
Gap map:    pnpm run coverage -- --input "$(ls output/recall/*_raw.jsonl | paste -sd, -)" --out output/coverage
DONE
