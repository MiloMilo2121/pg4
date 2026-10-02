#!/usr/bin/env bash
# Provision an Ubuntu 22.04/24.04 VPS to run pg4 campaigns on a WIRED, stable
# network — the definitive fix for a laptop that keeps dropping connections
# (post-mortem: 3,626 net::ERR failures were client-side network drops, not
# anti-bot blocks). Mostly idempotent. Run it ON the VPS, not locally.
#
# Usage (on the VPS, as a user with sudo):
#   curl -fsSL <raw-url>/scripts/vps_setup.sh | bash
#   # or: git clone … && bash pg4/scripts/vps_setup.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MiloMilo2121/pg4.git}"
PKG_DIR="${PKG_DIR:-$(basename "$REPO_URL" .git)}"

echo "==> 1/5 base packages"
sudo apt-get update -y
sudo apt-get install -y git tmux ca-certificates curl gnupg

echo "==> 2/5 Node 24 + pnpm"
if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable
corepack prepare pnpm@10.33.2 --activate

echo "==> 3/5 repo + dependencies"
[ -d "$PKG_DIR/.git" ] || git clone "$REPO_URL" "$PKG_DIR"
cd "$PKG_DIR"
pnpm install --frozen-lockfile

echo "==> 4/5 Playwright + Chromium + system libraries"
pnpm dlx playwright install --with-deps chromium

echo "==> 5/5 .env"
if [ ! -f .env ]; then
  { [ -f .env.example ] && cp .env.example .env; } || : > .env
  echo "   created .env (add API keys only if you will use paid providers)"
fi

echo "==> 6/6 systemd units (Opzione A, raccomandata — vedi docs/VPS_RUNBOOK.md)"
if [ -f deploy/pg4-api.service ] && [ -f deploy/pg4-campaign.service ] && [ -f deploy/pg4-campaign.timer ]; then
  sudo cp deploy/pg4-api.service deploy/pg4-campaign.service deploy/pg4-campaign.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  echo "   units installed (then: pnpm build && sudo systemctl enable --now pg4-api pg4-campaign.timer)"
else
  echo "   deploy/*.service|timer missing — skipping unit install"
fi

cat <<'DONE'

Setup complete. Production runs on systemd (Opzione A, raccomandata):

  pnpm build
  sudo systemctl enable --now pg4-api            # dashboard API (node dist/)
  sudo systemctl enable --now pg4-campaign.timer # campagna ogni notte alle 02:00

Logs:    journalctl -u pg4-api -f  /  journalctl -u pg4-campaign -f
Timer:   systemctl list-timers pg4-campaign.timer

Legacy (deprecato, un solo ciclo di verifica): tmux + bash scripts/watchdog.sh
  (vedi docs/VPS_RUNBOOK.md Opzione B).

Progress:  tail -f output/recall/_campaign.log
Count:     cat output/recall/*_raw.jsonl | wc -l
Gap map:   pnpm run coverage -- --input "$(ls output/recall/*_raw.jsonl | paste -sd, -)" --out output/coverage
DONE
