import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';
import type { PerLeadContext, Stage } from '../../types/enrichment';
import type { StageOutcome } from '../../types/output';
import { ReasonCode as RC, DiscoveryMethod } from '../../types/output';
import { RdapValidator } from '../../discovery/website/rdap_validator';
import { DEFAULTS } from '../../config/defaults';

/**
 * RDAP rescue: if no website found yet, take the strongest HyperGuesser DNS
 * survivor (or the input website if it had a directory classification) and
 * check the WHOIS payload for P.IVA / company-name match.
 */
export class RdapBoostStage implements Stage {
  readonly name = 'rdap';

  async run(_ctx: PerLeadContext, lead: Lead, normalized: NormalizedLead): Promise<StageOutcome> {
    const start = Date.now();
    const target = normalized.website || lead.official_website;
    if (!target) {
      return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'no_target_domain' };
    }
    const ev = await RdapValidator.checkDomainOwnership(target, normalized);
    if (ev.confidence >= 0.8) {
      lead.official_website = lead.official_website ?? target;
      lead.website_discovery_method = DiscoveryMethod.RDAP_BINGO;
      lead.website_confidence = DEFAULTS.scoring.rdapBingoConfidence;
      return { stage: this.name, status: 'success', duration_ms: Date.now() - start, evidence_count: 1, detail: ev.detail };
    }
    if (ev.confidence >= 0.4) {
      lead.official_website = lead.official_website ?? target;
      lead.website_discovery_method = DiscoveryMethod.RDAP_NAME_MATCH;
      lead.website_confidence = ev.confidence;
      return { stage: this.name, status: 'success', duration_ms: Date.now() - start, evidence_count: 1, detail: ev.detail };
    }
    return { stage: this.name, status: 'not_found', duration_ms: Date.now() - start, reason_code: RC.DISCOVERY_EXHAUSTED, detail: ev.detail || 'no_rdap_match' };
  }
}
