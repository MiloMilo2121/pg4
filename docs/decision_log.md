# pg4 decision log — production-readiness pass (2026-06-10)

Conservative defaults chosen autonomously during the hardening pass.
Each entry lists the alternatives and the migration path. None of these
are irreversible; all are config- or flag-gated.

## Reality-vs-plan discrepancies noted at Phase 0

1. `validate:output` script **already existed** in package.json (added by a
   concurrent session after the gap audit was written). Phase B.2 therefore
   only wires automatic post-run invocation.
2. `.env.example` **already documents** every EnvSchema variable. Phase B.4
   only appends the new observability variables.
3. `Checkpoint.set()` **already flushes synchronously** on every write —
   the "flush checkpoint on shutdown" requirement is satisfied by design;
   the graceful-shutdown work only needs to stop the loop and let the
   natural path complete.

## A.1 — Per-run log file

- **Default:** every CLI run writes a JSONL log to `<out>.log.jsonl`
  alongside the outputs. `LOG_FILE=<path>` overrides the location;
  `LOG_FILE=off` disables.
- **Alternatives considered:** opt-in only (operator forgets, loses
  forensics — rejected); rotating global log dir (adds config surface and
  detaches logs from the run artifacts they describe — rejected).
- **Migration:** set `LOG_FILE` env in the scheduler unit to centralize
  logs; or pipe to a shipper later. No call-site changes needed.

## A.2 — Run history location

- **Default:** `_runs.jsonl` in the same directory as the run's `--out`
  file. Underscore prefix sorts it apart from data files; the validator
  and retention sweep ignore it.
- **Alternatives:** single fixed `output/_runs.jsonl` (breaks when the
  operator writes outputs elsewhere); SQLite (new dependency, stateless-core
  invariant pressure).
- **Migration:** the file is plain JSONL — trivially importable into
  DuckDB/Postgres later.

## A.3 — Preflight canary

- **Default:** preflight ON for every live scrape; canary query is
  "agenzie immobiliari" / Padova (densest validated comune since R6).
  `--skip-preflight` opts out per-run.
- **Alternatives:** canary derived from the run's own category/comune
  (first-run categories have no known-good baseline — rejected);
  preflight as separate CLI (operator forgets — rejected).
- **Migration:** when a second category is validated at province scale,
  move `PREFLIGHT_CANARY` to config.

## A.4 — Yield anomaly threshold

- **Default:** warn when a comune yields < 30% of its historical average
  for the same category; advisory only (marks `suspect: true` in the run
  record, never fails the run). No history → no check.
- **Alternatives:** fail the run (false positives on genuinely shrinking
  markets — rejected); median instead of mean (fine, revisit with more
  history).

## A.5 — Notifier

- **Default:** `NOTIFY=local` — structured warn-level log line (lands in
  the run log file) + best-effort macOS `osascript` notification.
  `NOTIFY=off` silences.
- **OPERATOR DECISION PENDING:** alert channel (Slack webhook / Telegram /
  email). The `Notifier` interface takes one implementation + one line in
  `createNotifier` to add; call sites are final.
- **Per-lead ceiling events are notified once per run** (first occurrence);
  the total count lands in the ledger summary and run record. Rationale:
  many leads legitimately exhaust their budget; N pings would be spam.

## B.3 — Exit codes

- `0` ok · `1` partial (enrich row errors) · `2` fatal · `3` preflight
  failed · `130` interrupted. Stable contract for schedulers.
- pg4 CLIs have never prompted; `--non-interactive` is accepted as an
  inert flag by the parser (any unknown `--flag` parses as boolean true)
  and documented as such rather than implemented as special behavior.

## B.5 — Graceful shutdown

- First SIGINT/SIGTERM: abort signal → cooperative drain (in-flight leads
  finish, outputs close, ledger summary + run record written, lock
  released) → natural exit 130. Watchdog force-exits after 45 s if the
  drain wedges; a second signal force-exits immediately. The force path
  writes a fallback run record but may leave a partially flushed CSV —
  accepted as the escape hatch.

## B.1 — `run` command output layout

- **Default:** `--out <base>` produce `<base>_raw.csv`, `<base>_enriched.csv`
  (+ jsonl/ledger), `<base>.log.jsonl`. Ogni stage acquisisce il proprio
  output lock (stessa protezione dei comandi separati).
- **Alternative:** dirigere tutto in una directory per-campagna (più file
  da spostare per il delivery — rinviato).

## B.2 — Validazione automatica post-run

- **Default:** `validateOutputs()` gira a fine scrape (flavor raw) e fine
  enrich (flavor enriched). WARN-ONLY: un fallimento è loggato + notificato
  ma non cambia l'exit code — gli output sono già su disco e nasconderli
  non aiuta l'operatore.
- **Alternative:** exit code dedicato per validation-failed (rompe la
  semantica "exit≠0 = run non completato" — rifiutato per ora).

## B.3 — Scheduler

- **OPERATOR DECISION PENDING:** nessuno scheduler installato. Esempi
  pronti (launchd, cron, GH Actions commentato) in
  `docs/scheduling_examples.md`. CLI già non-interattivi by design.

## B.4 — Secrets

- **Default:** `.env` resta il meccanismo (conservativo). `assertPaidSecrets()`
  fallisce fast e nominando la variabile mancante quando `--enable-paid` è
  passato senza alcun provider paid usabile.
- **Scan eseguito (2026-06-10):** nessuna chiave key-shaped nel working
  tree pg4, nella history git dei path pg4, né a HEAD dell'intero repo;
  `.env` mai committato. Nessun finding CRITICAL.
- **OPERATOR DECISION PENDING:** upgrade a secrets manager (1Password /
  SOPS / Doppler) per uso multi-operatore.

## C.1 — Schema versioning

- **Default:** `_schema_version=1` come ULTIMA colonna di entrambi i flavor
  + campo JSONL. Le colonne base sono CONGELATE (RAW_BASE / ENRICHED_BASE);
  ogni aggiunta futura va in un appendix APPENDED_COLUMNS_V*.
- **Motivo strutturale:** appendere a RAW_CSV_COLUMNS direttamente avrebbe
  INSERITO colonne a metà dell'enriched CSV (che spread-a raw per primo) —
  rompendo i reader posizionali. Da qui le basi congelate.
- Il validator richiede la colonna col valore atteso; file pre-v1 falliscono
  la validazione in modo esplicito ("pre-v1 output?").

## C.2 — E.164

- **Default:** normalizzazione conservativa solo per numeri plausibilmente
  italiani; l'originale è preservato in `phone_raw`. Numeri non parseabili
  restano invariati (meglio nessuna normalizzazione che una sbagliata).

## C.3 — Near-duplicate review

- **Default:** indice token-sorted name+city ausiliario; collisioni
  FLAGGED in `<out>.dedup-review.jsonl`, MAI auto-merged ("Studio Casa" vs
  "Casa Studio" possono essere ditte registrate distinte).

## C.4 — Closed businesses

- **Default:** "Chiuso definitivamente"/"Permanently closed" catturato dal
  parser Maps; enrich li scrive come SKIPPED/SKIPPED_PERMANENTLY_CLOSED
  senza bruciare provider call. `--include-closed` per processarli.
- Solo dati già presenti nelle pagine caricate — nessuna navigazione extra.

## D.1 — Suppression list

- **Default:** risoluzione flag > env SUPPRESSION_LIST > `suppression.csv`
  auto-scoperto accanto all'output > disattivata. Lead corrispondenti
  DROPPATI (non scritti come SKIPPED): un soggetto do-not-contact non deve
  continuare ad apparire nei file consegnati. Un path ESPLICITO illeggibile
  è hard error (l'operatore ha chiesto una protezione che non sta avendo).

## D.2 — Retention

- **Default:** OFF (mai cancellare nulla senza opt-in). `--retention-days N`
  / env RETENTION_DAYS. Protetti sempre: `_runs.jsonl` (registro Art. 30),
  `suppression.csv`, `*.lock`.
- **OPERATOR DECISION PENDING:** il periodo N (decisione GDPR).

## D.3 — Lookup (right-to-access/deletion)

- **Default:** `pnpm run lookup` è un READER: riporta file+riga, la
  cancellazione resta manuale. Riscrivere automaticamente artifact già
  consegnati li desincronizzerebbe dalle copie presso i clienti.

## D.4 — GDPR

- Posture documentata in `docs/gdpr_posture.md`: implementato vs pendente.
- **OPERATOR DECISIONS PENDING:** base giuridica + balancing test, periodo
  retention, DPIA sì/no, DPA Serper (query paid trasmettono nomi a
  processor extra-UE), informativa Art. 14, verifica RPO se telemarketing.

## E.1 — Coverage

- **Baseline (2026-06-10):** 70.44% lines · 83.76% branches · 81.79%
  functions (vitest --coverage, v8 provider; CLI wrapper entrypoint e
  src/types esclusi). NESSUNA soglia di gate impostata — il numero è la
  baseline; la soglia è una decisione di team successiva.

## E.3 — ESLint

- **Default:** typescript-eslint recommended, zero regole di formatting.
  `no-explicit-any` a warn (gli `any` ai boundary error/meta sono
  deliberati; tsconfig strict previene già gli impliciti). 0 errori,
  0 warning a fine pass.

## E.4 — Dependency audit

- **Trovate 3 vulnerabilità, tutte nella catena dev-tooling
  vitest→vite→esbuild** (1 critical vitest<3.2.6 UI-server file read;
  2 moderate vite/esbuild dev-server). Exploit richiede un dev/UI server
  in ascolto — pg4 usa SOLO `vitest run` one-shot, nessun server mai
  avviato. Nessuna vulnerabilità nelle dipendenze di produzione.
- **MAJOR BUMP DEFERRED (operator/next pass):** vitest 2→3 risolve tutte
  e tre. Non eseguito in questo pass per la regola "patch-level only".

## F — Bug reali trovati dalla verifica live (e fix)

1. **RateLimiter mai cablato** (dal Phase 1): acquire() senza call site →
   burst SERP ~3.7 req/s → Bing soft-block 185/185 empty, silenzioso.
   Fix: pacing per-provider nel router; bing_html/ddg_lite 0.5 req/s
   capacity 2; non configurati = invariati. Verificato live: 0%→100%
   success, yield 0→17.8% (baseline R11: 20.9%).
2. **Playwright handleSIGINT default** pre-emptava il graceful drain
   (exit(130) suo prima del nostro): handleSIGINT/handleSIGTERM:false al
   launch + abort check per-PAGINA in pg_live (un comune denso superava
   il watchdog). Verificato live: drain naturale in 1.7 s con output
   parziali, lock rilasciato, checkpoint resume-ready.
