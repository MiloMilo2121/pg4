# data/reference — denominatore & tassonomie per la Coverage Gap Map

Questi file alimentano il modulo `src/coverage/`. Sono letti a runtime (non importati),
così possono essere aggiornati senza ricompilare.

## File

### `ateco_divisions.json`
Tassonomia industry canonica: le 88 divisioni ATECO 2007 (codice 2 cifre + sezione + label IT).
Fonte: ISTAT, classificazione ATECO 2007. Stabile (cambia solo con una nuova classificazione,
es. ATECO 2025 — quando adottata, sostituire il file e bumpare `_meta`).

### `category_ateco_map.json`
Crosswalk **categoria di scraping ↔ divisione ATECO**. È il ponte tra il campo `category`
free-text dei lead scrapati e le righe dell'universo. Si costruisce incrementalmente,
prioritizzato dalla gap map (le divisioni a maggiore opportunità ottengono i keyword-set per prime).

### `istat_asia_universe.csv` — IL DENOMINATORE (dati REALI in produzione)
Numero di **imprese attive** per `(divisione ATECO × provincia)`, Nord Italia.

Colonne: `ateco_division,province,active_firms,year,provenance`
- `provenance = istat-asia` → riga da export ufficiale ISTAT (dato reale).
- `provenance = sample` → riga segnaposto (solo nella fixture `*.sample.csv`).

**Stato attuale (giugno 2026): dati REALI caricati.** 3.432 celle, 47 province Nord, 79 divisioni
ATECO, anno **2024**. Fonte: ISTAT SDMX REST, dataflow `183_277_DF_DICA_ASIAUE1P_5` (ASIA
`DICA_ASIAUE1P`, misura `AENTN` = imprese attive). ASIA copre per costruzione le sezioni **B–S**
(industria e servizi di mercato): restano fuori A (agricoltura), O (PA), T, U → 79/88 divisioni; non
è una lacuna ma il perimetro ufficiale. Celle assenti = province piccole su divisioni rare senza dato
pubblicato (segreto statistico / zero imprese): NON scritte, mai inventate.

La fixture **`istat_asia_universe.sample.csv`** (righe `provenance=sample`) resta SOLO per i test
deterministici (`tests/unit/coverage_*`). Il motore segnala comunque `usesSampleUniverse` se una cella
dovesse usare righe sample, così nessun placeholder passa per verità.

#### Come rigenerare il dato REALE (gratis, ~10 min, annuale)
1. Aprire I.Stat: http://dati.istat.it → tema *"Imprese"* → archivio **ASIA — Imprese attive**
   (tavola "Imprese attive per attività economica e classe di addetti", dettaglio provinciale).
   In alternativa: dataset ISTAT `DICA_ASIAUE1P` via API SDMX
   (`https://esploradati.istat.it`), oppure i CSV provinciali su https://www.istat.it/it/archivio/.
2. Selezionare: territorio = province del Nord (o tutte, poi filtriamo via `geo_regions.ts`),
   attività economica = **divisione ATECO** (2 cifre), anno = ultimo disponibile, misura = numero imprese.
3. Esportare in CSV e rimappare le colonne in: `ateco_division,province,active_firms,year,provenance`
   con `provenance = istat-asia`. La provincia va in **sigla** (MI, PD, …): se l'export usa il nome o
   il codice ISTAT, convertire (il loader accetta solo sigle a 2 lettere).
4. Sostituire le righe `sample` con i dati reali. Tenere o rimuovere le `sample`: il loader preferisce
   `istat-asia` quando entrambe esistono per la stessa cella.

> Nota sul caveat **ditte individuali**: ASIA conta TUTTE le imprese attive, incluse le ditte
> individuali, che però NON compaiono nelle directory (PagineGialle/Maps). Per questo il motore
> distingue universo *totale* da universo *indirizzabile-da-directory* (fattore per sezione ATECO,
> vedi `src/coverage/config.ts`). Senza questo aggiustamento la copertura su settori dominati da
> ditte individuali risulterebbe artificialmente bassa.
