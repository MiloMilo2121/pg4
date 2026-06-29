# pg4 — GDPR posture (2026-06-10)

Stato di fatto: cosa pg4 processa, dove vivono i dati, quali meccanismi di
tutela sono IMPLEMENTATI e quali decisioni legali restano IN CAPO
ALL'OPERATORE. Questo documento non è un parere legale.

## 1. Che dati personali tratta pg4

pg4 raccoglie dati di business pubblicamente esposti su PagineGialle e
Google Maps relativi a PMI italiane. Diventano dati personali quando il
soggetto è identificabile:

| campo | quando è dato personale |
|---|---|
| `company_name` | ditte individuali / studi ("Studio Rossi", "Bevilacqua Barbara") identificano la persona |
| `phone` / `phone_raw` | numeri diretti, inclusi mobili personali |
| `vat_code` / `vat_code_final` | per ditte individuali la P.IVA è riconducibile alla persona |
| `address` | sede = spesso domicilio per ditte individuali |
| `pec` / `email_inferred` | recapiti personali |
| `decision_maker_*` | nome/ruolo/LinkedIn di una persona fisica |

Base normativa attesa per il trattamento: **legittimo interesse
(Art. 6(1)(f))** per prospezione B2B verso recapiti professionali
pubblicamente pubblicati — MA la decisione formale, col balancing test,
spetta all'operatore (vedi §5).

## 2. Dove vivono i dati

- **Solo filesystem locale** della macchina che esegue il run:
  `output/*.csv`, `output/*.jsonl` (+ log `*.log.jsonl`, ledger).
- Nessun database, nessun cloud sync automatico, nessun servizio terzo di
  storage. `output/` è escluso da git.
- Flussi verso terzi DURANTE l'elaborazione:
  - PagineGialle / Google Maps: navigazione di pagine pubbliche.
  - Serper.dev (solo con `--enable-paid`): le query SERP contengono nome
    azienda + comune — per ditte individuali ciò trasmette un nome
    personale a un processor USA. Vedi §5 (processor agreement).
  - VIES (Commissione UE): validazione P.IVA.

## 3. Meccanismi IMPLEMENTATI (Phase D)

| meccanismo | come | dove |
|---|---|---|
| **Suppression list** (do-not-contact / opposizione) | CSV `phone,vat,reason,date`; flag `--suppression-list`, env `SUPPRESSION_LIST`, o `suppression.csv` auto-scoperto accanto all'output. Lead corrispondenti DROPPATI da scrape ed enrich, contati nel run record. | `src/compliance/suppression.ts` |
| **Retention** | `--retention-days N` / env `RETENTION_DAYS`: a inizio run elimina artifact più vecchi di N giorni nella dir di output. Protetti sempre: `_runs.jsonl`, `suppression.csv`, `*.lock`. Default: OFF (decisione operatore). | `src/compliance/retention.ts` |
| **Registro trattamenti (Art. 30 support)** | `_runs.jsonl`: un record per run con comando, argomenti, timestamp, conteggi, esito. Append-only, mai eliminato dalla retention. | `src/runtime/run_record.ts` |
| **Right-to-access / deletion lookup** | `pnpm run lookup -- --piva X | --phone Y`: scandisce tutti gli output e riporta file+riga dove il soggetto appare. La cancellazione resta manuale BY DESIGN (riscrivere silenziosamente artifact già consegnati li desincronizzerebbe dalle copie presso i clienti). | `src/cli/lookup.ts` |

### Flusso operativo per una richiesta di cancellazione

1. `pnpm run lookup -- --phone <numero>` (o `--piva`) → lista file+righe.
2. Rimuovere le righe dai file locali (o rigenerare l'output).
3. Aggiungere il soggetto a `suppression.csv` → non riapparirà nei run futuri.
4. Notificare i clienti che hanno ricevuto file contenenti il soggetto
   (processo umano, fuori da pg4).

## 4. Cosa pg4 NON fa (limiti dichiarati)

- Non traccia a chi è stato CONSEGNATO ogni file (delivery log = processo
  operatore).
- Non cifra gli output a riposo (filesystem locale; FileVault del Mac è la
  mitigazione attuale).
- Non sincronizza la suppression list col Registro Pubblico delle
  Opposizioni (RPO): l'iscrizione RPO va verificata prima di campagne
  TELEFONICHE — fuori scope per outreach email/web.

## 5. DECISIONI OPERATORE PENDENTI (legali, non implementabili in codice)

1. **Base giuridica formale** — legittimo interesse Art. 6(1)(f) con
   balancing test documentato, oppure contratto col cliente come titolare
   (pg4/AXEND come responsabile). Decide chi è titolare del trattamento
   per ogni campagna.
2. **Periodo di retention** — quanti giorni? (poi: `RETENTION_DAYS=N`
   nello scheduler/env e il meccanismo è già attivo).
3. **DPIA** — valutare se il volume/sistematicità della raccolta richiede
   una DPIA formale (Art. 35). Su scala provinciale attuale (~1.5k
   record/run) è difendibile di no; su scala nazionale ricorrente la
   risposta probabilmente cambia.
4. **Processor agreement con Serper.dev** — le query paid trasmettono nomi
   (potenzialmente personali) a un fornitore extra-UE. Verificare DPA di
   Serper + SCC, o tenerlo spento per ditte individuali.
5. **Privacy notice** — l'informativa Art. 14 (dati non raccolti presso
   l'interessato) per i lead contattati: chi la fornisce, dove, quando
   (tipicamente nel primo contatto outreach).
6. **Registro opposizioni (RPO)** — obbligatorio SOLO per telemarketing:
   se i lead verranno chiamati, serve la verifica RPO pre-campagna.

## 6. Riferimenti interni

- `docs/decision_log.md` — default conservativi scelti e perché.
- `docs/operator_playbook.md` — comandi operativi (suppression, lookup).
- `_runs.jsonl` — registro dei run (mai cancellato da pg4).
