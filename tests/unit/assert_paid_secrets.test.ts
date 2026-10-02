import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertPaidSecrets, resetEnvCache } from '../../src/config/env';

/**
 * Paid-secret assertion. A run that asked for --enable-paid
 * must fail FAST and LOUD when no paid provider is actually usable,
 * naming the missing variable, instead of silently completing free-only.
 */

const VARS = [
  'SERPER_ENABLED', 'SERPER_API_KEY',
  'EXA_ENABLED', 'EXA_API_KEY',
  'TAVILY_ENABLED', 'TAVILY_API_KEY',
  'BRIGHTDATA_ENABLED', 'BRIGHTDATA_API_KEY',
  'SNOV_ENABLED', 'SNOV_CLIENT_SECRET',
  'TWOCAPTCHA_ENABLED', 'TWOCAPTCHA_API_KEY',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  resetEnvCache();
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  resetEnvCache();
});

describe('assertPaidSecrets', () => {
  it('throws naming the enable flag when NO paid provider is enabled', () => {
    expect(() => assertPaidSecrets()).toThrow(/no paid provider is enabled.*SERPER_ENABLED/s);
  });

  it('throws naming the missing key when a provider is enabled without a key', () => {
    process.env.SERPER_ENABLED = 'true';
    resetEnvCache();
    expect(() => assertPaidSecrets()).toThrow(/SERPER_API_KEY is empty/);
  });

  // Snov and 2Captcha have env vars but no provider under src/providers: with only
  // them configured, --enable-paid would pass and the run would still be free-only.
  it('does not count Snov (configured but not implemented)', () => {
    process.env.SNOV_ENABLED = 'true';
    process.env.SNOV_CLIENT_SECRET = 's-test-not-a-real-secret';
    resetEnvCache();
    expect(() => assertPaidSecrets()).toThrow(/no paid provider is enabled/);
  });

  it('does not count 2Captcha (configured but not implemented)', () => {
    process.env.TWOCAPTCHA_ENABLED = 'true';
    process.env.TWOCAPTCHA_API_KEY = 'k-test-not-a-real-key';
    resetEnvCache();
    expect(() => assertPaidSecrets()).toThrow(/no paid provider is enabled/);
  });

  it('passes when at least one paid provider has flag + key', () => {
    process.env.SERPER_ENABLED = 'true';
    process.env.SERPER_API_KEY = 'k-test-not-a-real-key';
    resetEnvCache();
    expect(() => assertPaidSecrets()).not.toThrow();
  });
});
