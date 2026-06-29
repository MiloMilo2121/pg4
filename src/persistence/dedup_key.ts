import type { Lead } from '../types/lead';
import {
  computePhoneKey,
  computeNameCityKey,
  computeNameAddrKey,
  computeHostKey,
} from '../discovery/deduper';

/**
 * Persistence-layer dedup keys — the SAME logic the in-memory Deduplicator
 * uses (imported, not re-implemented), so the Postgres `UNIQUE(tenant_id,
 * dedup_key)` constraint matches the scraper's dedup behaviour exactly. If
 * these drifted, the DB would split or merge companies differently than the
 * CSV pipeline — the highest-risk persistence bug, so there is one source.
 */

export type DedupKeyType = 'phone' | 'name_city' | 'name_addr' | 'host' | 'pg_url' | 'maps_url';

export interface DedupAlias {
  alias_key: string;
  key_type: DedupKeyType;
}

/**
 * The canonical, deterministic key for the UNIQUE constraint. Priority mirrors
 * Deduplicator.find(): phone → name+city → name+addr → host → pg_url → maps_url.
 * Tagged with the key type so two different key kinds can never collide
 * (e.g. a phone "0491234567" vs a name key that happens to be the same string).
 * Returns undefined only when a lead has no usable identity at all (rare; the
 * caller should reject such a row rather than persist it un-dedupable).
 */
export function computeDedupKey(lead: Lead): string | undefined {
  const phone = computePhoneKey(lead);
  if (phone) return `phone:${phone}`;
  const nameCity = computeNameCityKey(lead);
  if (nameCity) return `name_city:${nameCity}`;
  const nameAddr = computeNameAddrKey(lead);
  if (nameAddr) return `name_addr:${nameAddr}`;
  const host = computeHostKey(lead.website);
  if (host) return `host:${host}`;
  if (lead.pg_url) return `pg_url:${lead.pg_url}`;
  if (lead.maps_url) return `maps_url:${lead.maps_url}`;
  return undefined;
}

/**
 * All secondary keys for this lead → company_dedup_aliases rows, so the
 * find-existing path is a single indexed lookup on ANY matching key (mirrors
 * the Deduplicator's multi-key index). Excludes the canonical key kind only
 * when it would duplicate; here we return every available key and let the
 * caller upsert (alias_key is unique per tenant).
 */
export function computeDedupAliases(lead: Lead): DedupAlias[] {
  const aliases: DedupAlias[] = [];
  const phone = computePhoneKey(lead);
  if (phone) aliases.push({ alias_key: `phone:${phone}`, key_type: 'phone' });
  const nameCity = computeNameCityKey(lead);
  if (nameCity) aliases.push({ alias_key: `name_city:${nameCity}`, key_type: 'name_city' });
  const nameAddr = computeNameAddrKey(lead);
  if (nameAddr) aliases.push({ alias_key: `name_addr:${nameAddr}`, key_type: 'name_addr' });
  const host = computeHostKey(lead.website);
  if (host) aliases.push({ alias_key: `host:${host}`, key_type: 'host' });
  if (lead.pg_url) aliases.push({ alias_key: `pg_url:${lead.pg_url}`, key_type: 'pg_url' });
  if (lead.maps_url) aliases.push({ alias_key: `maps_url:${lead.maps_url}`, key_type: 'maps_url' });
  return aliases;
}
