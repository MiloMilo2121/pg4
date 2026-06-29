/**
 * Global test setup — HERMETIC external boundary.
 *
 * The engine loads the operator's real `.env` via `dotenv/config`. Once that
 * file carries live keys (APIFY_API_KEY, PERPLEXITY_API_KEY, SERPER_API_KEY, …)
 * and enable flags, any test that drives `runEnrichmentPipeline` with the
 * default stages would make REAL network calls (e.g. the Apify run-sync actor),
 * hanging the suite. Unit tests must never touch live services.
 *
 * This strips every API key/token + the paid-default switch + the external
 * provider master flags from process.env BEFORE tests run, so `available()` is
 * false and every paid/external stage skips. Tests that need a provider active
 * set their own key/flag explicitly (and call resetEnvCache).
 */
import { resetEnvCache } from '../../src/config/env';

for (const k of Object.keys(process.env)) {
  if (/_API_KEY$|_API_TOKEN$|_TOKEN$/.test(k)) delete process.env[k];
}
for (const k of [
  'PAID_DEFAULT_ON',
  'APIFY_ENABLED',
  'APIFY_MAPS_ENABLED',
  'APIFY_CONTACT_ENABLED',
  'APIFY_INSTAGRAM_ENABLED',
  'APIFY_FACEBOOK_ENABLED',
  'APIFY_TIKTOK_ENABLED',
  'APIFY_REGISTRO_ENABLED',
  'PERPLEXITY_ENABLED',
  'PERPLEXITY_RESOLVE_ENABLED',
]) {
  delete process.env[k];
}

resetEnvCache();
