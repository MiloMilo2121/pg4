import { describe, it, expect } from 'vitest';
import { classifyError } from '../../src/runtime/errors';
import { ReasonCode } from '../../src/types/output';

describe('classifyError', () => {
  it('maps timeout', () => {
    expect(classifyError(new Error('Request timeout'))).toBe(ReasonCode.ERROR_TIMEOUT_FETCH);
    expect(classifyError(new Error('ETIMEDOUT'))).toBe(ReasonCode.ERROR_TIMEOUT_FETCH);
  });
  it('maps 403/blocked', () => {
    expect(classifyError(new Error('HTTP 403 Forbidden'))).toBe(ReasonCode.ERROR_BLOCKED_403);
    expect(classifyError(new Error('captcha required'))).toBe(ReasonCode.ERROR_BLOCKED_403);
  });
  it('maps DNS failure', () => {
    expect(classifyError(new Error('getaddrinfo ENOTFOUND example.it'))).toBe(ReasonCode.ERROR_DNS);
  });
  it('maps rate limit', () => {
    expect(classifyError(new Error('HTTP 429 too many requests'))).toBe(ReasonCode.ERROR_PROVIDER_RATE_LIMIT);
  });
  it('falls back to ERROR_INTERNAL', () => {
    expect(classifyError(new Error('something weird'))).toBe(ReasonCode.ERROR_INTERNAL);
  });
});
