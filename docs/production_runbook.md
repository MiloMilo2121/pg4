# pg4 Production Runbook

**Branch:** `pg4/phase-4.4-structure-cleanup`
**Last updated:** 2026-06-01
**Status:** Controlled production — see maturity section below.

---

## 1. Current Maturity

pg4 is **not yet general-purpose production**. It is in **controlled production**:
repeatable real runs are authorized one province at a time, with explicit operator
sign-off before each paid run and before any new province or coverage mode.

Evidence supporting this assessment:

- Seven live rollout steps tracked in `docs/architecture.md`. Steps 1–4 and 7
  are verified; steps 5–6 (auto-split on overflow and Maps hardening) are pending.
- 585 unit tests pass with zero network; smoke tests are separately gated by
  `RUN_SMOKE=1`.
- Paid providers (Serper) have been validated at 95–97 % precision on BL, PD, VR,
  and TV provinces, but each new province or category requires its own audit pass
  before paid is promoted to routine.
- The `run` command (end-to-end scrape → enrich in one call) is a stub. Use
  `scrape` + `enrich` separately for all production runs until it is wired.
- The `validate_output` script (`src/scripts/validate_output.ts`) exists and is
  runnable via `tsx`; a `pnpm validate:output` convenience script is being added
  in this same sprint — reference the `tsx` invocation below until the script
  entry appears in `package.json`.

---

## 2. Standard Pipeline Overview

```
input (category + geography)
        |
        v
pnpm run scrape   → output/run.csv + output/run.jsonl
        |
        v
pnpm run enrich   → output/run_enriched.csv
                    output/run_enriched.jsonl
                    output/run_enriched.cost-ledger.jsonl
```

Two enrichment modes:
- **Free (default):** no `--enable-paid`; uses direct_fetch + hyper-guesser +
  DDG/Bing/crt.sh SERP (free providers). Zero Serper spend.
- **Paid opt-in:** `--enable-paid` + per-lead and run caps; activates Serper
  only if `SERPER_ENABLED=true` and `SERPER_API_KEY` is set in `.env`.

---

## 3. Verified CLI Flags

### `pnpm run scrape`

| Flag | Type | Required | Notes |
|------|------|----------|-------|
| `--out <path>` | string | **yes** | Raw CSV output path (JSONL written alongside automatically) |
| `--category "<text>"` | string | yes (live mode) | Business category to search, e.g. `"agenzie immobiliari"` |
| `--province <CC>` | string | no | 2-letter province code (e.g. `BL`, `PD`, `VR`); resolves comuni from the built-in `italy_geo` list |
| `--comuni "A,B,C"` | string | no | Explicit comma-separated commune list; alternative to `--province` |
| `--region <name>` | string | no | Optional region label; parsed but informational only in current code |
| `--maps` | boolean flag | no | Also scrape Google Maps. **Default: off** (PG-only). Pass the flag to enable |
| `--coverage <default\|full>` | string | no | Maps coverage mode. `default` = one query per comune; `full` = 5 sector-keyword variants per comune. Ignored unless `--maps` is also passed. Anything other than `default` or `full` throws an error |
| `--max-pages <n>` | integer | no | Per-municipality PG page cap. Default from config: 30 |
| `--checkpoint <path>` | string | no | Custom checkpoint file path. Default: `output/.scrape-checkpoint-<slug>.json` |
| `--fresh` | boolean flag | no | Delete previous CSV, JSONL, and checkpoint for this output basename before starting |
| `--headless false` | string | no | Show the Playwright browser window. Default: headless (pass the literal string `false` to disable) |
| `--inter-delay-ms <n>` | integer | no | Millisecond delay between pages. Default: 3000 |
| `--restart-every <n>` | integer | no | Restart the browser every N comuni to shed memory/state |
| `--allow-missing-jsonl` | boolean flag | no | Suppress the hard-stop when a checkpoint shows done entries but the JSONL is missing. Use only to acknowledge known data loss |
| `--fixture <spec>` | string | no | **Offline mode:** `pg=path.html,maps=path.html` or a single path combined with `--source` |
| `--source <pg\|maps>` | string | no | Required when `--fixture` is a single path |

**Note on undocumented flags:** `--region`, `--inter-delay-ms`, `--restart-every`, and
`--allow-missing-jsonl` are fully wired in `src/cli/scrape.ts` and
`src/discovery/scrape_pipeline.ts` but do not appear in `pnpm run scrape -- --help`
(the `printUsage()` text was not updated when they were added). The flags work.

### `pnpm run enrich`

| Flag | Type | Required | Notes |
|------|------|----------|-------|
| `--input <path>` | string | **yes** | Raw CSV input (output of scrape) |
| `--out <path>` | string | **yes** | Enriched CSV output path. JSONL written at same basename; ledger at `<out>.cost-ledger.jsonl` |
| `--enable-paid` | boolean flag | no | **Opt-in gate for paid providers.** Off by default. Has no effect unless the env also has `SERPER_ENABLED=true` + a valid `SERPER_API_KEY` |
| `--cost-ceiling-eur <n>` | number | no | Per-lead paid ceiling in EUR. Default from config: 0.10. Setting this to `0` forces paid off even if `--enable-paid` is present |
| `--run-cost-ceiling-eur <n>` | number | no | Aggregate run ceiling in EUR. Recommended for any paid run: `0.20` |
| `--ledger-path <path>` | string | no | Override ledger JSONL path. Default: `<out>.cost-ledger.jsonl` |
| `--mock-http <json>` | string | no | Offline fixture: maps URLs to HTML strings. Disables real HTTP, PG harvester, SERP, DNS, and API keys |

---

## 4. Commands (Copy-Pasteable)

### 4.1 PG-only province scrape

```bash
pnpm run scrape -- \
  --category "agenzie immobiliari" \
  --province BL \
  --out output/run_bl_pg.csv
```

### 4.2 PG + Maps full-coverage scrape

```bash
pnpm run scrape -- \
  --category "agenzie immobiliari" \
  --province PD \
  --maps \
  --coverage full \
  --fresh \
  --out output/run_pd_maps_full.csv
```

Expected: runtime 30–50 min for a medium province. Maps adds ~3× runtime vs
PG-only (5 scroll sessions per comune). The `--fresh` flag clears any previous
run at this output basename; omit it to resume an interrupted run.

### 4.3 Free enrich (zero cost)

```bash
pnpm run enrich -- \
  --input  output/run_pd_maps_full.csv \
  --out    output/run_pd_maps_full_enriched.csv
```

No `--enable-paid`. Uses direct_fetch, input-semantic, hyper-guesser, and free
SERP. Cost ledger will show `total_cost_eur=0`.

**Free SERP routing (R14).** Free SERP providers are selected per category by
`src/providers/provider_policy.ts`:
- For Italian real-estate categories (anything matching `/immobil/` — `agenzie
  immobiliari`, `consulenza immobiliare`, etc.) the free pass runs **`bing_html`
  only**; `dns_mx`, `crtsh`, `ddg_lite` are skipped. R12 evidence: those three
  converted **0** final websites on 1,492 leads (see
  `docs/r14_free_serp_routing_audit.md`).
- All other categories run the full free SERP set (unchanged).
- To force the full set for a real-estate run (debug / evaluation), set
  `SERP_EXPANDED_FREE_ENABLED=true`. A `debug`-level log line records which
  providers were skipped per lead.

### 4.4 Paid enrich with caps

Requires explicit operator authorization before each new province or category.

```bash
pnpm run enrich -- \
  --input  output/run_pd_maps_full.csv \
  --out    output/run_pd_maps_full_paid.csv \
  --enable-paid \
  --cost-ceiling-eur 0.005 \
  --run-cost-ceiling-eur 0.20
```

- `--cost-ceiling-eur 0.005`: max €0.005 spent on any single lead (the SmartSerperGate
  will deny Serper calls for weak leads even before this ceiling is hit).
- `--run-cost-ceiling-eur 0.20`: hard aggregate cap for the entire run. When the
  run total reaches this value the paid tier is disabled for remaining leads; the
  free pipeline continues to completion.
- Do not reuse the same `--out` basename as the free run. Using the same basename
  causes the output lock to collide and the second run to fail; it also overwrites
  the free-run artifacts you may need for comparison.

### 4.5 Validate output

Until `pnpm validate:output` is added to `package.json` (in progress this sprint),
invoke the validator directly:

```bash
# Raw scrape output
tsx src/scripts/validate_output.ts \
  --csv  output/run_pd_maps_full.csv \
  --jsonl output/run_pd_maps_full.jsonl

# Enriched output with ledger check and cost cap assertion
tsx src/scripts/validate_output.ts \
  --csv    output/run_pd_maps_full_paid.csv \
  --jsonl  output/run_pd_maps_full_paid.jsonl \
  --ledger output/run_pd_maps_full_paid.cost-ledger.jsonl \
  --max-cost 0.20
```

Exits 0 on pass, 1 on any failure. Stdout is a JSON summary with `ok`, counts,
and an `errors` array. Pipe through `jq` for readability:

```bash
tsx src/scripts/validate_output.ts \
  --csv output/run_pd_maps_full_paid.csv \
  --jsonl output/run_pd_maps_full_paid.jsonl \
  --ledger output/run_pd_maps_full_paid.cost-ledger.jsonl \
  --max-cost 0.20 | jq .
```

### 4.6 Offline quality gates (run before any live run)

```bash
pnpm run typecheck
pnpm test
```

Both must be green. CI runs these on every push. Smoke tests (real network)
require `RUN_SMOKE=1 pnpm run test:smoke` and are excluded from CI by default.

---

## 5. Go / No-Go Checks

Run `tsx src/scripts/validate_output.ts` (see §4.5) after every scrape and every
enrich. The validator enforces items 1–4; items 5–7 require manual inspection.

### 5.1 CSV/JSONL row alignment

`csv_rows` must equal `jsonl_rows` in the validator output. A mismatch means one
writer was interrupted mid-run — the artifact is not safe to use downstream.

### 5.2 Exactly one ledger summary

The `ledger_summaries` field in the validator output must be `1`. More than one
summary means two enrich runs appended to the same ledger file (concurrent-writer
violation or forgotten `--out` rename). Exactly zero means the run was killed
before `flushSummary()` ran — partial artifact.

Also check `run_ids` has exactly one entry. Multiple run IDs mean the ledger
contains entries from more than one run.

### 5.3 Cost cap respected

When `--run-cost-ceiling-eur` is set, confirm `total_cost_eur` in the ledger
summary is at or below the cap. The validator enforces this when `--max-cost` is
passed to `validate_output`.

### 5.4 No mojibake

The validator checks `company_name`, `city`, `address`, `category`, `province`,
and `region` for `Ã`, `ï¿½`, `â€`, and `Â<non-letter>` sequences. Any failure
indicates a character-encoding regression at the parser or CSV writer boundary.

### 5.5 Category mismatch threshold

After a PG + Maps full run, inspect the `category_match` distribution in the
enriched JSONL. The R11 benchmark observed 20.6 % mismatch rate on
`agenzie immobiliari` (PD, 2 comuni). Rates above ~25 % on Maps-heavy runs
deserve spot-check: hand-sample 10 mismatch rows to confirm they are correctly
flagged adjacent businesses, not silent misclassification of real targets.

### 5.6 Maps cap / no_feed threshold

A Maps session logs `cap_likely=true` when it likely hit the ~120-result Google
cap, and `no_feed` when the session returned no feed (single-place result or
rare block). Acceptable thresholds from R11 (10 sessions, dense PD area):
`cap_likely ≤ 40 %`, `no_feed ≤ 15 %`. Higher rates indicate the area is too
dense for `--coverage full` without geo-splitting (Phase 4.x, not yet
implemented).

Check the scrape log or the checkpoint file for `cap_likely` and `overflow`
counts:

```bash
grep '"cap_likely":true\|"overflow":true' output/.scrape-checkpoint-agenzie-immobiliari.json | wc -l
```

### 5.7 SERP paid precision gate

Before promoting a paid run to production routine, audit a sample of SERP_PAID
rows: fetch each `official_website` and confirm the lead's P.IVA appears in the
page body (method = `piva`, confidence = 0.95). Acceptable threshold: ≥ 85 %
precision on the audited sample. If precision drops below 85 %, stop the paid
pipeline and file a new FP class in the `DIRECTORIES` blocklist
(`src/discovery/website/paid_evidence_gate.ts`).

Observed precision across validated provinces: BL 100 %, PD 96.2 %, VR 95.5 %,
TV 96.9 %.

---

## 6. Paid Provider Policy

- **Default: paid is OFF.** No `SERPER_ENABLED` flag, no `SERPER_API_KEY` in `.env`
  unless you intend to run paid.
- **Activation requires two conditions simultaneously:** `--enable-paid` CLI flag
  AND `SERPER_ENABLED=true` + `SERPER_API_KEY` in `.env`. Missing either condition
  silently keeps paid off — no error, no warning escalation.
- **Always set both caps:** `--cost-ceiling-eur 0.005` (per-lead) and
  `--run-cost-ceiling-eur 0.20` (per run). The run cap is the hard stop; the
  per-lead cap enforces bisturi behavior (SmartSerperGate denies Serper calls on
  weak leads before the per-lead ceiling is hit).
- **Setting `--cost-ceiling-eur 0` forces paid off** even if `--enable-paid` is
  present. Use this for a "free regression with paid flag present" check.
- **Stop condition:** if a mid-run audit of SERP_PAID rows shows precision below
  85 %, abort the run. Do not re-run until the new FP host family is added to
  the `DIRECTORIES` blocklist and `pnpm test` is green.
- **Per-province authorization:** each new province or category for paid SERP
  requires explicit operator sign-off. Past provinces (BL, PD, VR, TV) are
  authorized for re-runs at the same caps; new provinces require a fresh audit
  after the first paid run.

---

## 7. Recovery Procedures

### 7.1 Stale lock

The output lock lives at `<out-path>.lock`. It stores the PID of the process
that acquired it.

**PID-reuse guard (R13.1):** the lock's PID-based liveness check
(`process.kill(pid, 0)`) is unreliable on its own — the OS reuses PIDs, so a dead
scrape/enrich PID (say, 96134) can be inherited by an unrelated process (a shell, a
pnpm install) and read as "alive" forever. The lock now defends against this with a
**max-age reclaim**: a lock whose PID looks alive but whose `created_at` is older
than `DEFAULT_MAX_LOCK_AGE_MS` (12h, `src/runtime/output_lock.ts`) is treated as
stale and reclaimed automatically, with a `[output-lock] stale lock reclaimed by
age` warning. A malformed/unreadable lock is reclaimed only once its file mtime
exceeds the same window. So a stuck lock now self-heals within 12h; manual
intervention is only needed **inside** that window.

**Safe procedure to clear a stale lock within the 12h window:**

```bash
# Read the lock
cat output/my_run.csv.lock

# Confirm what process actually holds the PID (replace 96134 with the pid in the lock)
ps -p 96134 -o command

# Only if the command output is NOT a scrape or enrich invocation:
rm output/my_run.csv.lock
```

If `ps -p <pid> -o command` shows nothing (process does not exist) or shows an
unrelated process, it is safe to `rm` the lock file. If it shows a live scrape or
enrich command on this output path, do not remove the lock — wait for that process
to finish.

### 7.2 Interrupted scrape — resume

A scrape interrupted by Ctrl-C, network failure, or captcha will have:
- A checkpoint file at `output/.scrape-checkpoint-<slug>.json`
- A partial JSONL at the same `--out` basename

To resume, re-run the identical command **without `--fresh`**:

```bash
pnpm run scrape -- \
  --category "agenzie immobiliari" \
  --province PD \
  --out output/run_pd_pg.csv
```

The pipeline reads the checkpoint and skips already-done `(provider:category:location:page)`
keys. It rehydrates the JSONL into the deduplicator before iterating remaining
comuni, so the final CSV is a complete, deduplicated merge.

**Hard-stop condition:** if the checkpoint shows done entries but the JSONL is
missing (e.g., the file was deleted), the pipeline throws and refuses to continue.
This is intentional — resuming without the JSONL would produce an incorrect
deduplicated set. Options:
- Pass `--allow-missing-jsonl` to acknowledge the data loss and resume anyway
  (the deduplicator starts empty; there will be duplicates with any previously
  output rows).
- Pass `--fresh` to wipe the checkpoint and JSONL and start a clean run.

### 7.3 `--fresh` semantics

`--fresh` deletes three files before the run starts:
1. `<out>.csv`
2. `<out>.jsonl`
3. The checkpoint file (`output/.scrape-checkpoint-<slug>.json` by default, or the
   `--checkpoint` path if specified)

It does NOT delete any other output files in the directory. When using a shared
checkpoint path (the default includes only the category slug, not the province),
two runs for different provinces but the same category share the same checkpoint
file. A `--fresh` on one run clears the other's checkpoint. If you need isolated
checkpoints, pass an explicit `--checkpoint output/my_run_checkpoint.json`.

### 7.4 Interrupted enrich

Enrich does not use a checkpoint. If interrupted, the partial CSV and JSONL are
incomplete and the ledger may have no summary (or a partial set of per-call
entries). Re-run enrich from scratch with the same flags:

```bash
pnpm run enrich -- \
  --input  output/run_pd_pg.csv \
  --out    output/run_pd_pg_enriched.csv
```

The output lock is released on exit (including abnormal exit via finally block).
If a lock is stale after an interrupted enrich, follow the procedure in §7.1.

---

## 8. What NOT To Do

**Never regenerate a raw output while a live enrich is consuming it as input.**
A free/paid enrich reads `<raw>.csv` as its `--input` for its entire run (which can
be 45+ min on a full province). Re-running `scrape --fresh --out <raw>.csv` during
that window clobbers the file the enrich is actively reading → corrupt enrich output
and wasted run. Before launching any scrape/`--fresh` on a raw basename, confirm no
enrich is reading it: `ps aux | grep "enrich.*<raw-basename>"`. This near-miss is
the reason §7.1's max-age guard exists. (Real incident, 2026-06-01: a 1,492-lead
free enrich was 89% done when a `--fresh` re-scrape of the same raw was queued;
caught at preflight.)

**Do not run two writers on the same output basename.**
The output lock (`<out>.lock`) prevents concurrent corruption, but it does this
by throwing an error on the second invocation. Running two enrich processes with
the same `--out` in sequence (without renaming) will cause the second to overwrite
the first's ledger because the cost ledger truncates the file on init. Always
use distinct output basenames for distinct runs.

**Do not use partial or invalid artifacts.**
A CSV that failed mid-write (interrupted before the writer closed the file) may
have truncated rows. A JSONL with a different row count than the CSV is corrupt.
Run `validate_output` before using any artifact downstream. Delete and re-run
rather than attempting to stitch partial files.

**Do not commit `.env` or `output/`.**
`.env` contains API keys (SERPER_API_KEY etc.). `output/` contains PII-adjacent
business data. Both are gitignored. Confirm with `git status` before any commit.
Do not add these to `.gitignore` exclusion exceptions.

**Do not run live scrape or live enrich in CI.**
CI (`pnpm run typecheck && pnpm test`) is offline. Smoke tests (`RUN_SMOKE=1`)
are excluded from CI by design. Do not set `RUN_SMOKE=1` in CI environment
variables.

**Do not reuse a paid `--out` path for a free run.**
The cost ledger is truncated at enrich startup. Running free enrich over a paid
`--out` path destroys the paid run's ledger. Use a distinct basename (e.g.
`_paid.csv` vs `_free.csv`).

**Do not infer accuracy from found-count alone.**
A higher `with_website` count is meaningless without an audited precision sample.
Precision degradation (new FP host families) is invisible in aggregate metrics.

---

## 9. Production Readiness Checklist

Run this checklist before each new province or category campaign.

### Pre-run

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` exits 0 (all unit tests pass)
- [ ] `.env` has correct keys for the intended mode (free: no Serper keys needed;
  paid: `SERPER_ENABLED=true` + `SERPER_API_KEY` set)
- [ ] Output directory `output/` exists and has sufficient disk space
- [ ] No stale `.lock` files on the intended output basename (check with
  `ls output/*.lock`)
- [ ] For Maps runs: confirm Playwright Chromium is installed
  (`npx playwright install chromium`)
- [ ] For paid runs: explicit operator authorization on record for this province
  and cap amount

### Post-scrape

- [ ] `tsx src/scripts/validate_output.ts --csv <out>.csv --jsonl <out>.jsonl`
  exits 0
- [ ] `csv_rows` equals `jsonl_rows` in validator output
- [ ] No mojibake errors in validator output
- [ ] `cap_likely` and `overflow` counts within expected thresholds (§5.6)
- [ ] Category mismatch rate within expected range for the coverage mode (§5.5)

### Post-enrich

- [ ] `tsx src/scripts/validate_output.ts --csv <out>.csv --jsonl <out>.jsonl
  --ledger <out>.cost-ledger.jsonl --max-cost <cap>` exits 0
- [ ] `ledger_summaries === 1`
- [ ] `run_ids` has exactly one entry
- [ ] `total_cost_eur ≤ run-cost-ceiling-eur` (if paid)
- [ ] No mojibake in enriched output
- [ ] For paid runs: spot-audit ≥ 10 % of SERP_PAID rows for precision ≥ 85 %
  before promoting output to downstream consumers

### Before commit

- [ ] `git status` confirms no `.env`, no `output/` files staged
- [ ] `pnpm run typecheck && pnpm test` still green after any code changes

---

## 10. Appendix — Output File Map

For a run with `--out output/run_pd.csv`:

| File | Written by | Contents |
|------|-----------|---------|
| `output/run_pd.csv` | scrape | Raw leads, `RAW_CSV_COLUMNS` schema |
| `output/run_pd.jsonl` | scrape | Same rows as JSON objects |
| `output/.scrape-checkpoint-<slug>.json` | scrape | Per-`(provider:category:location:page)` status |
| `output/run_pd_enriched.csv` | enrich | Enriched leads, `ENRICHED_CSV_COLUMNS` schema |
| `output/run_pd_enriched.jsonl` | enrich | Same rows as JSON objects |
| `output/run_pd_enriched.cost-ledger.jsonl` | enrich | Per-call cost entries + one `kind:"summary"` tail line |
| `output/run_pd_enriched.csv.lock` | enrich | Held during run; deleted on normal exit |

The ledger path defaults to `<csv-out-without-extension>.cost-ledger.jsonl`
and can be overridden with `--ledger-path`.

`ENRICHED_CSV_COLUMNS` is a strict superset of `RAW_CSV_COLUMNS` (append-only;
no column reordering). R13.1 appended `financial_source`, `financial_confidence`,
and `financial_notes` as the last three columns after `errors`.
