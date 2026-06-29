import type { GateResult, GateStatus, NormalizedLead } from '../../types/discovery';
import { evaluateSemanticEvidence } from './semantic_evidence';

/**
 * Phase D layered gate: decides whether `url` (with the HTML it served)
 * belongs to `normalized`. Pure function over (url, html, lead).
 *
 * Decision order — first match wins:
 *
 *   1. **PIVA digit-match** in body → VERIFIED, evidence `piva_match`.
 *      Strongest signal. No further check.
 *
 *   2. **Phone digit-match** (last 7 digits of normalized phone) in body →
 *      VERIFIED, evidence `phone_match`. Very strong, deterministic.
 *
 *   3. **Layer A — long full-name embedded in domain** (≥ 14 chars
 *      with at least one non-descriptor brand token) → VERIFIED_SEMANTIC,
 *      evidence `strong_full_name`. Catches the Pierobon / Sg /
 *      Cortina Properties / Andreotta TPs.
 *
 *   4. **Layer B — stripped brand stem in domain** (≥ 6 chars, not a
 *      common bare stem) → VERIFIED_SEMANTIC, evidence `strong_brand`.
 *      Catches Il Maso / La Decisa / Gecoimmobili / Giacin / Comelico /
 *      DMC Legno / dalla Riva (Feltre).
 *
 *   5. **Layer C — multi-token + business_city + sector aligned** →
 *      VERIFIED_SEMANTIC, evidence `multi_token_anchor`. Conservative
 *      fallback for cases that don't match Layers A/B but still have
 *      multi-token brand evidence and locality + sector context.
 *
 *   6. Otherwise REJECTED with a specific sub-reason that maps to a
 *      Phase D taxonomy reason code (see `types/output.ts`):
 *        - `tiny_or_parked`     → SEMANTIC_REJECTED_TINY_OR_PARKED
 *        - `common_stem`        → SEMANTIC_REJECTED_COMMON_STEM
 *        - `sector_conflict`    → SEMANTIC_REJECTED_SECTOR_CONFLICT
 *        - `missing_city`       → SEMANTIC_REJECTED_MISSING_CITY
 *        - `no_distinctive`     → SEMANTIC_REJECTED_NO_DISTINCTIVE_TOKENS
 *
 * The gate does NOT call RDAP (network). The verify_candidates layer
 * runs RDAP after a VERIFIED_SEMANTIC decision and may downgrade to
 * REJECTED with `SEMANTIC_REJECTED_RDAP_MISMATCH`.
 */
export class PreVerifyGate {
  static check(url: string, html: string, normalized: NormalizedLead): GateResult {
    // Hard floor: a body too short to evaluate is rejected straight away.
    if (!html || html.length < 50) {
      return { status: 'REJECTED', url, detail: 'tiny_or_parked' };
    }

    // 1. PIVA — strongest deterministic anchor.
    const piva = (normalized.vat_code ?? '').replace(/\D/g, '');
    if (piva && piva.length === 11) {
      const bodyDigits = html.replace(/[^0-9]/g, '');
      if (bodyDigits.includes(piva)) {
        return { status: 'VERIFIED', url, evidence: 'piva_match', detail: 'piva_match' };
      }
    }

    // 2. Phone digit-match — last-7 digits of the normalized lead phone.
    const phoneDigits = (normalized.phone ?? '').replace(/\D/g, '');
    if (phoneDigits.length >= 7) {
      const tail = phoneDigits.slice(-7);
      const bodyDigits = html.replace(/[^0-9]/g, '');
      if (bodyDigits.includes(tail)) {
        return { status: 'VERIFIED' as GateStatus, url, evidence: 'phone_match', detail: 'phone_match' };
      }
    }

    const ev = evaluateSemanticEvidence(url, html, normalized);

    // Defensive rejection paths — checked before the accept layers because
    // a tiny / parked / common-stem page must never fall through into a
    // VERIFIED_SEMANTIC accept on a coincidental Layer-A/B match.
    if (ev.tinyOrParked) {
      return { status: 'REJECTED', url, detail: 'tiny_or_parked' };
    }
    if (ev.hasCommonBareStem) {
      return { status: 'REJECTED', url, detail: 'common_stem' };
    }
    // Sector conflict only matters when no aligned signal exists AND the
    // identity match is weak (Layer A/B failed). For Layer A/B + aligned
    // signal, sector conflict is tolerated (DMC Legno: PG mis-categorises
    // as immobiliare but the website is the company's real site).

    // Sector-conflict tolerance: Layer A/B fire when sector is aligned, OR
    // not conflicting, OR there's a positive locality anchor (the site
    // explicitly names the lead's city). The locality clause is the
    // DMC-Legno escape hatch: PG mis-categorises a real Belluno
    // carpentry firm as `agenzie immobiliari`, but their website
    // legitimately mentions Belluno — accept the identity match.
    const sectorOk = ev.sectorAligned || !ev.sectorConflicting || ev.hasCity;

    // 3. Layer A — long compact full-name match.
    if (ev.layerAFullName && sectorOk) {
      return {
        status: 'VERIFIED_SEMANTIC' as GateStatus,
        url,
        evidence: 'strong_full_name',
        detail: `strong_full_name compact=${ev.compactFull.length}c distinctive=${ev.distinctiveTokens.length}`,
      };
    }

    // 4. Layer B — stripped brand stem match.
    if (ev.layerBStrippedBrand && sectorOk) {
      return {
        status: 'VERIFIED_SEMANTIC' as GateStatus,
        url,
        evidence: 'strong_brand',
        detail: `strong_brand stripped=${ev.compactStripped.length}c hits=${ev.multiTokenHits}/${ev.distinctiveTokens.length}`,
      };
    }

    // 5. Layer C — multi-token + city + sector aligned.
    if (
      ev.distinctiveTokens.length >= 2 &&
      ev.multiTokenHits >= Math.min(2, ev.distinctiveTokens.length) &&
      ev.hasCity &&
      (ev.sectorAligned || !ev.sectorConflicting)
    ) {
      return {
        status: 'VERIFIED_SEMANTIC' as GateStatus,
        url,
        evidence: 'multi_token_anchor',
        detail: `multi_token_anchor hits=${ev.multiTokenHits}/${ev.distinctiveTokens.length} city=${ev.hasCity}`,
      };
    }

    // 6. Specific rejection reasons (in order: most informative first).
    if (ev.sectorConflicting && !ev.sectorAligned && !ev.layerAFullName && !ev.layerBStrippedBrand) {
      return {
        status: 'REJECTED',
        url,
        detail: `sector_conflict aligned=${ev.alignedHits.length} conflict=${ev.conflictHits.length}`,
      };
    }
    if (ev.distinctiveTokens.length === 0) {
      return { status: 'REJECTED', url, detail: 'no_distinctive_tokens' };
    }
    if (!ev.hasCity && !ev.layerAFullName && !ev.layerBStrippedBrand) {
      return {
        status: 'REJECTED',
        url,
        detail: `missing_city tokens=${ev.distinctiveTokens.length} hits=${ev.multiTokenHits}`,
      };
    }
    return {
      status: 'REJECTED',
      url,
      detail: `weak_evidence tokens=${ev.distinctiveTokens.length} hits=${ev.multiTokenHits} city=${ev.hasCity} sector_aligned=${ev.sectorAligned}`,
    };
  }
}
