/**
 * R13 — EU VIES VAT validation. Types + PURE format/checksum are the
 * default surface; the live network call (`checkVatViaVies`) is present
 * but is NEVER invoked by unit tests or by the disabled financial stage.
 * It is caller-gated and exercised only by the `RUN_SMOKE=1` smoke test.
 *
 * Ported from pg3's `enricher/core/financial/vies.ts`, but:
 *   - the Italian checksum lives in `vat.ts` (single source of truth);
 *   - no decorator-based retry, no hidden global cache;
 *   - the "provisional valid on 5xx/unreachable" heuristic is preserved
 *     but flagged so confidence stays below a hard-validated VAT.
 */

import { request } from 'undici';
import { normalizeVatCode, isItalianVatCode, validateItalianVatChecksum } from './vat';

export interface ViesInput {
  /** Raw or normalized VAT number (country code optional). */
  vatNumber: string;
  /** ISO country code; defaults to IT. */
  countryCode?: string;
}

export interface ViesResult {
  isValid: boolean;
  /** True when the underlying VIES service actually answered (not assumed). */
  checked: boolean;
  /** How the verdict was reached. */
  source: 'checksum' | 'vies' | 'provisional' | 'skipped';
  /** True when accepted only because VIES was unreachable but checksum passed. */
  provisional?: boolean;
  name?: string;
  address?: string;
  /** Non-fatal note for the caller's `financial_errors`. */
  note?: string;
}

/** Split + normalize a VAT into `{ countryCode, number }` for the VIES URL. */
export function formatVatForVies(
  raw: string | null | undefined,
  countryCode = 'IT',
): { countryCode: string; number: string } {
  const trimmed = (raw ?? '').trim();
  const prefix = trimmed.slice(0, 2).toUpperCase();
  const cc = /^[A-Z]{2}$/.test(prefix) ? prefix : countryCode.toUpperCase();
  return { countryCode: cc, number: normalizeVatCode(trimmed) };
}

/**
 * PURE pre-validation: format + (for IT) checksum. No network.
 * This is the free gate that must pass before any live VIES call is worth
 * making. Returns a `ViesResult` with `source: 'checksum'` and `checked:false`.
 */
export function preValidateVat(raw: string | null | undefined, countryCode = 'IT'): ViesResult {
  const { countryCode: cc, number } = formatVatForVies(raw, countryCode);

  if (cc === 'IT') {
    if (!isItalianVatCode(number)) {
      return { isValid: false, checked: false, source: 'checksum', note: 'it_vat_format_invalid' };
    }
    if (!validateItalianVatChecksum(number)) {
      return { isValid: false, checked: false, source: 'checksum', note: 'it_vat_checksum_failed' };
    }
    return { isValid: true, checked: false, source: 'checksum' };
  }

  // Non-IT: we can only sanity-check that there are some digits.
  return number.length >= 8
    ? { isValid: true, checked: false, source: 'checksum' }
    : { isValid: false, checked: false, source: 'checksum', note: 'vat_too_short' };
}

const VIES_BASE = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';

/**
 * LIVE VIES validation. **Caller-gated** — not called by default tests or
 * by the disabled stage. Always runs the pure pre-check first (free); only
 * hits the network when the checksum passes.
 *
 * Behaviour:
 *   - checksum fails            → `{ isValid:false, source:'checksum' }` (no call)
 *   - VIES 2xx & valid          → `{ isValid:true,  source:'vies', name, address }`
 *   - VIES 2xx & invalid        → `{ isValid:false, source:'vies' }`
 *   - VIES 4xx                   → `{ isValid:false, source:'vies' }`
 *   - VIES 5xx / network (IT)   → `{ isValid:true,  source:'provisional', provisional:true }`
 *   - VIES 5xx / network (other)→ `{ isValid:false, source:'vies', note:'vies_unreachable' }`
 *
 * Never throws: failures degrade to a `ViesResult`.
 */
export async function checkVatViaVies(
  input: ViesInput,
  opts: { timeoutMs?: number } = {},
): Promise<ViesResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pre = preValidateVat(input.vatNumber, input.countryCode);
  if (!pre.isValid) return pre;

  const { countryCode, number } = formatVatForVies(input.vatNumber, input.countryCode);
  const url = `${VIES_BASE}/${countryCode}/vat/${number}`;

  try {
    const res = await request(url, {
      method: 'GET',
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
    });
    const status = res.statusCode;

    if (status >= 200 && status < 300) {
      const data = (await res.body.json()) as { isValid?: boolean; name?: string; address?: string };
      if (data?.isValid === true) {
        return { isValid: true, checked: true, source: 'vies', name: data.name, address: data.address };
      }
      return { isValid: false, checked: true, source: 'vies' };
    }

    if (status >= 400 && status < 500) {
      await res.body.text().catch(() => undefined);
      return { isValid: false, checked: true, source: 'vies', note: `vies_http_${status}` };
    }

    await res.body.text().catch(() => undefined);
    // 5xx — VIES is famously flaky. Accept provisionally for IT (checksum already OK).
    if (countryCode === 'IT') {
      return { isValid: true, checked: false, source: 'provisional', provisional: true, note: 'vies_unavailable' };
    }
    return { isValid: false, checked: false, source: 'vies', note: 'vies_unavailable' };
  } catch {
    if (countryCode === 'IT') {
      return { isValid: true, checked: false, source: 'provisional', provisional: true, note: 'vies_unreachable' };
    }
    return { isValid: false, checked: false, source: 'vies', note: 'vies_unreachable' };
  }
}
