# VPS Runbook — pg4 campaigns on a stable host

## Why
Post-mortem of the Veneto campaigns: **99% of failures were client-side network
drops** (`net::ERR_INTERNET_DISCONNECTED` and similar — 3,626 occurrences), caused by the
laptop on the move (macOS sleep + flaky wifi). They were **not** anti-bot blocks
(zero 403/429/captcha/Cloudflare in the logs). The pipeline is now hardened (in-pipeline
retry, single checkpoint, preflight that degrades) and on macOS the driver
self-wraps in `caffeinate`, but the **definitive fix for multi-day runs** is to move
the campaign to a wired, always-on host.

## Recommended host (cheap, EU)
| option | ~cost/month | notes |
|---|---|---|
| **Hetzner CX22** (2 vCPU, 4 GB, wired) | ~€4 | reference choice, stable 1 Gbit network |
| Contabo VPS S | ~€5 | more RAM, datacenter IP |
| Netcup RS 1000 | ~€6 | good EU network |

**Minimum requirements:** 2 vCPU / 2–4 GB RAM (headless Chromium), Ubuntu 22.04/24.04, EU IP.
**Caveat:** the IP is a datacenter IP (not residential). Our logs showed NO
blocks, but it must be monitored: if 403/429 start appearing on PG/Maps, consider a
residential proxy or reduce concurrency.

## Provisioning
```bash
# on the VPS
git clone https://github.com/MiloMilo2121/pg4.git
bash pg4/scripts/vps_setup.sh
```
Installs Node 24 + pnpm, dependencies, Playwright+Chromium with the system libraries, `.env`.

## Resilient execution
Opzione A — systemd (raccomandata): restart con backoff, stop graceful e log
su journald con rotazione. Richiede una build di produzione sul VPS.

```bash
# on the VPS, inside the checkout
pnpm build
sudo cp deploy/pg4-api.service deploy/pg4-campaign.service deploy/pg4-campaign.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pg4-api            # dashboard API (node dist/, porta 8787)
sudo systemctl enable --now pg4-campaign.timer # campagna ogni notte alle 02:00
```

```bash
systemctl status pg4-api
journalctl -u pg4-api -f                        # log dell'API
journalctl -u pg4-campaign -f                   # log dell'ultima campagna
systemctl list-timers pg4-campaign.timer        # prossima esecuzione
```

Le province della campagna stanno nella riga `ExecStart` di
`deploy/pg4-campaign.service` (dopo la modifica: `daemon-reload`).
Il `.env` del checkout viene letto dalle unit (`EnvironmentFile`).

Opzione B — tmux + watchdog (DEPRECATA, solo per compatibilità):
```bash
cd pg4
tmux new -s campaign
bash scripts/watchdog.sh PD VR VI VE TV RO BL   # relaunches itself if it dies
# Ctrl-b d to detach; `tmux attach -t campaign` to reattach
```
`scripts/watchdog.sh` è deprecato: resta nel repo per un solo ciclo di
verifica in produzione accanto a systemd, poi si cancella. Non puntare nuove
unit systemd al watchdog; usa `deploy/pg4-campaign.service` + timer.

## Monitoring
- Cell progress: `tail -f output/recall/_campaign.log`
- Company count: `cat output/recall/*_raw.jsonl | wc -l`
- Gap map: `pnpm run coverage -- --input "$(ls output/recall/*_raw.jsonl | paste -sd, -)" --out output/coverage`

## Pulling the data back locally
```bash
rsync -avz vpsuser@HOST:~/pg4/output/recall/ ./output/recall_vps/
```
Then the dashboard loads them automatically (`pnpm run dev`), or generate the gap map locally.
