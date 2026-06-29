/**
 * R14 — free SERP routing policy.
 *
 * Decides which free SERP providers a category should use. Pure and
 * side-effect-free: the caller (SerpStage) supplies the category and the
 * expanded-free flag; this module returns the provider ids to exclude.
 *
 * Evidence (R12 PD full free enrich, 1,492 leads, category "agenzie
 * immobiliari"): the free SERP tier produced ZERO final-website conversions
 * (0 `SERP_COMPANY`). All 536 websites came from INPUT_SEMANTIC / HYPER_GUESSER
 * / PG_PHONE_SOURCE_TRUST, verified via direct_fetch. dns_mx (0/956) and crtsh
 * (0/956) returned only empties; ddg_lite returned results once (1/956) but it
 * never verified. bing_html "succeeded" 955/955 at the retrieval layer but every
 * candidate was rejected at verify (709 SERP_DIRECTORY_ONLY + 34
 * SERP_REJECTED_BY_VERIFY) — 0 conversions.
 *
 * Gate-0 update: `dns_mx` and `crtsh` were DELETED from the catalog (0
 * successes in 12,728 calls each — see provider_catalog.ts). What remains
 * of the low-yield set is `ddg_lite`, which returns ad-junk that never
 * verifies on the real-estate profile but is non-zero elsewhere, so it is
 * kept and merely GATED OFF for `italian_real_estate` (restored by the
 * expanded-free override). bing_html stays as the single legitimate free
 * SERP for this profile.
 */

export type SerpProfile = 'default' | 'italian_real_estate';

/**
 * Free SERP providers gated off on the real-estate profile (R12). dns_mx +
 * crtsh were deleted outright (Gate-0); only ddg_lite remains to gate.
 */
export const LOW_YIELD_REAL_ESTATE_SERP: ReadonlyArray<string> = ['ddg_lite'];

/**
 * Map a lead category to a routing profile. Italian real-estate categories all
 * contain the stem "immobil" (agenzie/agenzia immobiliari/e, consulenza/
 * compravendita/mediatore immobiliare). Unknown/other categories → `default`.
 */
export function resolveSerpProfile(category?: string): SerpProfile {
  if (category && /immobil/i.test(category)) return 'italian_real_estate';
  return 'default';
}

export interface FreeSerpRoute {
  profile: SerpProfile;
  /** Provider ids to exclude from the free SERP pass for this category. */
  excludeProviderIds: ReadonlyArray<string>;
}

/**
 * Resolve the free SERP routing for a lead.
 *
 * @param category    the lead's category (e.g. "agenzie immobiliari")
 * @param expandedFree when true, use the full free SERP set even for a
 *                     profile that would otherwise prune (operator override
 *                     via SERP_EXPANDED_FREE_ENABLED, or other-vertical eval)
 */
export function resolveFreeSerpRoute(category: string | undefined, expandedFree: boolean): FreeSerpRoute {
  const profile = resolveSerpProfile(category);
  if (profile === 'italian_real_estate' && !expandedFree) {
    return { profile, excludeProviderIds: LOW_YIELD_REAL_ESTATE_SERP };
  }
  return { profile, excludeProviderIds: [] };
}
