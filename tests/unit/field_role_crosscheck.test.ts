import { describe, expect, it } from 'vitest';
import { FIELD_BY_NAME, pickBestEmail } from '../../src/enrichment/fields/field_registry';
import { roleEntry } from '../../src/providers/role_registry';

describe('field cascade ↔ role registry cross-check (AC8)', () => {
  it('every field role tag is a real role in the registry', () => {
    for (const d of FIELD_BY_NAME.values()) {
      if (d.role) expect(roleEntry(d.role), `field ${d.field} → role ${d.role}`).toBeDefined();
    }
  });

  it('the email field is tagged EMAIL_FIND and its cascade wires the real Hunter step (shipped disabled)', () => {
    const email = FIELD_BY_NAME.get('email');
    expect(email?.role).toBe('EMAIL_FIND');
    const hunterStep = email?.cascade.find((s) => s.id === 'email.hunter');
    expect(hunterStep).toBeDefined();
    expect(hunterStep?.tier).toBe(2);
    expect(hunterStep?.costEur).toBe(0.04);
    expect(hunterStep?.enabled).toBe(false); // default run stays €0
    // the dead 'email.finder_api' placeholder is gone
    expect(email?.cascade.some((s) => s.id === 'email.finder_api')).toBe(false);
  });

  it('official-data fields (pec/revenue/employees) carry OFFICIAL_COMPANY_DATA', () => {
    for (const f of ['pec', 'revenue', 'employees']) {
      expect(FIELD_BY_NAME.get(f)?.role).toBe('OFFICIAL_COMPANY_DATA');
    }
  });
});

describe('pickBestEmail', () => {
  it('prefers a generic/role inbox', () => {
    const best = pickBestEmail([
      { value: 'mario.rossi@acme.it', confidence: 95 },
      { value: 'info@acme.it', confidence: 70 },
    ]);
    expect(best?.value).toBe('info@acme.it');
  });
  it('falls back to the highest-confidence address', () => {
    const best = pickBestEmail([
      { value: 'a@acme.it', confidence: 40 },
      { value: 'b@acme.it', confidence: 88 },
    ]);
    expect(best?.value).toBe('b@acme.it');
  });
  it('returns undefined for an empty list', () => {
    expect(pickBestEmail([])).toBeUndefined();
  });
});
