# Come espandere il DB — settori, aree, dimensioni

Il sistema è progettato perché espandere sia una modifica in **un solo posto**.
Riferimento veloce.

## 1) Aggiungere un SETTORE (industry)
Unico file da toccare: **`data/reference/sectors.json`** → aggiungi un oggetto a `sectors`:
```json
{
  "slug": "autofficine",
  "label": "Autofficine",
  "keyword": "autofficina",
  "atecoDivisions": ["45"],
  "queryVariants": ["autofficina", "officina auto", "gommista", "carrozzeria"]
}
```
Poi:
1. Assicurati che la `keyword` sia **classificabile** in una delle `atecoDivisions`: se non lo è, aggiungi i token in `category_ateco_map.json`. Il test `tests/unit/coverage_sectors.test.ts` verifica automaticamente la coerenza (fallisce se il settore è mal-configurato).
2. Rilancia il driver generalizzato: `MAPS=1 MAXPAGES=25 nohup bash output/run_recall.sh <PROVINCE...> &`. Userà il nuovo settore senza altre modifiche.
   - Solo un sottoinsieme: `SECTORS=autofficine bash output/run_recall.sh MI BG`.

> Nota: l'espansione delle `queryVariants` su Google Maps (`--coverage full`) oggi è attiva solo per i settori presenti in `src/discovery/sources/maps_coverage.ts`. Follow-up sicuro (da fare a run fermo): rendere `maps_coverage.ts` data-driven da `sectors.json`, così i variants valgono per ogni settore automaticamente.

## 2) Aggiungere un'AREA (provincia / regione)
**Nessuna modifica al codice o al catalogo.** I comuni completi di tutte le **47 province del Nord** (8 regioni) sono già in `comuni_nord.json`, e la geografia in `src/coverage/geo_regions.ts`. Basta passare le sigle al driver:
```
MAPS=1 nohup bash output/run_recall.sh MI BG BS CO VA &   # Lombardia
```
Per estendere OLTRE il Nord Italia: aggiungere le province a `comuni_nord.json` (stesso formato) e le regioni a `geo_regions.ts`.

## 3) Aggiungere una DIVISIONE ATECO alla gap-map
- Il **denominatore** (universo) copre già 79 divisioni ISTAT (`istat_asia_universe.csv`).
- Per **classificare** lead scrapati in quella divisione: aggiungi tokens/keyword in `category_ateco_map.json`.
- La tassonomia completa (88 divisioni) è in `ateco_divisions.json`.

## 4) Aggiungere l'ENRICHMENT (livello 2)
Parcheggiato per scelta: il DB attuale è livello 1 (anagrafica + telefono + categoria + geo). Per email/PEC/sito servono provider a pagamento (Serper + Apify/registro). Driver pronto: `output/enrich_campaign_veneto.sh`. Vedi nota in `MEMORY`/coverage per il test (resa/costo/tempo).

## File chiave
| cosa | file |
|---|---|
| catalogo settori | `data/reference/sectors.json` (+ loader `src/coverage/sectors.ts`) |
| comuni completi Nord | `data/reference/comuni_nord.json` |
| universo ISTAT | `data/reference/istat_asia_universe.csv` |
| crosswalk categoria→ATECO | `data/reference/category_ateco_map.json` |
| tassonomia ATECO | `data/reference/ateco_divisions.json` |
| geografia Nord | `src/coverage/geo_regions.ts` |
| driver scraping (espandibile) | `output/run_recall.sh` |
