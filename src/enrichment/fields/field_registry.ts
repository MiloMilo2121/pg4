import type { EnrichmentFieldDescriptor, EnrichmentStep, StepResult, FieldStepContext } from './field_types';
import { registrableDomain } from '../../util/domain';
import { normalizeVatCode, validateItalianVatChecksum } from '../financial/vat';
import { checkVatViaVies } from '../financial/vies';
import { fetchFatturatoItalia } from '../financial/fatturato_italia_fetch';
import { normalizeCompanyNameForKey } from '../../discovery/deduper';
import { HunterProvider, type HunterEmail } from '../../providers/email/hunter';
import { emailInferenceStep } from '../email/email_inference_step';

/**
 * THE per-field cascade registry. Each field declares its ordered free→paid
 * steps. The free (tier-0) steps read the already-fetched website body via the
 * Phase-1 extractor — €0 marginal cost, the measured free-gold (email 54%,
 * social 60%, VAT 67%). Paid (tier-2) and free-network (tier-1 registry) steps
 * are WIRED BUT DISABLED (`enabled: false`) until the official-data spine and
 * the paid providers are activated — see the PRODUCTION ACTIVATION CHECKLIST.
 *
 * Honesty (per the blueprint): instagram/facebook/linkedin are free WHEN a
 * website exists and structurally hard otherwise — there is no cheap T2 here,
 * so none is declared. decision_maker is honestly paid; its T0 is a minority
 * catch.
 */

// ---- free tier-0 steps: read the already-fetched body (€0) ----

const emailFromBody: EnrichmentStep = {
  id: 'email.body_same_domain',
  tier: 0,
  costEur: 0,
  enabled: true,
  run: (ctx: FieldStepContext): StepResult =>
    valueOr(ctx.extraction?.email, 'website_body', 0.8),
};

const pecFromBody: EnrichmentStep = {
  id: 'pec.body',
  tier: 0,
  costEur: 0,
  enabled: true,
  run: (ctx): StepResult => valueOr(ctx.extraction?.pec, 'website_body', 0.85),
};

/**
 * EMAIL_FIND paid escalation — Hunter domain-search. SHIPPED DISABLED (enabled=false):
 * activates only when the operator flips it on (the field runner's triple-gate then
 * applies: paidEnabled + per-field ceiling + the ledger records the credit). Reuses the
 * Hunter adapter; €0.04/credit. Reached only when the free body step
 * produced nothing.
 */
const hunter = new HunterProvider();
function hunterEmailStep(enabled: boolean): EnrichmentStep {
  return {
    id: 'email.hunter',
    tier: 2,
    costEur: 0.04,
    family: 'email',
    enabled,
    run: async (ctx: FieldStepContext): Promise<StepResult> => {
      const site = (ctx.lead.website as string | undefined) ?? (ctx.lead as Record<string, unknown>).official_website as string | undefined;
      const domain = site ? registrableDomain(site) : undefined;
      if (!domain) return { confidence: 0, source: 'email.hunter', costEur: 0, skippedReason: 'no_input' };
      const emails = await hunter.domainSearch(domain, 10);
      const best = pickBestEmail(emails);
      if (!best) return { confidence: 0, source: 'email.hunter', costEur: 0.04, skippedReason: 'no_value' };
      // Hunter confidence is 0..100; normalize to 0..1 (default 0.7 when absent).
      const conf = typeof best.confidence === 'number' ? Math.min(1, best.confidence / 100) : 0.7;
      return { value: best.value, confidence: conf, source: 'email.hunter', costEur: 0.04 };
    },
  };
}

/** Prefer a generic/role inbox (info@, contatti@, …) else the highest-confidence address. */
export function pickBestEmail(emails: HunterEmail[]): HunterEmail | undefined {
  if (emails.length === 0) return undefined;
  const generic = emails.find((e) => e.type === 'generic' || /^(info|contatti?|contact|hello|sales|commerciale)@/i.test(e.value));
  if (generic) return generic;
  return [...emails].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
}

/**
 * Fuzzy company-name match (token overlap after legal-form normalization).
 * Legal-form tokens (srl/spa/snc/…) are EXCLUDED — every company has one, so a
 * shared "srl" must not inflate the match ("Immobiliare Rossi SRL" vs "Studio
 * Rossi SRL" share only the form + "rossi", not the same firm).
 *
 * MATCH RULE — require ≥2 shared distinctive tokens (containment OR Jaccard ≥ 0.5),
 * with ONE exception: both names are the SAME single token ("Blurebus"=="Blurebus Srl").
 * Why ≥2: a SINGLE shared token is a brand or a common surname, and across two distinct
 * legal entities it must NOT confirm. Two collision classes the validation audit caught:
 *  - FRANCHISOR (2026-06-14): local "Agenzia Immobiliare Tecnocasa ... Albignasego" cites
 *    the FRANCHISOR's footer VAT → registry name "Tecnocasa Franchising S.p.A." shares only
 *    "tecnocasa" → was false-confirmed @0.95, attaching €58M. (Gabetti/Re-Max/Toscano/… too.)
 *  - BARE-BRAND SISTER (2026-06-16): a different-city "Metroquadro Srl" {metroquadro} is a
 *    subset of "Immobiliare Metroquadro" → the OLD containment rule confirmed it. Now the
 *    single shared "metroquadro" is rejected (the real Padova Metroquadro confirms because
 *    its registry name "IMMOBILIARE METROQUADRO A R.L." shares 2 tokens). Containment is
 *    still honored at ≥2 tokens (owner-suffix: "Immobiliare Giglio" ⊆ "...di Cecchinato Ornella").
 */
const NAME_LEGAL_FORMS = new Set(['srl', 'srls', 'spa', 'snc', 'sas', 'sapa', 'ss', 'sc', 'scarl', 'scrl', 'soc', 'coop']);
function nameTokens(s: string): Set<string> {
  return new Set(normalizeCompanyNameForKey(s).split(' ').filter((t) => t.length > 2 && !NAME_LEGAL_FORMS.has(t)));
}
/** Count of shared distinctive tokens — used to tell a CONFIRM (≥2) from a clearly
 *  FOREIGN name (0 shared) and an AMBIGUOUS one (exactly 1 shared) in vatResolve. */
export function sharedNameTokenCount(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter;
}
export function companyNameMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  if (inter === 0) return false;
  // A single shared token (brand / common surname) confirms ONLY if it IS the whole
  // name on both sides ("Blurebus" == "Blurebus Srl"); otherwise it's a collision.
  if (inter === 1) return ta.size === 1 && tb.size === 1;
  const contained = inter === ta.size || inter === tb.size; // one name's tokens ⊆ the other (owner-suffix)
  return contained || inter / (ta.size + tb.size - inter) >= 0.5;
}

/**
 * ENTITY-VERIFICATION GUARD — the field-level half of the wrong-entity defense.
 * EVERY VAT-keyed firmographic step MUST call this before trusting the fetched data:
 * the registered name the source returns for the VAT must match the lead, else the VAT
 * belongs to a DIFFERENT legal entity (franchisor / accountant / sister company) and its
 * data must be refused. Returns true when the data must be REFUSED.
 *
 * Fails closed: when either name is missing the match cannot be verified, and an
 * unverified VAT is exactly how a franchisor's €58M landed on a local agency. Refusing
 * costs one field; accepting attaches another company's numbers to the lead.
 */
export function isWrongEntity(fetchedRegisteredName: string | undefined, leadCompanyName: string | undefined): boolean {
  if (!fetchedRegisteredName || !leadCompanyName) return true;
  return !companyNameMatches(fetchedRegisteredName, leadCompanyName);
}

const socialStep = (key: 'instagram' | 'facebook' | 'linkedin' | 'tiktok' | 'youtube'): EnrichmentStep => ({
  id: `${key}.body_footer`,
  tier: 0,
  costEur: 0,
  enabled: true,
  run: (ctx): StepResult => valueOr(ctx.extraction?.[key], 'website_body', 0.8),
});

const decisionMakerFromBody: EnrichmentStep = {
  id: 'decision_maker.body_chisiamo',
  tier: 0,
  costEur: 0,
  enabled: true,
  // T0 catches only the minority that print a "Legale Rappresentante" /
  // "Titolare" line on the site. Low confidence by design.
  run: (): StepResult => ({ confidence: 0, source: 'website_body', costEur: 0, skippedReason: 'no_value' }),
};

// ---- wired-but-disabled steps (tier 1 registry / tier 2 paid) ----
// Each is a real placeholder: it declares its tier + cost + source, but
// `enabled: false` so the runner skips it. Activation = flip enabled + provide
// the provider (official-data spine / paid catalog).

const disabled = (id: string, tier: 0 | 1 | 2, costEur: number, source: string): EnrichmentStep => ({
  id,
  tier,
  costEur,
  enabled: false,
  run: (): StepResult => ({ confidence: 0, source, costEur, skippedReason: 'disabled' }),
});

// ---- official-data steps (FREE, network; the VAT-as-master-key spine) ----
// Enabled by default (VIES + fatturatoitalia are free public sources); each is
// toggleable via an env flag so a deployment can pin them off.

function flagOn(name: string): boolean {
  const v = process.env[name];
  return v === undefined || v === '' || v === '1' || v.toLowerCase() === 'true';
}

/** Like flagOn but DEFAULT-OFF — for gates that must be opted into (the email gate). */
function flagOnDefaultOff(name: string): boolean {
  const v = process.env[name];
  return v === '1' || (typeof v === 'string' && v.toLowerCase() === 'true');
}

/** Build the email-inference step from env (default-off master; probe on when active). */
function buildEmailInferenceStep() {
  const maxProbes = process.env.EMAIL_INFERENCE_MAX_PROBES_PER_DOMAIN;
  return emailInferenceStep({
    enabled: flagOnDefaultOff('EMAIL_INFERENCE_MX_ENABLED'),
    smtpProbe: flagOn('EMAIL_SMTP_PROBE_ENABLED'),
    heloName: process.env.EMAIL_SMTP_HELO_NAME || undefined,
    mailFrom: process.env.EMAIL_SMTP_MAIL_FROM || undefined,
    maxProbes: maxProbes ? Number(maxProbes) : undefined,
  });
}

/**
 * The VAT a field step keys on, WITH its provenance. A VAT scraped from the
 * firm's OWN page (vat_code_final / footer) is trustworthy; a VAT from the
 * INPUT scrape (lead.vat_code) is unverified — a mis-scraped-but-checksum-valid
 * input VAT would fetch the WRONG company's firmographics silently.
 * Callers must VIES-gate an 'input' VAT before trusting it.
 */
export type ResolvedVat = { vat: string; provenance: 'site' | 'input' };
function checksumOk(raw: string | undefined): string | undefined {
  const v = normalizeVatCode(raw);
  return /^\d{11}$/.test(v) && validateItalianVatChecksum(v) ? v : undefined;
}
export function resolveVat(ctx: FieldStepContext): ResolvedVat | undefined {
  const site = checksumOk((ctx.lead.vat_code_final as string | undefined) ?? ctx.extraction?.vat_candidates?.[0]);
  if (site) return { vat: site, provenance: 'site' };
  const input = checksumOk(ctx.lead.vat_code as string | undefined);
  if (input) return { vat: input, provenance: 'input' };
  return undefined;
}

// VAT precision step (the footer VAT[0] is the company's own only
// ~62% of the verifiable time — the rest cite the accountant's/partner's VAT).
// Resolve the COMPANY'S VAT: VIES each candidate, and pick the one whose official
// name matches the company. Confirmed → 0.95. VIES privacy (no name disclosed,
// common for IT) → footer VAT at LOW confidence, flagged unconfirmed. VIES names
// only OTHER companies → the footer VAT is foreign → REFUSE it (the precision fix
// that stops a wrong VAT from poisoning fatturato/dipendenti/PEC downstream).
const vatResolve: EnrichmentStep = {
  id: 'vat.vies_confirmed',
  tier: 1,
  costEur: 0,
  enabled: true, // always resolves; the VIES confirmation inside is flag-gated
  run: async (ctx): Promise<StepResult> => {
    const cands: string[] = [];
    for (const c of ctx.extraction?.vat_candidates ?? []) {
      const v = checksumOk(c);
      if (v && !cands.includes(v)) cands.push(v);
    }
    const inp = checksumOk(ctx.lead.vat_code as string | undefined);
    if (inp && !cands.includes(inp)) cands.push(inp);
    if (cands.length === 0) return { confidence: 0, source: 'vat', costEur: 0, skippedReason: 'no_input' };

    // VIES off (tests / pinned-off deployment) → footer VAT, unconfirmed, offline.
    if (!flagOn('OFFICIAL_DATA_VIES_ENABLED')) {
      return { value: cands[0], confidence: 0.6, source: 'vat:footer_unconfirmed', costEur: 0 };
    }

    // VIES only covers VATs registered for INTRA-EU trade. Most domestic-only Italian
    // SMBs are NOT in VIES (no name) even though their VAT is valid. THREE-WAY on the
    // returned name (not binary — a binary match/skip over-rejects):
    //   ≥2 shared tokens (companyNameMatches) → CONFIRM 0.95
    //   exactly 1 shared token → AMBIGUOUS (brand collision OR legit descriptor-drop) →
    //     keep at 0.6 unconfirmed, do NOT refuse (the fatturato entity-guard, which needs
    //     a real ≥2 match, still refuses attaching that entity's firmographics)
    //   0 shared tokens with a returned name → FOREIGN (positively another company) → skip
    //   no name (privacy / not-in-VIES) → keep at 0.6 unconfirmed
    const company = ctx.lead.company_name as string | undefined;
    let firstUnconfirmed: string | undefined;
    for (const c of cands.slice(0, 3)) {
      const v = await checkVatViaVies({ vatNumber: c, countryCode: 'IT' });
      const name = v.isValid && v.name && !/^[-\s]*$/.test(v.name) ? v.name : undefined;
      if (name && companyNameMatches(name, company)) {
        return { value: c, confidence: 0.95, source: 'vat:vies_confirmed', costEur: 0 };
      }
      if (name && sharedNameTokenCount(name, company) === 0) continue; // names a CLEARLY different company → foreign, skip
      if (firstUnconfirmed === undefined) firstUnconfirmed = c; // no name OR ambiguous single-shared-token → keep, can't confirm
    }
    if (firstUnconfirmed) return { value: firstUnconfirmed, confidence: 0.6, source: 'vat:footer_unconfirmed', costEur: 0 };
    // every candidate was POSITIVELY attributed by VIES to a different company.
    return { confidence: 0, source: 'vat:foreign_only', costEur: 0, skippedReason: 'vat_unverified' };
  },
};

// fatturatoitalia.it — revenue + employees by P.IVA (free public page; the
// parser already existed, this wires the fetch). One lookup fills both fields
// (memoised in the fetcher), so enriching revenue then employees costs one fetch.
const fatturatoItaliaStep = (field: 'revenue' | 'employees', confFloor: number): EnrichmentStep => ({
  id: `${field}.fatturatoitalia_by_vat`,
  tier: 1,
  costEur: 0,
  enabled: flagOn('OFFICIAL_DATA_FATTURATOITALIA_ENABLED'),
  run: async (ctx): Promise<StepResult> => {
    const rv = resolveVat(ctx);
    if (!rv) return { confidence: 0, source: 'fatturatoitalia', costEur: 0, skippedReason: 'no_input' };

    // An UNVERIFIED input VAT must be VIES-checked before we trust it to
    // fetch a company's firmographics; otherwise a mis-scraped (but checksum-
    // valid) VAT silently returns the WRONG company's revenue.
    // CONFIDENCE INHERITANCE: a downstream firmographic is only as trustworthy
    // as the VAT KEY that fetched it (a wrong key = the wrong company's revenue). So
    // `confCap` carries the key's trust into the value's confidence:
    //   own-page VAT (site) → 0.9 · VIES-confirmed input → 0.95 · VIES-down input → 0.5.
    let tag: string = rv.provenance; // 'site' = the firm's own page (trusted, not independently VIES-confirmed here)
    let confCap = 0.9;
    if (rv.provenance === 'input') {
      const v = await checkVatViaVies({ vatNumber: rv.vat, countryCode: 'IT' });
      if (v.isValid && v.checked) { tag = 'input+vies'; confCap = 0.95; } // VIES confirmed → trust
      else if (v.isValid && !v.checked) { tag = 'input?vies-down'; confCap = 0.5; } // VIES unreachable → low confidence, flagged
      else return { confidence: 0, source: 'fatturatoitalia(input)', costEur: 0, skippedReason: 'vat_unverified' }; // VIES says invalid → refuse
    }

    const fi = await fetchFatturatoItalia(rv.vat);
    if (!fi) return { confidence: 0, source: `fatturatoitalia(${tag})`, costEur: 0, skippedReason: 'no_value' };

    // ENTITY VERIFICATION (validation audit 2026-06-14, the franchise-collision bug):
    // a footer/input VAT can belong to a DIFFERENT legal entity than the lead — a
    // FRANCHISOR (a local "...Tecnocasa... Albignasego" agency cited the franchisor's
    // VAT → €58M attached) or an accountant. The shared isWrongEntity() guard refuses
    // someone else's firmographics regardless of provenance. This is the field-level
    // half; vatResolve is the other. Both needed: resolveVat trusts a 'site' VAT
    // directly, so without this the wrong revenue attaches even when the VAT field
    // correctly refused the same VAT.
    const company = ctx.lead.company_name as string | undefined;
    if (isWrongEntity(fi.company_name, company)) {
      return { confidence: 0, source: `fatturatoitalia(${tag}:entity_mismatch)`, costEur: 0, skippedReason: 'vat_unverified' };
    }

    const value = fi[field];
    if (!value) return { confidence: 0, source: `fatturatoitalia(${tag})`, costEur: 0, skippedReason: 'no_value' };
    return {
      value: String(value),
      confidence: Math.min(confCap, Math.max(confFloor, fi.confidence)),
      source: `fatturatoitalia(${tag})`,
      costEur: 0,
      // The same fetch parsed the bilancio year — ship it with the revenue so
      // the list can say "fatturato 2024", not just "fatturato".
      extras: field === 'revenue' && fi.revenue_year ? { revenue_year: fi.revenue_year } : undefined,
    };
  },
});

export const FIELD_REGISTRY: EnrichmentFieldDescriptor[] = [
  {
    field: 'vat',
    target: 'vat_code_final',
    // Single VIES-confirming resolver (see vatResolve): confirmed company VAT
    // 0.95, footer-unconfirmed 0.6, proven-foreign refused. stop=0.6 so an
    // unconfirmed (but probably-right) footer VAT still fills, at honest low
    // confidence — fill-rate roughly preserved, precision raised.
    cascade: [vatResolve],
    ceilingEur: 0,
    stopConfidence: 0.6,
  },
  {
    field: 'email',
    // emailFromBody reads a DEEPENED extraction (homepage + contact/about
    // pages, merged by deep_pages.ts) — same-domain precision preserved, fill-rate
    // lifted for the ~half of IT SMB sites that hide the email off the homepage.
    // The pattern-guess tier (info@domain) is wired-but-DISABLED on purpose: with
    // dns_mx removed (0%-useful) an unverified guess is a precision risk on the
    // verified base. Activate only with a real
    // verifier (SMTP/finder API), and tag it as a distinct low-confidence source.
    target: 'email_inferred',
    role: 'EMAIL_FIND',
    cascade: [
      emailFromBody,
      // Pattern inference + MX/SMTP handshake — a "real verifier" for this field.
      // FREE, default-OFF (EMAIL_INFERENCE_MX_ENABLED). Fills only a
      // verified-deliverable,
      // non-catch-all address. Runs AFTER emailFromBody (a real body email wins).
      buildEmailInferenceStep(),
      hunterEmailStep(false), // real Hunter step, shipped DISABLED (flip to activate)
    ],
    ceilingEur: 0.05,
    stopConfidence: 0.75,
  },
  {
    field: 'pec',
    target: 'pec',
    role: 'OFFICIAL_COMPANY_DATA',
    // CONTRACT when activating pec.inipec_by_vat (or any VAT-keyed PEC fetch): the PEC is
    // keyed on a VAT that may belong to a DIFFERENT entity (franchisor/accountant). The
    // step MUST call isWrongEntity(fetchedRegisteredName, lead.company_name) and refuse on
    // mismatch — the same field-level guard fatturato uses — or it re-opens the wrong-entity
    // class (a franchisor's PEC attached to a local agency). pecFromBody is safe (same-domain).
    //
    // PROBED 2026-07-18 (V6): no free automatable source for PEC-by-VAT exists.
    // INI-PEC (the official index) gates search behind a native image+audio
    // captcha (a government service — not to be circumvented); ufficiocamerale.it
    // and registroaziende.it answer 403 (WAF); reportaziende.it requires login.
    // So this stays disabled: free PEC coverage is pecFromBody over deep pages,
    // and VAT-keyed PEC belongs to the PAID registro step (V8 Apify, pec incl.).
    cascade: [pecFromBody, disabled('pec.inipec_by_vat', 1, 0, 'inipec')],
    ceilingEur: 0,
    stopConfidence: 0.8,
  },
  {
    field: 'revenue',
    target: 'revenue',
    role: 'OFFICIAL_COMPANY_DATA',
    cascade: [fatturatoItaliaStep('revenue', 0.7)],
    ceilingEur: 0,
    stopConfidence: 0.7,
  },
  {
    field: 'employees',
    target: 'employees',
    role: 'OFFICIAL_COMPANY_DATA',
    cascade: [fatturatoItaliaStep('employees', 0.6)],
    ceilingEur: 0,
    stopConfidence: 0.6,
  },
  { field: 'instagram', target: 'instagram', role: 'SOCIAL_DETECT', cascade: [socialStep('instagram')], ceilingEur: 0, stopConfidence: 0.7 },
  { field: 'facebook', target: 'facebook', role: 'SOCIAL_DETECT', cascade: [socialStep('facebook')], ceilingEur: 0, stopConfidence: 0.7 },
  { field: 'linkedin', target: 'linkedin', role: 'SOCIAL_DETECT', cascade: [socialStep('linkedin')], ceilingEur: 0, stopConfidence: 0.7 },
  { field: 'tiktok', target: 'tiktok', role: 'SOCIAL_DETECT', cascade: [socialStep('tiktok')], ceilingEur: 0, stopConfidence: 0.7 },
  { field: 'youtube', target: 'youtube', role: 'SOCIAL_DETECT', cascade: [socialStep('youtube')], ceilingEur: 0, stopConfidence: 0.7 },
  {
    field: 'decision_maker',
    target: 'decision_maker_name',
    role: 'DECISION_MAKER',
    cascade: [decisionMakerFromBody, disabled('decision_maker.people_finder', 2, 0.1, 'people_finder')],
    ceilingEur: 0.15,
    stopConfidence: 0.6,
  },
];

export const FIELD_BY_NAME = new Map(FIELD_REGISTRY.map((d) => [d.field, d]));

function valueOr(v: string | undefined, source: string, confidence: number): StepResult {
  if (v && v.length > 0) return { value: v, confidence, source, costEur: 0 };
  return { confidence: 0, source, costEur: 0, skippedReason: 'no_value' };
}

/** Whether a field's free tier can resolve from a same-domain website body. */
export function fieldHasFreeTier(field: string): boolean {
  const d = FIELD_BY_NAME.get(field as never);
  return !!d && d.cascade.some((s) => s.tier === 0 && s.enabled);
}
