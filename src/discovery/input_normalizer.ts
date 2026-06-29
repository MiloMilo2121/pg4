import type { Lead } from '../types/lead';
import type { NormalizedLead } from '../types/discovery';

/** Italian province codes (sigle automobilistiche). Used by normalizer. */
export const PROVINCE_CODES = new Set<string>([
  'AG','AL','AN','AO','AR','AP','AT','AV','BA','BT','BL','BN','BG','BI','BO','BZ','BS','BR',
  'CA','CL','CB','CI','CE','CT','CZ','CH','CO','CS','CR','KR','CN','EN','FM','FE','FI','FG',
  'FC','FR','GE','GO','GR','IM','IS','SP','AQ','LT','LE','LC','LI','LO','LU','MC','MN','MS',
  'MT','VS','ME','MI','MO','MB','NA','NO','NU','OG','OT','OR','PD','PA','PR','PV','PG','PU',
  'PE','PC','PI','PT','PN','PZ','PO','RG','RA','RC','RE','RI','RN','RM','RO','SA','SS','SV',
  'SI','SR','SO','TA','TE','TR','TO','TP','TN','TV','TS','UD','VA','VE','VB','VC','VR','VV',
  'VI','VT',
]);

const PUBLIC_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'libero.it', 'alice.it', 'tim.it',
  'tiscali.it', 'virgilio.it', 'pec.it', 'icloud.com', 'live.com', 'aruba.it',
]);

const LEGAL_SUFFIX_REGEX =
  /(?:\s+|^|\W)(s\.?\s*r\.?\s*l\.?(?:\s*s\.?)?|srl|s\.?\s*p\.?\s*a\.?|spa|s\.?\s*n\.?\s*c\.?|snc|s\.?\s*a\.?\s*s\.?|sas|s\.?\s*c\.?\s*a\.?\s*r\.?\s*l\.?|scarl|srls)(?:\s+|$|\W)/gi;

function cleanString(str: string | undefined | null): string {
  if (!str) return '';
  let cleaned = String(str).normalize('NFC');
  cleaned = cleaned.replace(/[​-‍﻿]/g, ''); // zero-width
  cleaned = cleaned.replace(/[‐-―]/g, '-'); // dash variants
  cleaned = cleaned.replace(/["'«»‹›„“”‘’]/g, ''); // quotes
  return cleaned.replace(/\s+/g, ' ').trim();
}

function normalizeProvince(value: string | undefined): string | undefined {
  const cleaned = cleanString(value).toUpperCase();
  if (!cleaned) return undefined;
  if (PROVINCE_CODES.has(cleaned)) return cleaned;
  const m = cleaned.match(/\b([A-Z]{2})\b/);
  if (m && PROVINCE_CODES.has(m[1])) return m[1];
  return undefined;
}

function normalizeVat(value: string | undefined): string | undefined {
  const digits = cleanString(value).replace(/^IT/i, '').replace(/\D/g, '');
  return digits.length === 11 ? digits : undefined;
}

function normalizeWebsite(value: string | undefined): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const withProtocol = /^[a-z]+:\/\//i.test(cleaned) ? cleaned : `https://${cleaned.replace(/^\/+/, '')}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    parsed.hash = '';
    parsed.search = '';
    parsed.username = '';
    parsed.password = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Normalize phone(s). Borrowed from pg1 (split on `;` and ` / `, +39 prefix
 * for Italian landline/mobile). Returns the FIRST normalized phone — multi
 * phones are rare in scraped data and hurt downstream matching.
 */
function normalizePhone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidates = String(value).split(/[;]|\s\/\s/);
  for (const c of candidates) {
    let clean = c.replace(/[^0-9+]/g, '');
    if (clean.startsWith('0039')) clean = '+' + clean.slice(2);
    const digitsOnly = clean.replace(/\+/g, '');
    if (digitsOnly.length < 8) continue;
    if (!clean.startsWith('+')) {
      if (clean.startsWith('0') || clean.startsWith('3')) clean = '+39' + clean;
    }
    return clean;
  }
  return undefined;
}

export function normalizeLead(lead: Lead): NormalizedLead {
  let name = cleanString(lead.company_name);
  let city = cleanString(lead.city);
  const address = cleanString(lead.address);
  const phone = normalizePhone(lead.phone);
  const website = normalizeWebsite(lead.website);
  const vat_code = normalizeVat(lead.vat_code);

  let provincia = normalizeProvince(lead.province);

  // Province extraction from "City (BS)" / "City - BS" / "City/BS"
  const provFromCity = city.match(/(.+?)\s*[(\-\/]\s*([A-Za-z]{2})\s*[)]?$/);
  if (provFromCity && PROVINCE_CODES.has(provFromCity[2].toUpperCase())) {
    city = provFromCity[1].trim();
    provincia = provincia ?? provFromCity[2].toUpperCase();
  }
  const provFromName = name.match(/(.+?)\s*[(\-\/]\s*([A-Za-z]{2})\s*[)]?$/);
  if (provFromName && PROVINCE_CODES.has(provFromName[2].toUpperCase())) {
    name = provFromName[1].trim();
    provincia = provincia ?? provFromName[2].toUpperCase();
  }

  // Legal suffix variants
  const variants: string[] = [];
  const stripped = name.replace(LEGAL_SUFFIX_REGEX, ' ').replace(/\s+/g, ' ').trim();
  if (stripped && stripped !== name) {
    variants.push(stripped);
    variants.push(`${stripped} SRL`);
    variants.push(`${stripped} S.R.L.`);
  }
  if (!variants.includes(name) && name) variants.push(name);

  // Email + domain
  let email = cleanString(lead.email).toLowerCase();
  let email_domain: string | undefined;
  if (email) {
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (ok) {
      const domain = email.split('@')[1] ?? '';
      const isPec = /pec|legalmail|cert/.test(domain);
      if (domain && !PUBLIC_EMAIL_PROVIDERS.has(domain) && !isPec) email_domain = domain;
    } else {
      email = '';
    }
  }

  // Quality score (0..1)
  let score = 0;
  if (name && city) score += 0.5;
  if (email_domain) score += 0.2;
  if (vat_code) score += 0.2;
  if (website) score += 0.15;
  if (phone || address) score += 0.1;
  if (provincia) score += 0.05;
  if (name && city && (email_domain || vat_code || website) && (phone || address || provincia)) {
    score = Math.max(score, 0.85);
  }
  if (score === 0 && name) score = 0.1;

  return {
    company_name: name,
    company_name_variants: Array.from(new Set(variants)),
    city: city || undefined,
    province: provincia,
    address: address || undefined,
    phone,
    email: email || undefined,
    email_source: email ? 'input' : undefined,
    email_domain,
    website,
    vat_code,
    quality_score: Math.min(1, score),
    raw: lead,
  };
}
