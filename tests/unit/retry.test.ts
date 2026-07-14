import { describe, it, expect, vi } from 'vitest';
import { withRetry, isRetriableNavError } from '../../src/runtime/retry';

describe('isRetriableNavError', () => {
  it('riconosce le cadute di rete viste in produzione', () => {
    expect(isRetriableNavError(new Error('page.goto: net::ERR_INTERNET_DISCONNECTED at https://…'))).toBe(true);
    expect(isRetriableNavError(new Error('net::ERR_NETWORK_CHANGED'))).toBe(true);
    expect(isRetriableNavError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe(true);
    expect(isRetriableNavError(new Error('Timeout 32000ms exceeded'))).toBe(true);
    expect(isRetriableNavError(new Error('ECONNRESET'))).toBe(true);
  });
  it('NON ritenta errori non di rete (bug logici, selettori)', () => {
    expect(isRetriableNavError(new Error('selector ".x" not found'))).toBe(false);
    expect(isRetriableNavError(new Error('TypeError: undefined is not a function'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('riprova un errore di rete transitorio e poi riesce', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const out = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('net::ERR_INTERNET_DISCONNECTED');
        return 'ok';
      },
      { baseBackoffMs: 0, onRetry }, // baseBackoffMs 0 → nessuna attesa reale nei test
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('propaga subito un errore NON ritentabile (nessun retry)', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls += 1; throw new Error('selector missing'); }, { baseBackoffMs: 0 }),
    ).rejects.toThrow('selector missing');
    expect(calls).toBe(1);
  });

  it('si arrende dopo `retries` tentativi e rilancia l\'ultimo errore', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls += 1; throw new Error('net::ERR_TIMED_OUT'); }, { retries: 2, baseBackoffMs: 0 }),
    ).rejects.toThrow('net::ERR_TIMED_OUT');
    expect(calls).toBe(3); // 1 + 2 retry
  });

  it('rispetta l\'abortSignal (non ritenta se abortito)', async () => {
    const ac = new AbortController();
    let calls = 0;
    const p = withRetry(
      async () => { calls += 1; ac.abort(); throw new Error('net::ERR_NETWORK_CHANGED'); },
      { retries: 5, baseBackoffMs: 0, abortSignal: ac.signal },
    );
    await expect(p).rejects.toThrow();
    expect(calls).toBe(1); // abortito dopo il primo tentativo → nessun retry
  });
});
