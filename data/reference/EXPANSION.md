# How to expand the DB — sectors, areas, dimensions

The system is designed so that any expansion is a change in **one place only**.
Quick reference.

## 1) Adding a SECTOR (industry)
The only file to touch: **`data/reference/sectors.json`** → add an object to `sectors`:
```json
{
  "slug": "autofficine",
  "label": "Autofficine",
  "keyword": "autofficina",
  "atecoDivisions": ["45"],
  "queryVariants": ["autofficina", "officina auto", "gommista", "carrozzeria"]
}
```
Then:
1. Make sure the `keyword` is **classifiable** into one of the `atecoDivisions`: if it is not, add the tokens to `category_ateco_map.json`. The test `tests/unit/coverage_sectors.test.ts` checks consistency automatically (it fails if the sector is misconfigured).
2. Re-run the generalized driver: `MAPS=1 MAXPAGES=25 nohup bash scripts/campaign.sh <PROVINCE...> &`. It will use the new sector with no other changes.
   - Only a subset: `SECTORS=autofficine bash scripts/campaign.sh MI BG`.

> Note: the Google Maps `queryVariants` expansion (`--coverage full`) is driven by `sectors.json` via `src/discovery/sources/maps_coverage.ts` (with a hardcoded fallback table), so a new sector's variants apply automatically.

## 2) Adding an AREA (provincia / region)
**No change to the code or the catalog.** The complete comuni (municipalities) of all **47 Northern provinces** (8 regions) are already in `comuni_nord.json`, and the geography in `src/geo/regions.ts`. Just pass the 2-letter codes to the driver:
```
MAPS=1 nohup bash scripts/campaign.sh MI BG BS CO VA &   # Lombardia
```
To extend BEYOND Northern Italy: add the provinces to `comuni_nord.json` (same format) and the regions to `geo_regions.ts`.

## 3) Adding an ATECO DIVISION to the gap map
- The **denominator** (universe) already covers 79 ISTAT divisions (`istat_asia_universe.csv`).
- To **classify** scraped leads into that division: add tokens/keywords to `category_ateco_map.json`.
- The full taxonomy (88 divisions) is in `ateco_divisions.json`.

## 4) Adding ENRICHMENT (level 2)
Parked by choice: the current DB is level 1 (company registry data + phone + category + geo). Email/PEC/website require paid providers (Serper + Apify/registry).

## Key files
| what | file |
|---|---|
| sector catalog | `data/reference/sectors.json` (+ loader `src/coverage/sectors.ts`) |
| complete Northern comuni | `data/reference/comuni_nord.json` |
| ISTAT universe | `data/reference/istat_asia_universe.csv` |
| category→ATECO crosswalk | `data/reference/category_ateco_map.json` |
| ATECO taxonomy | `data/reference/ateco_divisions.json` |
| Northern geography | `src/geo/regions.ts` |
| scraping driver (extensible) | `scripts/campaign.sh` |
