# Offline Example

This example runs without API keys, browser access, or network access. `mock_http_pages.json` maps each input website URL to a small HTML page containing the same fake company name and VAT code as the CSV row.

```bash
pnpm run enrich -- \
  --input examples/input_companies.csv \
  --out output/examples/enriched.csv \
  --mock-http examples/mock_http_pages.json
```

Expected status shape:

```text
5 rows processed
5 rows with status FOUND_WEBSITE_ONLY
5 rows with reason_code FOUND_WEBSITE_ONLY
0 EUR provider cost
```

Compare the generated CSV with `examples/expected_enriched.sample.csv`. `duration_ms` can differ between machines.
