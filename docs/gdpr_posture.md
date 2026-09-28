# pg4 — GDPR posture (2026-06-10)

Current state: what pg4 processes, where the data lives, which safeguards are
IMPLEMENTED, and which legal decisions remain THE OPERATOR'S
RESPONSIBILITY. This document is not legal advice.

## 1. What personal data pg4 processes

pg4 collects publicly exposed business data from PagineGialle and
Google Maps about Italian SMEs. It becomes personal data when the
data subject is identifiable:

| field | when it is personal data |
|---|---|
| `company_name` | sole proprietorships / professional practices ("Studio Rossi", "Bevilacqua Barbara") identify the person |
| `phone` / `phone_raw` | direct numbers, including personal mobiles |
| `vat_code` / `vat_code_final` | for sole proprietorships the P.IVA (VAT number) is traceable to the person |
| `address` | the business address is often the home address for sole proprietorships |
| `pec` / `email_inferred` | personal contact details |
| `decision_maker_*` | name/role/LinkedIn of a natural person |

Expected legal basis for the processing: **legitimate interest
(Art. 6(1)(f))** for B2B prospecting towards publicly published
professional contact details — BUT the formal decision, with the balancing
test, rests with the operator (see §5).

## 2. Where the data lives

- **Local filesystem only** on the machine executing the run:
  `output/*.csv`, `output/*.jsonl` (+ `*.log.jsonl` logs, ledger).
- No database, no automatic cloud sync, no third-party storage
  service. `output/` is excluded from git.
- Flows to third parties DURING processing:
  - PagineGialle / Google Maps: browsing public pages.
  - Serper.dev (only with `--enable-paid`): SERP queries contain the company
    name + comune (municipality) — for sole proprietorships this transmits a
    personal name to a US processor. See §5 (processor agreement).
  - VIES (EU Commission): P.IVA validation.

## 3. IMPLEMENTED mechanisms (Phase D)

| mechanism | how | where |
|---|---|---|
| **Suppression list** (do-not-contact / objection) | CSV `phone,vat,reason,date`; flag `--suppression-list`, env `SUPPRESSION_LIST`, or `suppression.csv` auto-discovered next to the output. Matching leads are DROPPED from scrape and enrich, and counted in the run record. | `src/compliance/suppression.ts` |
| **Retention** | `--retention-days N` / env `RETENTION_DAYS`: at the start of a run, deletes artifacts older than N days in the output dir. Always protected: `_runs.jsonl`, `suppression.csv`, `*.lock`. Default: OFF (operator decision). | `src/compliance/retention.ts` |
| **Record of processing (Art. 30 support)** | `_runs.jsonl`: one record per run with command, arguments, timestamp, counts, outcome. Append-only, never deleted by retention. | `src/runtime/run_record.ts` |
| **Right-to-access / deletion lookup** | `pnpm run lookup -- --piva X | --phone Y`: scans all outputs and reports file+line where the data subject appears. Deletion stays manual BY DESIGN (silently rewriting artifacts already delivered would put them out of sync with the copies held by clients). | `src/cli/lookup.ts` |

### Operational flow for a deletion request

1. `pnpm run lookup -- --phone <number>` (or `--piva`) → list of files+lines.
2. Remove the lines from the local files (or regenerate the output).
3. Add the data subject to `suppression.csv` → they will not reappear in future runs.
4. Notify the clients who received files containing the data subject
   (human process, outside pg4).

## 4. What pg4 does NOT do (declared limits)

- It does not track to whom each file was DELIVERED (delivery log = operator
  process).
- It does not encrypt outputs at rest (local filesystem; macOS FileVault is the
  current mitigation).
- It does not sync the suppression list with the Registro Pubblico delle
  Opposizioni (RPO, the Italian public opt-out register): RPO registration must
  be checked before TELEPHONE campaigns — out of scope for email/web outreach.

## 5. PENDING OPERATOR DECISIONS (legal, not implementable in code)

1. **Formal legal basis** — legitimate interest under Art. 6(1)(f) with a
   documented balancing test, or a contract with the client as controller
   (the pg4 operator as processor). Determines who the data controller is
   for each campaign.
2. **Retention period** — how many days? (then: `RETENTION_DAYS=N`
   in the scheduler/env and the mechanism is already active).
3. **DPIA** — assess whether the volume/systematic nature of the collection
   requires a formal DPIA (Art. 35). At the current provincial scale (~1.5k
   records/run) "no" is defensible; at a recurring national scale the
   answer probably changes.
4. **Processor agreement with Serper.dev** — paid queries transmit
   (potentially personal) names to a non-EU provider. Verify Serper's DPA
   + SCCs, or keep it off for sole proprietorships.
5. **Privacy notice** — the Art. 14 notice (data not obtained from the
   data subject) for contacted leads: who provides it, where, when
   (typically in the first outreach contact).
6. **Opt-out register (RPO)** — mandatory ONLY for telemarketing:
   if the leads will be called, a pre-campaign RPO check is required.

## 6. Internal references

- `docs/decision_log.md` — conservative defaults chosen and why.
- `docs/production_runbook.md` — operational commands (suppression, lookup).
- `_runs.jsonl` — run register (never deleted by pg4).
