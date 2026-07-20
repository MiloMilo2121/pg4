import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApifyProvider, type ApifyHttpPost } from '../../src/providers/apify/apify_provider';
import { resetEnvCache } from '../../src/config/env';

const ALL_KEYS = [
  'APIFY_ENABLED',
  'APIFY_API_KEY',
  'APIFY_PORTAL_IMMOBILIARE_ENABLED',
  'APIFY_PORTAL_IMMOBILIARE_ADS_ENABLED',
  'APIFY_PORTAL_WIKICASA_ENABLED',
  'APIFY_BILANCI_ENABLED',
  'APIFY_BILANCI_ACTOR_ID',
  'APIFY_EMAIL_VERIFY_ENABLED',
  'APIFY_EMAIL_VERIFY_ACTOR_ID',
];
function clearEnv(): void {
  for (const k of ALL_KEYS) delete process.env[k];
  resetEnvCache();
}
function baseEnable(): void {
  process.env.APIFY_ENABLED = 'true';
  process.env.APIFY_API_KEY = 'tok';
  resetEnvCache();
}
beforeEach(clearEnv);
afterEach(clearEnv);

describe('ENRICH-3 Apify actors', () => {
  it('every new actor is OFF by default and carries its cost estimate', () => {
    baseEnable();
    const p = new ApifyProvider();
    expect(p.actorAvailable('portal_immobiliare')).toBe(false);
    expect(p.actorAvailable('portal_immobiliare_ads')).toBe(false);
    expect(p.actorAvailable('portal_wikicasa')).toBe(false);
    expect(p.actorAvailable('bilanci')).toBe(false);
    expect(p.actorAvailable('email_verify')).toBe(false);
    expect(p.meta('portal_immobiliare').costPerCallEur).toBeCloseTo(0.002);
    expect(p.meta('portal_immobiliare_ads').costPerCallEur).toBeCloseTo(0.0007);
    expect(p.meta('portal_wikicasa').costPerCallEur).toBeCloseTo(0.002);
    expect(p.meta('bilanci').costPerCallEur).toBeCloseTo(0.008);
    expect(p.meta('email_verify').costPerCallEur).toBeCloseTo(0.001);
  });

  it('per-actor flags enable each actor independently', () => {
    baseEnable();
    process.env.APIFY_PORTAL_IMMOBILIARE_ENABLED = 'true';
    resetEnvCache();
    const p = new ApifyProvider();
    expect(p.actorAvailable('portal_immobiliare')).toBe(true);
    expect(p.actorAvailable('portal_wikicasa')).toBe(false);
  });

  it('email_verify stays unavailable without a pinned ACTOR_ID (no default id)', () => {
    baseEnable();
    process.env.APIFY_EMAIL_VERIFY_ENABLED = 'true';
    resetEnvCache();
    const p = new ApifyProvider();
    expect(p.actorAvailable('email_verify')).toBe(false);
    process.env.APIFY_EMAIL_VERIFY_ACTOR_ID = 'acme~email-verifier';
    resetEnvCache();
    expect(p.actorAvailable('email_verify')).toBe(true);
  });

  it('APIFY_*_ACTOR_ID overrides the marketplace id in the call URL', async () => {
    baseEnable();
    process.env.APIFY_BILANCI_ACTOR_ID = 'forked~bilanci-pinned';
    resetEnvCache();
    const urls: string[] = [];
    const post: ApifyHttpPost = async (url) => {
      urls.push(url);
      return { status: 200, json: [] };
    };
    const p = new ApifyProvider(post);
    await p.runActorSync('bilanci', {}, { maxItems: 1 });
    expect(urls[0]).toContain('/acts/forked~bilanci-pinned/');
  });

  it('default bilanci id is the jungle_synthesizer actor', async () => {
    baseEnable();
    const urls: string[] = [];
    const post: ApifyHttpPost = async (url) => {
      urls.push(url);
      return { status: 200, json: [] };
    };
    const p = new ApifyProvider(post);
    await p.runActorSync('bilanci', {}, { maxItems: 1 });
    expect(urls[0]).toContain('jungle_synthesizer~italy-registroimprese-bilanci-scraper');
  });
});
