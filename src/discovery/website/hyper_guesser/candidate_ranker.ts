import type { NormalizedLead } from '../../../types/discovery';
import {
  extractDistinctiveTokens,
  compactStrippedBrand,
  compactFullName,
  isCommonBareStem,
  shortHost,
} from '../semantic_evidence';
import { ItalianNerParser } from './italian_ner_parser';

/**
 * Phase D.4 — pre-fetch ranking of HyperGuesser alive candidates.
 *
 * Today HyperGuesserStage verifies `guesses.slice(0, 6)` blindly.
 * That means a noisy Treviso lead with 6 alive candidates spends the
 * whole per-stage budget on weak guesses (acronym + TLD generics)
 * and never reaches the strong one. The TV p64 audit traced this to
 * candidates like `bs.net`, `ad.com`, `as.eu` eating the retry budget.
 *
 * The ranker assigns a deterministic score to each alive candidate
 * BEFORE any HTTP fetch. The stage uses the score to:
 *   - reserve the full retry budget for the top candidate(s)
 *   - cap weak candidates to a single attempt (no retry)
 *   - skip candidates whose score is below a hard floor
 *
 * Pure function over (HyperGuess, NormalizedLead). No network. No
 * shared state. Reuses `semantic_evidence` helpers so the ranker
 * stays consistent with PreVerifyGate's accept rules.
 *
 * Score is not a probability — it's an ordering key. Higher = more
 * promising. Negative = drop.
 */

export interface CandidateScore {
  domain: string;
  url: string;
  score: number;
  tier: 'strong' | 'weak' | 'drop';
  reasons: string[];
}

const STRONG_THRESHOLD = 50;
const DROP_THRESHOLD = -50;

const TLD_BONUS: Record<string, number> = {
  it: 8,
  com: 4,
  eu: 2,
  net: 0,
  org: 0,
};

export function rankCandidate(domain: string, lead: NormalizedLead): CandidateScore {
  const reasons: string[] = [];
  const url = `https://${domain}`;
  const stem = shortHost(url);
  const tld = (domain.split('.').pop() ?? '').toLowerCase();

  const compactStripped = compactStrippedBrand(lead.company_name);
  const compactFull = compactFullName(lead.company_name);
  const distinctiveTokens = extractDistinctiveTokens(lead.company_name);
  const ner = ItalianNerParser.parse(lead.company_name);
  const leadCityCompact = (lead.city ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

  let score = 0;

  // Hard guard: domain stem too short — same floor PreVerifyGate uses.
  if (stem.length < 6) {
    reasons.push('stem_too_short');
    return { domain, url, score: -1000, tier: 'drop', reasons };
  }

  // Layer-A-class match: domain == compactFull (or contains it). Strongest.
  if (compactFull.length >= 14 && stem === compactFull) {
    score += 100;
    reasons.push('exact_full_name_match');
  } else if (compactFull.length >= 14 && stem.includes(compactFull)) {
    score += 80;
    reasons.push('domain_contains_full_name');
  }

  // Layer-B-class match: domain contains the stripped brand stem
  // (post-NER descriptors removed). Strong when the brand is real.
  if (compactStripped.length >= 6 && stem === compactStripped) {
    score += 70;
    reasons.push('exact_stripped_brand');
  } else if (compactStripped.length >= 6 && stem.includes(compactStripped)) {
    score += 50;
    reasons.push('domain_contains_stripped_brand');
  } else if (compactStripped.length >= 6 && compactStripped.includes(stem)) {
    // Reverse direction: legit when the domain is a shortened brand
    // (e.g. "pierobon.com" for "Estimo Pierobon").
    score += 30;
    reasons.push('stripped_brand_contains_domain');
  }

  // Multi-token composite: domain joins ≥2 distinctive tokens
  // (e.g. "agenzialaperla.it"). Specific = unlikely homonym.
  if (distinctiveTokens.length >= 2) {
    const hits = distinctiveTokens.filter((t) => stem.includes(t)).length;
    if (hits >= 2) {
      score += 25;
      reasons.push(`composite_${hits}of${distinctiveTokens.length}_tokens`);
    }
  }

  // City + brand composite (HyperGuesser's `${cleanName}${cleanCity}`).
  if (leadCityCompact.length >= 4 && stem.includes(leadCityCompact) && distinctiveTokens.some((t) => stem.includes(t))) {
    score += 20;
    reasons.push('brand_plus_city');
  }

  // Penalties — weed out the generic / parked-portal classes.

  // Bare common-stem: lead's only distinctive token is in the audit
  // denylist (bloom, ufficio, area, mia, torri, comelico, europa, …)
  // and the domain stem is essentially that bare stem.
  if (
    distinctiveTokens.length === 1 &&
    isCommonBareStem(distinctiveTokens[0]) &&
    stem.includes(distinctiveTokens[0])
  ) {
    score -= 200;
    reasons.push(`common_bare_stem_${distinctiveTokens[0]}`);
  }

  // Phase D.5 — also flag the COMPACT stripped brand (multi-token
  // join) when it's denylisted: e.g. "Solar System" →
  // compactStripped="solarsystem" matches solarsystem.it. The
  // 1-distinctive-token check above misses this multi-word case.
  if (compactStripped.length > 0 && isCommonBareStem(compactStripped) && stem.includes(compactStripped)) {
    score -= 200;
    reasons.push(`common_bare_compact_${compactStripped}`);
  }

  // Bare city: stem is just the lead's city (or its first word).
  if (leadCityCompact.length >= 4 && leadCityCompact.includes(stem)) {
    score -= 80;
    reasons.push('bare_city_stem');
  }

  // Acronym-only domain: stem ≤ 4 chars AND not the full company
  // compact. These are HyperGuesser's `acro1` / `acro2` outputs and
  // are almost always third-party homonyms (bs.net, am.com, ad.eu).
  if (stem.length <= 4 && stem !== compactFull && stem !== compactStripped) {
    score -= 60;
    reasons.push('acronym_only_stem');
  }

  // Descriptor-only domain: NER produced no real brand token, only
  // generic descriptors. e.g. "Agenzia Immobiliare" → agenziaimmobiliare.
  if (distinctiveTokens.length === 0 && ner.brandTokens.every((t) => t.length < 4)) {
    score -= 40;
    reasons.push('descriptor_only_brand');
  }

  // TLD bias. Italian SMBs heavily favour `.it`; do not hard-reject
  // `.org`/`.net` because some legit IT shops use them.
  const tldBonus = TLD_BONUS[tld] ?? 0;
  if (tldBonus !== 0) {
    score += tldBonus;
    reasons.push(`tld_${tld}_${tldBonus >= 0 ? '+' : ''}${tldBonus}`);
  }

  // Tie-breaker: longer specific stems are more specific.
  if (stem.length >= 10) {
    score += 4;
    reasons.push('long_stem');
  }

  let tier: CandidateScore['tier'];
  if (score < DROP_THRESHOLD) tier = 'drop';
  else if (score >= STRONG_THRESHOLD) tier = 'strong';
  else tier = 'weak';

  return { domain, url, score, tier, reasons };
}

/**
 * Rank a list of HyperGuess candidates. Stable sort: ties resolved by
 * (1) tier strong > weak > drop, (2) input order.
 *
 * Returns the SAME shape callers can iterate; HyperGuesserStage decides
 * how to spend retry budget across tiers.
 */
export function rankCandidates(
  candidates: ReadonlyArray<{ domain: string; generation_rank?: number }>,
  lead: NormalizedLead
): CandidateScore[] {
  const scored = candidates.map((c) => rankCandidate(c.domain, lead));
  return scored
    .map((s, i) => ({ s, idx: i }))
    .sort((a, b) => b.s.score - a.s.score || a.idx - b.idx)
    .map(({ s }) => s);
}
