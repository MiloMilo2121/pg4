import { afterEach, describe, expect, it } from 'vitest';
import { EnvConfigError, getEnv, resetEnvCache } from '../../src/config/env';

const KEYS = ['CONCURRENCY', 'LOG_FORMAT'] as const;
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  resetEnvCache();
});

describe('getEnv validation errors', () => {
  it('lists EVERY invalid variable by name instead of a raw ZodError dump', () => {
    process.env.CONCURRENCY = 'lots';
    process.env.LOG_FORMAT = 'xml';
    resetEnvCache();
    let err: unknown;
    try {
      getEnv();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvConfigError);
    const e = err as EnvConfigError;
    expect(e.issues.map((i) => i.variable).sort()).toEqual(['CONCURRENCY', 'LOG_FORMAT']);
    expect(e.message).toMatch(/Invalid environment configuration/);
    expect(e.message).toMatch(/- CONCURRENCY:/);
  });

  it('a valid environment still parses and is memoized', () => {
    resetEnvCache();
    expect(getEnv()).toBe(getEnv());
  });
});
