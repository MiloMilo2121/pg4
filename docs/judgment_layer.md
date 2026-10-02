# Judgment Layer (L2–L5) — runbook & activation

Extends PG4 with discovery refinement (website+social) and a **two-axis judgment**:
**A** = intrinsic strength (THIRD-PARTY sources), **B** = quality of self-expression (OWNED channels),
**GAP = A−B**, target verdict + lever. Target = high A + low B; false positive = "fuffa" (fluff: low A + high B).

Source of truth for the judgment: the internal commercial-strength ontology (v2, unpublished).
The logic lives in `src/judgment/config/` (transcribed from v2, every entry carries a `ref`; a test enforces this).
Only the **numbers** (thresholds/weights) are a system extension — `thresholds` in `config/v0.ts`.

## How it runs (offline-first, free, €0)
- **Website adapter**: live, free — works on its own.
- **A-collector via free SERP (Bing)**: searches for awards/patents/heritage trademarks/press at €0 (low yield). A result becomes `confirmed_present` only when it is **third-party** (not the company's own domain or social profile), carries **every distinctive token of the name** (at least one not a generic trade word such as "costruzioni"), and is **corroborated** by the company's city, province `(PD)`, VAT number or own domain in the title/snippet. A bare name match is not evidence: the queries contain the name, so the company's own pages and namesakes elsewhere always match.
- Everything else (Places, OpenAPI registry, paid social search, **LLM judges**) is **wired-but-disabled** behind key+flag. Without keys the judges run **deterministically** (transparent baseline); with `--paid`+keys they are refined with Claude. The LLM re-grades only keys that carry an observed signal: an unobserved B surface stays `unknown` and an unobserved A subdimension stays `insufficient_evidence`, whatever the model answers.

## Running

### Dashboard (dev)
```
pnpm run serve            # http://localhost:8787
# then in the front end (web/): select companies → buttons L2 Discovery · L3 Segnali A/B · L4 Giudizio · L5 Validazione
# the "Verdetto" (verdict) column shows target + quadrant (A?B? = axis not measured, NOT low A)
```

### CLI on a list (CSV)
```
pnpm run judge -- --input output/lista.csv --out output/judged.jsonl [--two-pass] [--paid] [--limit N]
```
`--two-pass` (§17): pass 1 collects the signals → computes the category benchmark → pass 2 judges RELATIVE to the median. Output: one JSONL line per company (target/quadrant/scoreA/scoreB/levers/validation) + an on-screen summary.

### Golden set / eval (§15)
```
cp tests/fixtures/judgment_golden.example.json tests/fixtures/judgment_golden.json   # then FILL IN by hand
pnpm run judge:eval -- --golden tests/fixtures/judgment_golden.json [--paid]
```
Prints: precision/recall on the target verdict + **A-agreement and B-agreement SEPARATELY** (so you know which judge is wrong) + a confusion matrix over the quadrants.

## Activating the strong A sources (keys — choice per vertical)
In `.env` (then `--paid` where required):
- **Chamber of Commerce registry** (manufacturing): `OPENAPI_ENABLED=true`, `OPENAPI_API_KEY=…` → company age/employees/export/corporate purpose (the real B2B A-spine). Entity guard `isWrongEntity` already applied.
- **Google Places** (dental/restaurants): `GOOGLE_PLACES_ENABLED=true`, `GOOGLE_PLACES_API_KEY=…` → review content/rating (local A-spine) + GBP/management (B, partial via API).
- **LLM judges (Claude)**: `ANTHROPIC_ENABLED=true`, `ANTHROPIC_API_KEY=…` **or** `OPENROUTER_ENABLED=true`, `OPENROUTER_API_KEY=…`. Then `--paid`.
- Ad library / managed social: `ADLIB_*`, `BRIGHTDATA_*`/`FIRECRAWL_*` (optional).

Everything is paid-gated OFF by default: no paid call without flag+key.

## Residual risk (do not forget)
The **thesis** — that the two-axis judgment recognizes the strong-but-silent company — is proven at the **logical level** (test `A+B-→target yes`), **NOT on real data**. With the A axis off, every company drifts towards `A?`/fuffa. Real validation comes **only** from the golden set with **measured A** (one strong A source ON). Sequence: (1) quadrant fix ✓ → (2) turn on ONE A source per vertical → (3) golden set with measured A → (4) ONLY THEN tune `thresholds`.

## Versioning (§20)
Every verdict is stamped `{ontology_version, judgment_config_version, judge_prompt_version, model_id}`. Changing the logic = a new `judgment_config` version + an L4 re-run, **never** a migration. The schema (`db/migrations/0002`) only holds the output + a snapshot of the config as *data*.
