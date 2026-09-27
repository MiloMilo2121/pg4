# tools/

Operator passes and research probes. They run with `pnpm tsx tools/<path>.ts` and are typechecked and linted with the rest of the repo. They are **not** part of the shipped runtime: `pnpm build` emits `src/` only.

| Path | What |
|---|---|
| `enrich3/` | ENRICH-3 passes: portal harvest/join, places, bilanci, registro, email verify, firecrawl, export. Paid passes need an explicit `--run-cost-ceiling-eur` and go through `ProviderRouter.invoke`. |
| `export_outbound_logistica.ts` | Projects the logistics campaign raw JSONL into the outbound CSV. |
| `consolidate_leads.ts` | Merges campaign outputs into one deduplicated lead file. |
| `probes/` | Read-only measurement harnesses behind the reports in `docs/`. |

Every script's header documents its exact invocation.
