import fs from 'fs';
import path from 'path';
import { parseArgs, optString } from '../../cli/_args';
import type { Lead } from '../../types/lead';
import { computePhoneKey, computeNameCityKey, normalizeForKey } from '../../discovery/deduper';
import { companyNameMatches, isWrongEntity } from '../../enrichment/fields/field_registry';
import { parsePortalItem, type PortalAgencyRecord } from '../../providers/apify/portal_parsers';
import { CsvWriter } from '../../io/csv_writer';
import { loadState, saveState, fillOnlyEmpty, has, runIfMain } from './_shared';

/**
 * ENRICH-3 R1b — OFFLINE join (€0) of the harvested portal records onto the
 * lead state. Precision-first matching ladder:
 *
 *   1. phone key (`computePhoneKey`, the repo's dedup single-source):
 *      unique hit → attach unless `isWrongEntity`; multiple hits → attach
 *      ONLY when exactly one lead passes `companyNameMatches`, else skip+log
 *      (franchising / shared numbers must not cross-pollinate).
 *   2. exact name+city key (`computeNameCityKey`).
 *   3. fuzzy: same normalized city bucket + `companyNameMatches`, unique only.
 *
 * Attach is fill-only-empty. The portal's own phone is NEVER attached
 * (portals often print tracking numbers). Declared websites land in
 * `website` (input channel) — never `official_website`; the free
 * `reverify_websites` pass promotes them through the existing gate.
 * Unmatched records with a name+phone become the new-leads sidecar
 * (raw flavor), never merged into the v3.
 */

const FREEMAIL = /@(gmail|libero|yahoo|hotmail|outlook|tiscali|virgilio|alice|tim|live|icloud|msn|aol|email|inwind|iol)\./i;
/**
 * PEC-looking addresses (measured in the probe: portals often list ONLY the
 * PEC, e.g. @lamiapec.it). Per the user's decision PEC is not an outreach
 * channel → routed to the `pec` field, never to `email_inferred`.
 */
const PECISH = /@(?:[a-z0-9.-]*pec[a-z0-9.-]*\.|legalmail\.|postecert\.|postacert\.|cert\.|legpec\.|sicurezzapostale\.|twtcert\.)/i;

export interface JoinStats {
  records: number;
  perPortal: Record<string, number>;
  matched: number;
  matchedBy: Record<'phone' | 'phone_disambiguated' | 'name_city' | 'fuzzy', number>;
  ambiguousPhone: number;
  ambiguousFuzzy: number;
  entityMismatch: number;
  unmatched: number;
  sidecar: number;
  fills: Record<string, number>;
  leadsTouched: number;
}

function phoneKeyOf(phone: string | undefined): string | undefined {
  return phone ? computePhoneKey({ company_name: '', phone }) : undefined;
}

function nameCityKeyOf(name: string | undefined, city: string | undefined): string | undefined {
  return name ? computeNameCityKey({ company_name: name, city }) : undefined;
}

export function emptyJoinStats(): JoinStats {
  return {
    records: 0,
    perPortal: {},
    matched: 0,
    matchedBy: { phone: 0, phone_disambiguated: 0, name_city: 0, fuzzy: 0 },
    ambiguousPhone: 0,
    ambiguousFuzzy: 0,
    entityMismatch: 0,
    unmatched: 0,
    sidecar: 0,
    fills: {},
    leadsTouched: 0,
  };
}

export function pickTarget(
  rec: PortalAgencyRecord,
  byPhone: Map<string, Lead[]>,
  byNameCity: Map<string, Lead[]>,
  byCity: Map<string, Lead[]>,
  stats: JoinStats,
): { lead: Lead; how: keyof JoinStats['matchedBy'] } | undefined {
  const pk = phoneKeyOf(rec.phone);
  if (pk) {
    const hits = byPhone.get(pk) ?? [];
    if (hits.length === 1) {
      if (rec.name && isWrongEntity(rec.name, hits[0].company_name)) {
        stats.entityMismatch += 1;
        return undefined;
      }
      return { lead: hits[0], how: 'phone' };
    }
    if (hits.length > 1) {
      const named = rec.name ? hits.filter((l) => companyNameMatches(rec.name, l.company_name)) : [];
      if (named.length === 1) return { lead: named[0], how: 'phone_disambiguated' };
      stats.ambiguousPhone += 1;
      return undefined;
    }
  }
  const nck = nameCityKeyOf(rec.name, rec.city);
  if (nck) {
    const hits = byNameCity.get(nck) ?? [];
    if (hits.length === 1) return { lead: hits[0], how: 'name_city' };
  }
  if (rec.name && rec.city) {
    const bucket = byCity.get(normalizeForKey(rec.city)) ?? [];
    const named = bucket.filter((l) => companyNameMatches(rec.name, l.company_name));
    if (named.length === 1) return { lead: named[0], how: 'fuzzy' };
    if (named.length > 1) stats.ambiguousFuzzy += 1;
  }
  return undefined;
}

export function attach(rec: PortalAgencyRecord, lead: Lead, stats: JoinStats): boolean {
  const patch: Partial<Record<keyof Lead, unknown>> = {
    instagram: rec.instagram,
    facebook: rec.facebook,
    linkedin: rec.linkedin,
    portal_listings_count: rec.listingsCount !== undefined ? String(rec.listingsCount) : undefined,
    portal_is_paid: rec.isPaid !== undefined ? String(rec.isPaid) : undefined,
    portal_fiaip: rec.fiaip !== undefined ? String(rec.fiaip) : undefined,
  };
  // email → email_inferred (+type) — but a PEC-looking address goes to the
  // `pec` field (legal channel, excluded from outreach by user decision).
  if (rec.email && PECISH.test(rec.email)) {
    patch.pec = rec.email;
  } else if (rec.email && !has(lead.email_inferred)) {
    patch.email_inferred = rec.email;
    if (!has(lead.email_type)) patch.email_type = FREEMAIL.test(rec.email) ? 'public' : 'business';
  }
  // declared website → the INPUT channel only, and only when the lead has
  // neither an input site nor a verified one (the reverify pass promotes it).
  if (rec.website && !has(lead.website) && !has(lead.official_website)) {
    patch.website = rec.website;
  }
  const filled = fillOnlyEmpty(lead, patch);
  for (const f of filled) stats.fills[f] = (stats.fills[f] ?? 0) + 1;
  if (filled.length > 0) {
    const src = new Set(String(lead.portal_source ?? '').split(';').filter(Boolean));
    src.add(rec.portal);
    lead.portal_source = [...src].sort().join(';');
  }
  return filled.length > 0;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const statePath = optString(args, 'state') ?? 'output/enrich3/state0.jsonl';
  const out = optString(args, 'out') ?? 'output/enrich3/state1';
  const rawDir = optString(args, 'raw-dir') ?? 'output/enrich3/portali/raw';
  const reportPath = optString(args, 'report') ?? 'output/enrich3/portali/join_report.json';
  const sidecarPath = optString(args, 'sidecar') ?? 'output/enrich3/portali/new_leads_sidecar.csv';

  const leads = await loadState(statePath);

  // ---- indexes over the lead state ----
  const byPhone = new Map<string, Lead[]>();
  const byNameCity = new Map<string, Lead[]>();
  const byCity = new Map<string, Lead[]>();
  for (const lead of leads) {
    const pk = computePhoneKey(lead);
    if (pk) (byPhone.get(pk) ?? byPhone.set(pk, []).get(pk)!).push(lead);
    const nck = computeNameCityKey(lead);
    if (nck) (byNameCity.get(nck) ?? byNameCity.set(nck, []).get(nck)!).push(lead);
    const c = lead.city ? normalizeForKey(String(lead.city)) : '';
    if (c) (byCity.get(c) ?? byCity.set(c, []).get(c)!).push(lead);
  }

  // ---- load + parse + intra-portal dedup of the harvested records ----
  const stats: JoinStats = emptyJoinStats();
  const records: PortalAgencyRecord[] = [];
  const seen = new Set<string>();
  const files = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.jsonl') && !f.includes('_probe')) : [];
  if (files.length === 0) throw new Error(`no raw portal files in ${rawDir} — run portali_harvest first`);
  for (const file of files) {
    const portal = file.startsWith('portal_immobiliare_ads') ? 'immobiliare_ads' : file.startsWith('portal_immobiliare') ? 'immobiliare' : 'wikicasa';
    const lines = fs.readFileSync(path.join(rawDir, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = parsePortalItem(portal, raw);
      if (!rec) continue;
      const key = `${rec.portal}|${phoneKeyOf(rec.phone) ?? nameCityKeyOf(rec.name, rec.city) ?? rec.portalUrl ?? Math.random()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(rec);
      stats.records += 1;
      stats.perPortal[rec.portal] = (stats.perPortal[rec.portal] ?? 0) + 1;
    }
  }

  // ---- join ----
  const touched = new Set<Lead>();
  const unmatchedRecs: PortalAgencyRecord[] = [];
  for (const rec of records) {
    const target = pickTarget(rec, byPhone, byNameCity, byCity, stats);
    if (!target) {
      stats.unmatched += 1;
      unmatchedRecs.push(rec);
      continue;
    }
    stats.matched += 1;
    stats.matchedBy[target.how] += 1;
    if (attach(rec, target.lead, stats)) touched.add(target.lead);
  }
  stats.leadsTouched = touched.size;

  // ---- sidecar: portal agencies we don't have (name + phone required) ----
  const sidecarSeen = new Set<string>();
  const sidecar = new CsvWriter(sidecarPath, 'raw');
  for (const rec of unmatchedRecs) {
    if (!rec.name || !rec.phone) continue;
    const key = phoneKeyOf(rec.phone) ?? nameCityKeyOf(rec.name, rec.city);
    if (!key || sidecarSeen.has(key)) continue;
    sidecarSeen.add(key);
    await sidecar.write({
      company_name: rec.name,
      category: 'agenzie immobiliari',
      city: rec.city,
      province: rec.province,
      address: rec.address,
      phone: rec.phone,
      website: rec.website,
      source: `PORTAL_${rec.portal.toUpperCase()}`,
      source_url: rec.portalUrl,
    });
    stats.sidecar += 1;
  }
  await sidecar.close();

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(stats, null, 2));
  await saveState(leads, out);

  const pct = (n: number): string => `${((100 * n) / Math.max(1, stats.records)).toFixed(1)}%`;
  console.log(
    `portali_join: ${stats.records} record → matched ${stats.matched} (${pct(stats.matched)}; ` +
      `phone ${stats.matchedBy.phone}+${stats.matchedBy.phone_disambiguated}, name_city ${stats.matchedBy.name_city}, fuzzy ${stats.matchedBy.fuzzy}) · ` +
      `ambigui ${stats.ambiguousPhone + stats.ambiguousFuzzy} (${pct(stats.ambiguousPhone + stats.ambiguousFuzzy)}) · ` +
      `entity_mismatch ${stats.entityMismatch} · sidecar ${stats.sidecar} · leads touched ${stats.leadsTouched}`,
  );
  console.log(`fills: ${JSON.stringify(stats.fills)}`);
  console.log(`report: ${reportPath}`);
}

runIfMain('portali_join.ts', main);
