import fs from 'fs';
import path from 'path';
import type { Lead } from '../types/lead';
import { InMemoryTenantDb } from '../persistence/in_memory_tenant_db';
import { detectDeadProviders } from '../runtime/provider_health';
import type { DeadProvider } from '../runtime/provider_health';

/**
 * Dev seed — loads REAL free-gold output into a single-tenant in-memory store.
 *
 * Honest by construction: the default seed (r12) was enriched BEFORE the Phase-1
 * free-gold extractor existed, so it carries website + phone but email / pec /
 * vat / social are EMPTY. That is the genuine "before" state — the dashboard's
 * enrich-field action then runs free-gold LIVE on the real sites and fills those
 * cells, demonstrating the platform's core value on real data in real time.
 */

export const DEV_TENANT_ID = '00000000-0000-0000-0000-0000000000a1'; // Marco's fixed dev tenant

export interface SeedResult {
  db: InMemoryTenantDb;
  loaded: number;
  rejected: number;
  providerDead: DeadProvider[];
  ledgerTotalEur: number;
  sourceFile: string;
}

const DEFAULT_SEED = 'output/r12_maps_pd_province_full_enriched_free.jsonl';

export async function loadSeed(repoRoot: string, seedFile: string = DEFAULT_SEED): Promise<SeedResult> {
  const abs = path.isAbsolute(seedFile) ? seedFile : path.join(repoRoot, seedFile);
  const db = new InMemoryTenantDb();
  let loaded = 0;
  let rejected = 0;

  if (fs.existsSync(abs)) {
    const lines = fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let lead: Lead;
      try {
        lead = JSON.parse(line) as Lead;
      } catch {
        rejected += 1;
        continue;
      }
      try {
        await db.upsertCompany(DEV_TENANT_ID, lead); // throws on un-dedupable rows
        loaded += 1;
      } catch {
        rejected += 1;
      }
    }
  }

  // Provider health from the seed run's real cost ledger (if present).
  let providerDead: DeadProvider[] = [];
  let ledgerTotalEur = 0;
  const ledgerPath = abs.replace(/\.jsonl$/, '.cost-ledger.jsonl');
  if (fs.existsSync(ledgerPath)) {
    const byProvider: Record<string, { calls: number; cost_eur: number; success_rate: number; by_kind: Record<string, number> }> = {};
    for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)) {
      let e: { provider?: string; cost_eur?: number; success?: boolean; kind?: string };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e.provider || e.kind === 'summary') continue;
      const a = (byProvider[e.provider] ??= { calls: 0, cost_eur: 0, success_rate: 0, by_kind: {} });
      a.calls += 1;
      a.cost_eur += e.cost_eur ?? 0;
      ledgerTotalEur += e.cost_eur ?? 0;
      const k = e.kind ?? (e.success ? 'success' : 'other');
      a.by_kind[k] = (a.by_kind[k] ?? 0) + 1;
      if (e.success) a.success_rate += 1;
    }
    for (const v of Object.values(byProvider)) v.success_rate = v.calls ? v.success_rate / v.calls : 0;
    providerDead = detectDeadProviders(byProvider);
  }

  return { db, loaded, rejected, providerDead, ledgerTotalEur, sourceFile: seedFile };
}
