# Judgment Layer (L2–L5) — runbook & activation

Estende PG4 con discovery refinement (sito+social) e un **giudizio a due assi**:
**A** = forza intrinseca (fonti TERZE), **B** = qualità auto-espressione (canali OWNED),
**GAP = A−B**, verdetto target + leva. Target = A alto + B basso; falso positivo = "fuffa" (A basso + B alto).

Fonte di verità del giudizio: `docs/ontology/ontologia_forza_commerciale_v2.md` (v2).
La logica vive in `src/judgment/config/` (trascritta da v2, ogni voce con `ref`; un test lo impone).
Solo i **numeri** (soglie/pesi) sono estensione di sistema — `thresholds` in `config/v0.ts`.

## Come gira (offline-first, free, €0)
- **Website adapter**: live, gratis — funziona da solo.
- **A-collector via SERP free (Bing)**: cerca premi/brevetti/marchi-storici/stampa a €0 (basso-yield).
- Tutto il resto (Places, registro OpenAPI, social-search a pagamento, **LLM giudici**) è **wired-but-disabled** dietro chiave+flag. Senza chiavi i giudici girano **deterministici** (baseline trasparente); con `--paid`+chiavi si raffinano con Claude.

## Eseguire

### Dashboard (dev)
```
pnpm run serve            # http://localhost:8787
# poi nel front end (web/): seleziona aziende → pulsanti L2 Discovery · L3 Segnali A/B · L4 Giudizio · L5 Validazione
# la colonna "Verdetto" mostra target + quadrante (A?B? = asse non misurato, NON A basso)
```

### CLI su una lista (CSV)
```
pnpm run judge -- --input output/lista.csv --out output/judged.jsonl [--two-pass] [--paid] [--limit N]
```
`--two-pass` (§17): pass-1 raccoglie i segnali → calcola il benchmark di categoria → pass-2 giudica RELATIVO alla mediana. Output: una riga JSONL per azienda (target/quadrante/scoreA/scoreB/leve/validation) + summary a video.

### Golden set / eval (§15)
```
cp tests/fixtures/judgment_golden.example.json tests/fixtures/judgment_golden.json   # poi RIEMPI a mano
pnpm run judge:eval -- --golden tests/fixtures/judgment_golden.json [--paid]
```
Stampa: precision/recall sul verdetto target + **accordo-A e accordo-B SEPARATI** (sai quale giudice sbaglia) + matrice di confusione sui quadranti.

## Attivare le fonti-A forti (chiavi — scelta per vertical)
In `.env` (poi `--paid` dove richiesto):
- **Registro camerale** (manifattura): `OPENAPI_ENABLED=true`, `OPENAPI_API_KEY=…` → anzianità/dipendenti/export/oggetto sociale (il vero spine-A B2B). Entity-guard `isWrongEntity` già applicato.
- **Google Places** (dentale/ristorazione): `GOOGLE_PLACES_ENABLED=true`, `GOOGLE_PLACES_API_KEY=…` → contenuto/rating recensioni (spine-A locale) + GBP/gestione (B, parziale via API).
- **LLM giudici (Claude)**: `ANTHROPIC_ENABLED=true`, `ANTHROPIC_API_KEY=…` **oppure** `OPENROUTER_ENABLED=true`, `OPENROUTER_API_KEY=…`. Poi `--paid`.
- Ad-library / social-managed: `ADLIB_*`, `BRIGHTDATA_*`/`FIRECRAWL_*` (opzionali).

Tutto è paid-gate OFF di default: nessuna chiamata a pagamento senza flag+chiave.

## Rischio residuo (da non dimenticare)
La **tesi** — il giudizio a due assi riconosce l'azienda forte-e-silente — è provata a **livello logico** (test `A+B-→target yes`), **NON su dati reali**. Con un asse A spento, ogni azienda esce verso `A?`/fuffa. La validazione vera arriva **solo** col golden set con **A misurato** (una fonte-A forte ON). Sequenza: (1) fix quadrante ✓ → (2) accendi UNA fonte-A per vertical → (3) golden set con A misurato → (4) SOLO ALLORA tara `thresholds`.

## Versioning (§20)
Ogni verdetto è timbrato `{ontology_version, judgment_config_version, judge_prompt_version, model_id}`. Cambiare la logica = nuova versione di `judgment_config` + re-run L4, **mai** una migration. Lo schema (`db/migrations/0002`) tiene solo output + snapshot della config come *dato*.
