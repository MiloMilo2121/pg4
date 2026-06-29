/**
 * Phase C.2 — Italian phone normalization to E.164.
 *
 * Italian numbering (ITU E.164, country code +39):
 *   - LANDLINES keep their leading 0 after the country code:
 *     "0422 000177" → "+390422000177" (the 0 is part of the area code).
 *   - MOBILES start with 3: "339 0005503" → "+393390005503".
 *   - Toll/free service numbers (800/199/892…) are normalized the same
 *     digit-preserving way.
 *
 * The function is deliberately conservative: when the digits don't look
 * like a plausible Italian number (too short, too long, foreign prefix),
 * it returns undefined and the caller keeps the original string — a wrong
 * normalization is worse than none, and the deduper has its own
 * format-tolerant phone key.
 */

/** Plausible national-number lengths for Italy (digits after +39). */
const MIN_NATIONAL_LEN = 6; // shortest real landlines (rare, small towns)
const MAX_NATIONAL_LEN = 11; // longest mobiles/landlines

export interface NormalizedPhone {
  /** E.164 string, e.g. "+390422000177". */
  e164: string;
  kind: 'landline' | 'mobile' | 'service';
}

export function normalizePhoneE164(raw: string | undefined | null): NormalizedPhone | undefined {
  if (!raw) return undefined;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return undefined;

  // Strip international prefixes for Italy: 0039… / 39… (the latter only
  // when what remains is a plausible national number — "39" can also be
  // the start of a mobile "393…" with no country code).
  if (digits.startsWith('0039')) {
    digits = digits.slice(4);
  } else if (digits.startsWith('39') && digits.length >= 2 + MIN_NATIONAL_LEN) {
    const rest = digits.slice(2);
    // "39…" is the country code only if the remainder itself starts like an
    // Italian number (0 = landline, 3 = mobile). "390423…"→national 0423…;
    // a bare mobile "3934567890" must NOT lose its leading 39.
    if ((rest.startsWith('0') || rest.startsWith('3')) && rest.length >= MIN_NATIONAL_LEN && rest.length <= MAX_NATIONAL_LEN) {
      digits = rest;
    }
  }

  if (digits.length < MIN_NATIONAL_LEN || digits.length > MAX_NATIONAL_LEN) return undefined;

  if (digits.startsWith('0')) {
    return { e164: `+39${digits}`, kind: 'landline' };
  }
  if (digits.startsWith('3')) {
    // Italian mobiles are 9–10 digits starting with 3.
    if (digits.length < 9 || digits.length > 10) return undefined;
    return { e164: `+39${digits}`, kind: 'mobile' };
  }
  if (/^(800|199|892|899|144|166)/.test(digits)) {
    return { e164: `+39${digits}`, kind: 'service' };
  }
  return undefined;
}

/**
 * Apply E.164 normalization to a lead in place: `phone` becomes the E.164
 * form, the original string moves to `phone_raw`. No-ops when the phone is
 * missing, already E.164, or not confidently parseable.
 */
export function normalizeLeadPhone<T extends { phone?: string; phone_raw?: string }>(lead: T): T {
  if (!lead.phone || lead.phone_raw !== undefined) return lead;
  const norm = normalizePhoneE164(lead.phone);
  if (!norm || norm.e164 === lead.phone) return lead;
  lead.phone_raw = lead.phone;
  lead.phone = norm.e164;
  return lead;
}
