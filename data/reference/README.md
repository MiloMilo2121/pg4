# data/reference — denominator & taxonomies for the Coverage Gap Map

These files feed the `src/coverage/` module. They are read at runtime (not imported),
so they can be updated without recompiling.

## Files

### `ateco_divisions.json`
Canonical industry taxonomy: the 88 ATECO 2007 divisions (2-digit code + section + Italian label).
Source: ISTAT, ATECO 2007 classification. Stable (changes only with a new classification,
e.g. ATECO 2025 — when adopted, replace the file and bump `_meta`).

### `category_ateco_map.json`
Crosswalk **scraping category ↔ ATECO division**. It is the bridge between the free-text `category`
field of scraped leads and the rows of the universe. It is built incrementally,
prioritized by the gap map (the highest-opportunity divisions get their keyword sets first).

### `istat_asia_universe.csv` — THE DENOMINATOR (REAL data in production)
Number of **active firms** per `(ATECO division × provincia)`, Northern Italy.

Columns: `ateco_division,province,active_firms,year,provenance`
- `provenance = istat-asia` → row from an official ISTAT export (real data).
- `provenance = sample` → placeholder row (only in the `*.sample.csv` fixture).

**Current state (June 2026): REAL data loaded.** 3,432 cells, 47 Northern provinces, 79 ATECO
divisions, year **2024**. Source: ISTAT SDMX REST, dataflow `183_277_DF_DICA_ASIAUE1P_5` (ASIA
`DICA_ASIAUE1P`, measure `AENTN` = active firms). By construction ASIA covers sections **B–S**
(industry and market services): A (agriculture), O (public administration), T, U are left out → 79/88 divisions; this is
not a gap but the official scope. Missing cells = small provinces on rare divisions with no published
data (statistical confidentiality / zero firms): NOT written, never invented.

The **`istat_asia_universe.sample.csv`** fixture (`provenance=sample` rows) is kept ONLY for the
deterministic tests (`tests/unit/coverage_*`). The engine still flags `usesSampleUniverse` if a cell
were to use sample rows, so no placeholder ever passes for truth.

#### How to regenerate the REAL data (free, ~10 min, yearly)
1. Open I.Stat: http://dati.istat.it → topic *"Imprese"* (enterprises) → **ASIA — Imprese attive** archive
   (table "Imprese attive per attività economica e classe di addetti", provincial detail).
   Alternatively: the ISTAT dataset `DICA_ASIAUE1P` via the SDMX API
   (`https://esploradati.istat.it`), or the provincial CSVs at https://www.istat.it/it/archivio/.
2. Select: territory = Northern provinces (or all, then filter via `geo_regions.ts`),
   economic activity = **ATECO division** (2 digits), year = latest available, measure = number of firms.
3. Export to CSV and remap the columns to: `ateco_division,province,active_firms,year,provenance`
   with `provenance = istat-asia`. The provincia must be the **2-letter code** (MI, PD, …): if the export uses the name or
   the ISTAT code, convert it (the loader only accepts 2-letter codes).
4. Replace the `sample` rows with the real data. Keeping or removing the `sample` rows is fine: the loader prefers
   `istat-asia` when both exist for the same cell.

> Note on the **sole proprietorship** (ditte individuali) caveat: ASIA counts ALL active firms, including sole
> proprietorships, which however do NOT appear in the directories (PagineGialle/Maps). For this reason the engine
> distinguishes the *total* universe from the *directory-addressable* universe (a factor per ATECO section,
> see `src/coverage/config.ts`). Without this adjustment, coverage in sectors dominated by
> sole proprietorships would look artificially low.
