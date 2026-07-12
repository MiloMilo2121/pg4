# VPS Runbook — campagne pg4 su host stabile

## Perché
Post-mortem delle campagne Veneto: **il 99% dei fallimenti erano cadute di rete del
client** (`net::ERR_INTERNET_DISCONNECTED` e affini — 3.626 occorrenze), causate dal
laptop in movimento (sospensione macOS + wifi che salta). **Non** erano blocchi
anti-bot (zero 403/429/captcha/Cloudflare nei log). La pipeline è ora indurita (retry
in-pipeline, checkpoint unico, preflight che degrada) e su macOS il driver si
auto-avvolge in `caffeinate`, ma il **fix definitivo per run multi-giorno** è spostare
la campagna su un host cablato e sempre acceso.

## Host consigliato (economico, EU)
| opzione | ~costo/mese | note |
|---|---|---|
| **Hetzner CX22** (2 vCPU, 4 GB, wired) | ~€4 | scelta di riferimento, rete 1 Gbit stabile |
| Contabo VPS S | ~€5 | più RAM, IP datacenter |
| Netcup RS 1000 | ~€6 | buona rete EU |

**Requisiti minimi:** 2 vCPU / 2–4 GB RAM (Chromium headless), Ubuntu 22.04/24.04, IP EU.
**Caveat:** l'IP è datacenter (non residenziale). Nei nostri log NON si sono visti
blocchi, ma va monitorato: se comparissero 403/429 su PG/Maps, valutare un proxy
residenziale o ridurre la concorrenza.

## Provisioning
```bash
# sul VPS
git clone https://github.com/MiloMilo2121/pg-omega.git
bash pg-omega/krakow/scripts/vps_setup.sh
```
Installa Node 22 + pnpm, dipendenze, Playwright+Chromium con le librerie di sistema, `.env`.

## Esecuzione resiliente
Opzione A — tmux + watchdog (semplice):
```bash
cd pg-omega/krakow
tmux new -s campaign
bash scripts/watchdog.sh PD VR VI VE TV RO BL   # rilancia da solo se muore
# Ctrl-b d per staccare; `tmux attach -t campaign` per ricollegarti
```

Opzione B — systemd (riparte al reboot):
```ini
# /etc/systemd/system/pg4-campaign.service
[Unit]
Description=pg4 campaign
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/pg-omega/krakow
ExecStart=/usr/bin/bash scripts/watchdog.sh PD VR VI VE TV RO BL
Restart=on-failure
RestartSec=30
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now pg4-campaign
journalctl -u pg4-campaign -f
```

## Monitoraggio
- Progresso celle: `tail -f output/recall/_campaign.log`
- Conteggio aziende: `cat output/recall/*_raw.jsonl | wc -l`
- Gap map: `pnpm run coverage -- --input "$(ls output/recall/*_raw.jsonl | paste -sd, -)" --out output/coverage`

## Recupero dati sul locale
```bash
rsync -avz vpsuser@HOST:~/pg-omega/krakow/output/recall/ ./output/recall_vps/
```
Poi la dashboard li carica da sola (`pnpm run dev`), oppure genera la gap map in locale.
