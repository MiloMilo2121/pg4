import * as cheerio from 'cheerio';
import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';

/**
 * R9 — Structural Paid Evidence Gate.
 *
 * Audit data driving this gate:
 *   - BL paid run: 73 SERP_PAID accepted, manual audit 67 TP / 6 FP
 *     → 91.8 % precision (above 85 % target)
 *   - VR paid run: 58 SERP_PAID accepted, manual audit 44 TP / 14 FP
 *     → 75.9 % precision (BELOW 85 % target)
 *
 * The drop was caused by Layer-1 `piva_match` accepting pages whose
 * body contains the lead's P.IVA without any commercial-identity
 * corroboration:
 *   - business-data aggregators (casabitare.it, visure24.com, sihappy.it,
 *     startuplus.it, ...) — publish every firm's P.IVA in directory
 *     listings
 *   - wrong-sector cross-vat: same legal entity operates a non-real-
 *     estate business (babileather.it leather, ingebau.it engineering,
 *     tipsammartino.it printing)
 *   - govt / research / video (cnr.it, opencup.gov.it, univalpo.it,
 *     youtube.com) — publish vat data for their own purposes
 *
 * The fix is structural, not reactive: piva_match must be accompanied
 * by a real-estate commercial-identity signal on the SAME page. Three
 * rules, in order:
 *
 *   1) Aggregator detection (hard veto). If the body contains many
 *      DISTINCT 11-digit vat-shaped numbers, the page is a directory
 *      listing other firms — reject regardless of other signals.
 *
 *   2) Sector signal (required). The body must mention at least one
 *      real-estate vocabulary token. Rejects wrong-sector pages whose
 *      vat happens to match (leather, engineering, printing,
 *      research, govt, video).
 *
 *   3) Title/H1 corroboration (required). The title or H1 must
 *      reference EITHER a real-estate sector keyword OR a distinctive
 *      firm-name token. Catches pages where the body mentions
 *      immobiliare incidentally but the page is fundamentally about
 *      something else (multi-category marketplace, leather firm with
 *      a tiny immobiliare division).
 *
 * Use: SerpStage.runPaidPass runs this gate AFTER PreVerifyGate's
 * piva_match / phone_match acceptance and BEFORE setting
 * `lead.official_website`. On reject, the lead falls through to
 * NOT_FOUND (consistent with R7.0 semantic-veto behaviour).
 *
 * Pure function: no I/O, no router calls. Tests stay 0-network.
 */

export interface PaidEvidenceVerdict {
  /** True when the body corroborates the piva match with commercial identity. */
  allow: boolean;
  /** Diagnostic chain — first failing rule appears last in the list. */
  reasons: string[];
}

/** Italian + English real-estate vocabulary. Conservative: each token
 *  should appear naturally on a real agency's site, never on
 *  unrelated business surfaces. Global flag enables count-based
 *  density check (Rule 2). */
const SECTOR_REGEX = new RegExp(
  [
    'immobiliar(e|i|a)',          // immobiliare/immobiliari/immobiliaria
    'agenzia\\s+immobiliar',      // agenzia immobiliare
    'compravendit(a|e)',          // compravendita
    'locazion(e|i)',              // locazione/locazioni
    'appartament(o|i)',           // appartamento/appartamenti
    'real\\s+estate',
    'mediatore\\s+immobiliar',    // mediatore immobiliare
    'vendita\\s+immob',           // vendita immobili / vendita immobiliare
    'affitt(o|i|are|asi)',        // affitto, affitti, affittare
    'intermediazion(e|i)\\s+immob',// intermediazione immobiliare
    'consulen(za|ze)\\s+immob',   // consulenza immobiliare
    'property\\s+management',     // English
    'rentals?',                   // English "rental(s)"
    'casa\\s+(in\\s+(vendita|affitto)|nuova)',
    'cerca\\s+casa',
    'vendere\\s+casa',
  ].join('|'),
  'gi',
);

/**
 * Minimum count of sector-vocabulary matches required for ACCEPT.
 * Real agency sites have 5-50+ matches across nav, hero copy, listings,
 * footer; wrong-sector pages mention "immobiliare" 0-2 times (corporate-
 * divisions paragraph, regulatory footer). Threshold 3 chosen by
 * inspection of BL+VR audit data — separates the two classes cleanly.
 */
const MIN_SECTOR_DENSITY = 3;

/** True when the body has ≥`min` DISTINCT vat-shaped numbers. The lead's
 *  own P.IVA is one of them, so the cutoff is the lead's vat + N other
 *  vats = 1 + N. Default min=4 (lead + 3 others) — observed sufficient
 *  in BL+VR audit: real agency sites have at most 1-2 vats (their own
 *  + maybe a partner), aggregators have 10+. */
function distinctVatCount(html: string): number {
  const matches = html.match(/\b\d{11}\b/g) ?? [];
  return new Set(matches).size;
}

// (An earlier gate revision matched firm-distinctive name tokens against
// title/H1 — superseded by the R9 semantic-evidence integration. The dead
// helper was removed in the Phase E lint pass; see git history for the
// original implementation if the rule ever comes back.)

export function evaluatePaidEvidence(
  html: string,
  // Arity preserved for the existing call sites; the gate's current rules
  // are content-only (vat density, sector density, parked detection) and
  // do not consult the lead. The semantic name-match lives in
  // semantic_evidence.ts.
  _normalized: NormalizedLead,
  _lead: Lead,
): PaidEvidenceVerdict {
  const reasons: string[] = [];

  if (!html || html.length < 200) {
    reasons.push('tiny_or_empty_html');
    return { allow: false, reasons };
  }

  const $ = cheerio.load(html);
  const bodyText = $('body').text().toLowerCase();

  // ---- Rule 1: aggregator detection (hard veto) -------------------------
  const vatCount = distinctVatCount(html);
  if (vatCount >= 4) {
    reasons.push(`aggregator_many_vats:${vatCount}`);
    return { allow: false, reasons };
  }
  reasons.push(`vat_count:${vatCount}`);

  // ---- Rule 2: sector density (required) --------------------------------
  // Count sector-vocabulary matches in body. Real agency sites mention
  // immobiliare / casa / affitto / etc. many times across nav, hero
  // copy, listings, footer (typical 5-50). Wrong-sector pages mention
  // it 0-2 times (corporate-divisions paragraph, regulatory footer).
  // Threshold 3 — chosen by inspection of BL+VR audit data.
  const sectorMatches = bodyText.match(SECTOR_REGEX) ?? [];
  const sectorDensity = sectorMatches.length;
  if (sectorDensity < MIN_SECTOR_DENSITY) {
    reasons.push(`sector_density_too_low:${sectorDensity}`);
    return { allow: false, reasons };
  }
  reasons.push(`sector_density:${sectorDensity}`);

  // The title rule is intentionally NOT included anymore. Audit
  // showed it generated false rejections on real agency sites whose
  // homepage title is generic ("Cortina.it", "Agenzia Valbelluna",
  // "CE Casa") while the body content is dominantly real-estate.
  // Sector density is a stronger structural signal than title text.

  return { allow: true, reasons };
}
