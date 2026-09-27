/**
 * ENRICH-3 — PURE parsers for the real-estate portal actors' dataset items.
 *
 * These marketplace actors (azzouzana~immobiliare-agencies-scraper,
 * saregaa~immobiliareit-scraper, stealth_mode~wikicasa-agency-search-scraper)
 * have never run in this repo, so every key below is a DEFENSIVE candidate:
 * the probe pass (`portali_harvest.ts --probe`) dumps raw items so the
 * operator can confirm the mapping before scaling. Unknown shapes degrade to
 * a mostly-empty record — parsers never throw (an actor schema drift must
 * cost coverage, not crash a paid harvest).
 *
 * Portal URLs themselves are directories (content_filter DIRECTORIES) and
 * must NEVER be attached as a lead's official_website — only the agency's
 * own declared site goes into `website` for the free re-verify to promote.
 */

import { isDirectoryOrSocial } from '../../discovery/website/content_filter';
import { str } from '../../util/values';

export interface PortalAgencyRecord {
  portal: 'immobiliare' | 'immobiliare_ads' | 'wikicasa';
  name?: string;
  phone?: string;
  email?: string;
  /** The agency's OWN declared site (never the portal listing URL). */
  website?: string;
  city?: string;
  province?: string;
  address?: string;
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  listingsCount?: number;
  isPaid?: boolean;
  fiaip?: boolean;
  /** The agency's page ON the portal (kept for audit, never a website). */
  portalUrl?: string;
}


const firstStr = (...vs: unknown[]): string | undefined => {
  for (const v of vs) {
    const s = str(Array.isArray(v) ? v[0] : v);
    if (s) return s;
  }
  return undefined;
};

const num = (...vs: unknown[]): number | undefined => {
  for (const v of vs) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  }
  return undefined;
};

const boolish = (...vs: unknown[]): boolean | undefined => {
  for (const v of vs) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'true' || s === 'yes' || s === 'si' || s === 'sì' || s === '1') return true;
      if (s === 'false' || s === 'no' || s === '0') return false;
    }
  }
  return undefined;
};

const email = (...vs: unknown[]): string | undefined => {
  const s = firstStr(...vs)?.toLowerCase();
  return s && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s) ? s : undefined;
};

const socialUrl = (host: RegExp, ...vs: unknown[]): string | undefined => {
  for (const v of vs) {
    const arr = Array.isArray(v) ? v : [v];
    for (const u of arr) {
      const s = str(u);
      if (s && host.test(s)) return s.split('?')[0];
    }
  }
  return undefined;
};

/**
 * immobiliare.it phones come as objects `{type, value, formattedValues,
 * isVirtual}` where `isVirtual: true` (type `vtel`) is the PORTAL'S tracking
 * number — attaching it would poison the phone-key join, so virtual numbers
 * are excluded outright. Prefers the E.164 formattedValues.
 */
const phoneFromObjects = (v: unknown): string | undefined => {
  if (!Array.isArray(v)) return undefined;
  for (const o of v) {
    if (!o || typeof o !== 'object') continue;
    const rec = o as Record<string, unknown>;
    if (rec.isVirtual === true) continue;
    const p = str(rec.formattedValues) ?? str(rec.value);
    if (p) return p;
  }
  return undefined;
};

/** immobiliare.it `location` object → { city, province } (province is the 2-letter id). */
const fromLocation = (v: unknown): { city?: string; province?: string } => {
  const loc = (v ?? {}) as Record<string, unknown>;
  const city = ((loc.city ?? {}) as Record<string, unknown>).name;
  const province = ((loc.province ?? {}) as Record<string, unknown>).id;
  return { city: str(city), province: str(province) };
};

/**
 * A real external site — never a portal/listing/maps URL echoed back. Judged
 * on the HOSTNAME (exact or parent-domain match against the shared directory
 * list): a substring test threw away real agency sites whose name merely
 * contains a portal's, e.g. `rossiimmobiliare.it` or `miacasa.it`.
 */
const ownWebsite = (...vs: unknown[]): string | undefined => {
  const s = firstStr(...vs);
  if (!s) return undefined;
  const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  return isDirectoryOrSocial(url) ? undefined : url;
};

/** azzouzana~immobiliare-agencies-scraper — email + socials + isPaid/#ads per agency. */
export function parseImmobiliareAgencyItem(raw: unknown): PortalAgencyRecord | undefined {
  const it = (raw ?? {}) as Record<string, unknown>;
  const loc = fromLocation(it.location);
  const rec: PortalAgencyRecord = {
    portal: 'immobiliare',
    name: firstStr(it.name, it.agencyName, it.agency_name, it.title, it.ragioneSociale),
    phone: firstStr(it.phone, it.phoneNumber, it.telefono) ?? phoneFromObjects(it.phones) ?? firstStr(it.phoneNumbers),
    email: email(it.email, it.emails, it.mail),
    website: ownWebsite(it.website, it.site, it.url_sito, it.websiteUrl),
    city: firstStr(it.city, it.citta, it.comune) ?? loc.city,
    province: firstStr(it.province, it.provincia) ?? loc.province,
    address: firstStr(it.address, it.indirizzo, it.fullAddress),
    instagram: socialUrl(/instagram\.com/i, it.instagram, it.socials, it.socialLinks),
    facebook: socialUrl(/facebook\.com/i, it.facebook, it.socials, it.socialLinks),
    linkedin: socialUrl(/linkedin\.com/i, it.linkedin, it.socials, it.socialLinks),
    listingsCount: num(it.realEstateAds, it.listingsCount, it.totalAds, it.numAnnunci, it.adsCount, it.properties),
    isPaid: boolish(it.isPaid, it.is_paid, it.premium, it.isPremium),
    portalUrl: firstStr(it.agencyUrl, it.portalUrl, it.url, it.link),
  };
  return rec.name || rec.phone || rec.email ? rec : undefined;
}

/** saregaa~immobiliareit-scraper — listing counts / isPaid / FIAIP (no emails). */
export function parseImmobiliareAdsItem(raw: unknown): PortalAgencyRecord | undefined {
  const it = (raw ?? {}) as Record<string, unknown>;
  const rec: PortalAgencyRecord = {
    portal: 'immobiliare_ads',
    name: firstStr(it.name, it.agencyName, it.agency_name, it.title),
    phone: firstStr(it.phone, it.phoneNumber, it.telefono, it.phones),
    city: firstStr(it.city, it.citta, it.comune, it.location),
    province: firstStr(it.province, it.provincia),
    address: firstStr(it.address, it.indirizzo),
    listingsCount: num(it.listingsCount, it.totalAds, it.numAnnunci, it.adsCount, it.activeListings, it.properties),
    isPaid: boolish(it.isPaid, it.is_paid, it.premium, it.isPremium),
    fiaip: boolish(it.fiaip, it.isFiaip, it.FIAIP),
    portalUrl: firstStr(it.agencyUrl, it.portalUrl, it.url, it.link),
  };
  return rec.name || rec.phone ? rec : undefined;
}

/**
 * stealth_mode~wikicasa-agency-search-scraper — website + premium/#ads.
 * Real shape (probe R1): `company_name` (legal name), `name`, `city_name`,
 * `website`, `active_real_estates`, `premium`, and NO usable phone —
 * `hidden_display_phone` is TRUNCATED (e.g. "041531") and `io_vox_phone` is
 * the portal's tracking line, so wikicasa records join by name+city only
 * (a truncated phone would forge wrong phone keys).
 */
export function parseWikicasaItem(raw: unknown): PortalAgencyRecord | undefined {
  const it = (raw ?? {}) as Record<string, unknown>;
  const rec: PortalAgencyRecord = {
    portal: 'wikicasa',
    name: firstStr(it.company_name, it.name, it.agencyName, it.agency_name, it.title),
    email: email(it.email, it.emails),
    website: ownWebsite(it.website, it.site, it.websiteUrl, it.web),
    city: firstStr(it.city_name, it.city, it.citta, it.comune),
    province: firstStr(it.province, it.provincia),
    address: firstStr(it.address, it.indirizzo),
    listingsCount: num(it.active_real_estates, it.visible_real_estates, it.listingsCount),
    isPaid: boolish(it.premium, it.isPaid),
    portalUrl: firstStr(it.agencyUrl, it.portalUrl, it.url, it.link, it.from_url),
  };
  return rec.name || rec.website ? rec : undefined;
}

export function parsePortalItem(portal: PortalAgencyRecord['portal'], raw: unknown): PortalAgencyRecord | undefined {
  switch (portal) {
    case 'immobiliare':
      return parseImmobiliareAgencyItem(raw);
    case 'immobiliare_ads':
      return parseImmobiliareAdsItem(raw);
    case 'wikicasa':
      return parseWikicasaItem(raw);
  }
}
