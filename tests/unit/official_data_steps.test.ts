import { describe, expect, it } from 'vitest';
import type { Lead } from '../../src/types/lead';
import { fetchFatturatoItalia } from '../../src/enrichment/financial/fatturato_italia_fetch';
import { runFieldCascade } from '../../src/enrichment/fields/run_field_cascade';
import { resolveVat, companyNameMatches, sharedNameTokenCount, isWrongEntity } from '../../src/enrichment/fields/field_registry';

/**
 * Phase 3 official-data steps (VIES + fatturatoitalia) — wiring + SAFETY.
 * These tests make NO network call: they exercise the checksum/no-input gates
 * that must short-circuit BEFORE any fetch. (The live behaviour is proven by
 * the e2e browser run + the measurement-evidence probe, not in unit tests.)
 */

const lead = (o: Partial<Lead>): Lead => ({ company_name: 'X', ...o });

describe('fetchFatturatoItalia — checksum gate (no network on bad VAT)', () => {
  it('returns undefined for a non-VAT / bad-checksum input without fetching', async () => {
    expect(await fetchFatturatoItalia('not-a-vat')).toBeUndefined();
    expect(await fetchFatturatoItalia('01234567890')).toBeUndefined(); // 11 digits, bad checksum
    expect(await fetchFatturatoItalia(undefined)).toBeUndefined();
  });
});

describe('A.2 — companyNameMatches (VAT precision via VIES name, REAL name pairs)', () => {
  // The VAT precision fix selects the candidate whose VIES official name matches
  // the company. Pairs below are real-shaped: VIES upper-case + legal form vs the
  // directory name. A match ⇒ the footer VAT is the company's; a mismatch ⇒ it's
  // the accountant's/partner's cited VAT (the ~28% the probe found).
  it('matches the company across legal-form + case (the VAT is the company own)', () => {
    expect(companyNameMatches('AGENZIA IMMOBILIARE ESEMPIO CASE SRL', 'Agenzia Immobiliare Esempio Case')).toBe(true);
    expect(companyNameMatches('IMMOBILIARE METROQUADRO A RESPONSABILITA’ LIMITATA', 'Immobiliare Metroquadro')).toBe(true);
  });
  it('REJECTS a different company (footer cites the accountant/partner VAT)', () => {
    expect(companyNameMatches('STUDIO COMMERCIALE BIANCHI E ASSOCIATI SRL', 'Agenzia Immobiliare Esempio Case')).toBe(false);
    expect(companyNameMatches('WEB AGENCY PIXEL SRL', 'Immobiliare Metroquadro')).toBe(false);
  });
  it('REJECTS a FRANCHISOR vs its local franchisee — shared brand token only (validation-audit bug, 2026-06-14)', () => {
    // The local agency cites the FRANCHISOR's footer VAT; the registry name for that
    // VAT is the franchisor. They share only the brand "tecnocasa". The OLD min-overlap
    // rule scored 0.5 and FALSE-CONFIRMED → €58M franchisor revenue on a local agency.
    expect(companyNameMatches('TECNOCASA FRANCHISING S.P.A.', 'Agenzia Immobiliare Tecnocasa Impresa Albignasego')).toBe(false);
  });
  it('ACCEPTS the owner-suffix pattern via containment (guards against over-rejection)', () => {
    // Italian family firms: the registry name adds the owner ("di <Nome Cognome>").
    // The lead's distinctive tokens are fully contained → still a match (not a foreign VAT).
    expect(companyNameMatches('Immobiliare Giglio di Cecchinato Ornella', 'Immobiliare Giglio')).toBe(true);
    expect(companyNameMatches('Studio Padova Est di Bianchi Luigi', 'Studio Padova Est')).toBe(true);
  });
  it('REJECTS a BARE-BRAND SISTER — short registry name ⊆ fuller lead, 1 shared token (audit 2026-06-16)', () => {
    // A different-city "Metroquadro Srl" {metroquadro} is a subset of "Immobiliare
    // Metroquadro" — the OLD containment rule confirmed it (Jaccard 0.5). Now a single
    // shared token never confirms across distinct entities. The REAL Padova Metroquadro
    // still confirms because its registry name shares 2 tokens (test above).
    expect(companyNameMatches('Metroquadro Srl', 'Immobiliare Metroquadro')).toBe(false);
    expect(companyNameMatches('Rossi Srl', 'Immobiliare Rossi')).toBe(false); // common-surname collision
  });
  it('ACCEPTS a single-word company that IS the whole name on both sides', () => {
    // Blurebus — one distinctive word; registry "BLUREBUS SRL" == lead "Blurebus S.r.l."
    expect(companyNameMatches('BLUREBUS SRL', 'Blurebus S.r.l.')).toBe(true);
  });
  it('handles empty/garbage', () => {
    expect(companyNameMatches(undefined, 'X')).toBe(false);
    expect(companyNameMatches('SRL', 'SRL')).toBe(false); // only the legal form → no real tokens
  });
});

describe('sharedNameTokenCount + isWrongEntity — the three-way (foreign / ambiguous / confirm)', () => {
  it('sharedNameTokenCount distinguishes foreign (0), ambiguous (1), confirm (≥2)', () => {
    expect(sharedNameTokenCount('STUDIO COMMERCIALE BIANCHI SRL', 'Agenzia Immobiliare Esempio Case')).toBe(0); // foreign
    expect(sharedNameTokenCount('TECNOCASA FRANCHISING S.P.A.', 'Agenzia Immobiliare Tecnocasa Impresa Albignasego')).toBe(1); // ambiguous
    expect(sharedNameTokenCount('IMMOBILIARE METROQUADRO A R.L.', 'Immobiliare Metroquadro')).toBe(2); // confirm
  });
  it('isWrongEntity refuses a different entity, allows a match, never blocks when no name', () => {
    expect(isWrongEntity('TECNOCASA FRANCHISING S.P.A.', 'Agenzia Immobiliare Tecnocasa Impresa Albignasego')).toBe(true);
    expect(isWrongEntity('AGENZIA IMMOBILIARE ESEMPIO CASE SRL', 'Agenzia Immobiliare Esempio Case')).toBe(false);
    expect(isWrongEntity(undefined, 'X')).toBe(false); // can't verify → don't block
  });
});

describe('A.1 — resolveVat provenance (site vs unverified input, no network)', () => {
  const VALID = '09999990287'; // checksum-valid
  it('a footer/enriched VAT is provenance=site (trusted)', () => {
    expect(resolveVat({ lead: lead({ vat_code_final: VALID }), paidEnabled: false })).toEqual({ vat: VALID, provenance: 'site' });
    expect(resolveVat({ lead: lead({}), extraction: { vat_candidates: [VALID], phones: [] }, paidEnabled: false }))
      .toEqual({ vat: VALID, provenance: 'site' });
  });
  it('an input-only VAT is provenance=input (must be VIES-gated before trust)', () => {
    expect(resolveVat({ lead: lead({ vat_code: VALID }), paidEnabled: false })).toEqual({ vat: VALID, provenance: 'input' });
  });
  it('site VAT wins over input VAT', () => {
    expect(resolveVat({ lead: lead({ vat_code_final: VALID, vat_code: '12345678903' }), paidEnabled: false }))
      .toMatchObject({ provenance: 'site' });
  });
  it('no checksum-valid VAT anywhere → undefined', () => {
    expect(resolveVat({ lead: lead({ vat_code: '01234567890' }), paidEnabled: false })).toBeUndefined(); // bad checksum
    expect(resolveVat({ lead: lead({}), paidEnabled: false })).toBeUndefined();
  });
});

describe('official-data steps — gate on missing VAT (no network)', () => {
  it('revenue step short-circuits to no_input when no VAT is resolvable', async () => {
    const out = await runFieldCascade(lead({ company_name: 'NoVat' }), 'revenue', {});
    expect(out.resolved).toBe(false);
    const step = out.steps.find((s) => s.id === 'revenue.fatturatoitalia_by_vat')!;
    expect(step.ran).toBe(true);
    expect(step.reason).toBe('no_input');
  });

  it('VAT cascade: vies-confirming resolver wired; no body, no input → no_input, no network', async () => {
    const out = await runFieldCascade(lead({ company_name: 'NoVat' }), 'vat', {});
    expect(out.resolved).toBe(false);
    expect(out.steps.map((s) => s.id)).toEqual(['vat.vies_confirmed']);
    // no candidates → no_input, returned before any VIES network call
    expect(out.steps[0].reason).toBe('no_input');
  });

  it('official-data steps are tier-1 FREE (not paid) and enabled by default', async () => {
    // a revenue enrich with paidEnabled=false still runs the fatturatoitalia step
    const out = await runFieldCascade(lead({ company_name: 'NoVat' }), 'employees', { paidEnabled: false });
    const step = out.steps.find((s) => s.id === 'employees.fatturatoitalia_by_vat')!;
    expect(step.ran).toBe(true); // not paid-gated
    expect(step.tier).toBe(1);
  });
});
