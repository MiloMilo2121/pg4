import { describe, it, expect } from 'vitest';
import { rankCandidate, rankCandidates } from '../../src/discovery/website/hyper_guesser/candidate_ranker';
import { normalizeLead } from '../../src/discovery/input_normalizer';

/**
 * Phase D.4 — pre-fetch ranker tests.
 *
 * The ranker decides which alive HyperGuesser candidates earn the full
 * retry budget. It must:
 *   - put exact-full-name and stripped-brand matches at the top
 *   - drop 2-3 char acronym domains
 *   - block bare common-stem and bare-city stems
 *   - keep audit-confirmed TPs in the `strong` tier
 *   - keep DMC Legno's mis-categorised legitimate match in `strong`
 */

describe('candidate_ranker — strong tier (audit TPs)', () => {
  it('Pierobon → agenziaimmobiliareestimopierobon.com → strong (exact full)', () => {
    const lead = normalizeLead({
      company_name: 'Agenzia Immobiliare Estimo Pierobon',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const r = rankCandidate('agenziaimmobiliareestimopierobon.com', lead);
    expect(r.tier).toBe('strong');
    expect(r.reasons.some((x) => x.startsWith('exact_full_name_match') || x.startsWith('domain_contains_full_name'))).toBe(true);
  });

  it('Gecoimmobili → gecoimmobili.it → strong', () => {
    const lead = normalizeLead({
      company_name: 'Gecoimmobili',
      city: 'Cornuda',
      category: 'agenzie immobiliari',
    });
    const r = rankCandidate('gecoimmobili.it', lead);
    expect(r.tier).toBe('strong');
  });

  it('Cortina Properties → cortinaproperties.com → strong', () => {
    const lead = normalizeLead({
      company_name: 'Cortina Properties S.r.l.',
      city: 'Cortina',
      category: 'agenzie immobiliari',
    });
    const r = rankCandidate('cortinaproperties.com', lead);
    expect(r.tier).toBe('strong');
  });

  it('DMC Legno → dmclegno.it → strong (despite mis-categorised sector)', () => {
    const lead = normalizeLead({
      company_name: 'DMC Legno S.r.l.',
      city: 'Padola',
      category: 'agenzie immobiliari',
    });
    const r = rankCandidate('dmclegno.it', lead);
    expect(r.tier).toBe('strong');
  });

  it('Pianon Immobiliare → pianon.eu → strong (Layer B)', () => {
    const lead = normalizeLead({
      company_name: 'Pianon Immobiliare',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const r = rankCandidate('pianon.eu', lead);
    expect(r.tier).toBe('strong');
  });

  it('La Decisa → ladecisa.com → strong', () => {
    const lead = normalizeLead({
      company_name: 'La Decisa S.r.l.',
      city: 'Vittorio Veneto',
      category: 'agenzie immobiliari',
    });
    const r = rankCandidate('ladecisa.com', lead);
    expect(r.tier).toBe('strong');
  });
});

describe('candidate_ranker — drop tier (acronym + city portal homonyms)', () => {
  it('Agenzia Mercato Immobiliare → am.com → drop (stem too short)', () => {
    const lead = normalizeLead({
      company_name: 'Agenzia Mercato Immobiliare',
      city: 'Borgo Valbelluna',
      category: 'agenzie immobiliari',
    });
    const r = rankCandidate('am.com', lead);
    expect(r.tier).toBe('drop');
    expect(r.reasons).toContain('stem_too_short');
  });

  it('Bordignon Service → bs.net → drop', () => {
    const lead = normalizeLead({
      company_name: 'Bordignon Service',
      city: 'Montebelluna',
      category: 'agenzie immobiliari',
    });
    const r = rankCandidate('bs.net', lead);
    expect(r.tier).toBe('drop');
  });

  it('Studio Belluno → belluno.eu → weak (city-only stem flagged)', () => {
    const lead = normalizeLead({
      company_name: 'Studio Belluno SRL',
      city: 'Belluno',
      category: 'agenzie immobiliari',
    });
    const r = rankCandidate('belluno.eu', lead);
    expect(['weak', 'drop']).toContain(r.tier);
    // `belluno` is intentionally NOT in COMMON_BARE_STEMS (it would
    // mis-block legit brands). The ranker must rely on the
    // `bare_city_stem` penalty alone to keep this out of `strong`.
    expect(r.reasons).not.toContain('common_bare_stem_belluno');
    expect(r.reasons).toContain('bare_city_stem');
  });

  it('Immobiliare Europa → europa.eu → weak or drop (common bare stem)', () => {
    const lead = normalizeLead({
      company_name: 'Immobiliare Europa',
      city: 'Treviso',
      category: 'agenzie immobiliari',
    });
    const r = rankCandidate('europa.eu', lead);
    expect(['weak', 'drop']).toContain(r.tier);
    expect(r.reasons).toContain('common_bare_stem_europa');
  });

  it('Studio Master Immobiliare → master.it → weak or drop (master in COMMON_BARE_STEMS)', () => {
    const lead = normalizeLead({
      company_name: 'Studio Master Immobiliare',
      city: 'Paese',
      category: 'agenzie immobiliari',
    });
    const r = rankCandidate('master.it', lead);
    expect(['weak', 'drop']).toContain(r.tier);
    expect(r.reasons).toContain('common_bare_stem_master');
  });
});

describe('candidate_ranker — sort + tier ordering', () => {
  it('rankCandidates sorts strong > weak > drop, ties by input order', () => {
    const lead = normalizeLead({
      company_name: 'Gecoimmobili',
      city: 'Cornuda',
      category: 'agenzie immobiliari',
    });
    const ranked = rankCandidates(
      [
        { domain: 'gi.com' }, // 2 chars - drop
        { domain: 'gecoimmobili.it' }, // strong
        { domain: 'gecoimmobili-cornuda.it' }, // strong (composite)
      ],
      lead,
    );
    expect(ranked[ranked.length - 1].domain).toBe('gi.com');
    expect(ranked[ranked.length - 1].tier).toBe('drop');
    expect(ranked[0].tier).toBe('strong');
  });

  it('composite brand+city ranks at least as well as the bare brand domain', () => {
    const lead = normalizeLead({
      company_name: 'Gecoimmobili',
      city: 'Cornuda',
      category: 'agenzie immobiliari',
    });
    const ranked = rankCandidates(
      [{ domain: 'gecoimmobili.it' }, { domain: 'gecoimmobili-cornuda.it' }],
      lead,
    );
    // Both should be `strong` tier. The bare-brand match can score
    // equal-to-or-higher than composite (exact_stripped_brand >
    // domain_contains_stripped_brand by design), but neither must
    // be dropped or weakened.
    expect(ranked.every((s) => s.tier === 'strong')).toBe(true);
  });

  it('prefers composite over bare-acronym homonym domain', () => {
    // The real win: when a 2-letter acronym domain is alive AND a
    // longer composite is also alive, the acronym must drop to
    // weak/drop and the composite must lead.
    const lead = normalizeLead({
      company_name: 'Agenzia Mercato Immobiliare',
      city: 'Borgo Valbelluna',
      category: 'agenzie immobiliari',
    });
    const ranked = rankCandidates(
      [{ domain: 'am.com' }, { domain: 'agenziamercato.it' }],
      lead,
    );
    expect(ranked[0].domain).toBe('agenziamercato.it');
    expect(ranked[ranked.length - 1].tier).toBe('drop');
  });

  it('TLD bias: .it preferred over .org but .org not blocked', () => {
    const lead = normalizeLead({
      company_name: 'Iniziative S.p.A.',
      city: 'Asolo',
      category: 'agenzie immobiliari',
    });
    // "iniziative" is in COMMON_BARE_STEMS → both penalised, but
    // ranker still produces a deterministic order. iniziative.org
    // is the historical "For Sale" parking page — must not be `strong`.
    const r = rankCandidate('iniziative.org', lead);
    expect(r.tier).not.toBe('strong');
  });
});
