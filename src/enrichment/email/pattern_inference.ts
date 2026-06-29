import { ItalianNerParser } from '../../discovery/website/hyper_guesser/italian_ner_parser';

/**
 * Email pattern inference — PURE, deterministic.
 *
 * Given a company name + its VERIFIED registrable domain (we already proved the
 * website is the firm's own, in the website-verification ladder), generate a
 * ranked list of plausible mailbox local-parts. This is the "segnali pattern per
 * fare inferenza" half of the email path; the MX/SMTP handshake
 * (`mx_smtp_verifier.ts`) is the gate that turns a guess into a fact. Nothing
 * here ever asserts an address on its own — a candidate only becomes
 * `email_inferred` after the verifier confirms it deliverable.
 *
 * Ranking principle (mirrors `pickBestEmail` in field_registry.ts): generic ROLE
 * inboxes (info@, contatti@) dominate Italian SMB reality and are NOT personal
 * data, so they always lead with the highest priors. PERSON patterns
 * (nome.cognome@) are emitted ONLY when a real person name is supplied
 * (decision_maker_name) — never invented from a brand token — and sit below the
 * role inboxes. The `prior` is an ORDERING signal (which to probe first), not a
 * confidence: confidence comes from the verifier's verdict.
 */

export interface EmailCandidate {
  /** The local-part (before the @). */
  localPart: string;
  /** Full address `localPart@domain`. */
  email: string;
  /** Pattern family — for evidence/debug. */
  pattern: 'role' | 'person.dot' | 'person.initial' | 'person.concat' | 'person.surname';
  /** Ordering prior 0..1 (NOT a confidence). Higher = probe first. */
  prior: number;
}

export interface InferenceInput {
  /** The firm's verified registrable domain (eTLD+1), e.g. "rossi.it". */
  domain: string;
  companyName?: string;
  /** A real decision-maker / owner name, if known. Person patterns need this. */
  personName?: string;
}

/** Generic role inboxes, near-universal on IT SMB domains. Not personal data. */
const ROLE_LOCALS: ReadonlyArray<{ local: string; prior: number }> = [
  { local: 'info', prior: 0.55 },
  { local: 'contatti', prior: 0.45 },
  { local: 'amministrazione', prior: 0.3 },
  { local: 'commerciale', prior: 0.25 },
  { local: 'segreteria', prior: 0.2 },
];

/**
 * Strip accents and reduce to the ASCII alnum form an email local-part allows.
 * "Niccolò D'Angelo" → "niccolo dangelo". Mirrors the NFD normalisation used
 * across the deduper / NER so keys stay consistent.
 */
function asciiName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '') // drop apostrophes so "D'Angelo" → "dangelo" (email convention)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convert a punycode/IDN or mixed-case domain to its ASCII (xn--) form. */
export function toAsciiDomain(domain: string): string | undefined {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!d || !d.includes('.')) return undefined;
  try {
    // url.domainToASCII via the WHATWG URL parser (no extra dep).
    const host = new URL(`https://${d}`).hostname;
    return host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split a person name into given + family parts. Returns undefined when the
 * input is not a usable two-part human name (so we never fabricate a person
 * pattern from a single brand token).
 */
function splitPersonName(name: string): { given: string; family: string } | undefined {
  const parts = asciiName(name).split(' ').filter((t) => t.length >= 2);
  if (parts.length < 2) return undefined;
  // Convention: first token = given name, last token = family name. Good enough
  // for the nome.cognome / n.cognome / cognome patterns; multi-part surnames
  // collapse to the last token (the common Italian mailbox convention).
  return { given: parts[0], family: parts[parts.length - 1] };
}

/** Person-derived local parts, only when a real person name is available. */
function personLocals(personName: string): Array<{ local: string; pattern: EmailCandidate['pattern']; prior: number }> {
  const p = splitPersonName(personName);
  if (!p) return [];
  return [
    { local: `${p.given}.${p.family}`, pattern: 'person.dot', prior: 0.35 },
    { local: `${p.given[0]}.${p.family}`, pattern: 'person.initial', prior: 0.3 },
    { local: `${p.given}${p.family}`, pattern: 'person.concat', prior: 0.2 },
    { local: p.family, pattern: 'person.surname', prior: 0.15 },
  ];
}

/**
 * Generate ranked candidate local-parts for a company. Role inboxes always;
 * person patterns only when `personName` is given. Deterministic + de-duplicated;
 * highest prior first.
 */
export function generateCandidates(input: InferenceInput): EmailCandidate[] {
  const domain = toAsciiDomain(input.domain);
  if (!domain) return [];

  const seen = new Set<string>();
  const out: EmailCandidate[] = [];
  const push = (local: string, pattern: EmailCandidate['pattern'], prior: number): void => {
    const lp = local.trim().toLowerCase();
    if (!lp || !/^[a-z0-9._-]+$/.test(lp) || seen.has(lp)) return;
    seen.add(lp);
    out.push({ localPart: lp, email: `${lp}@${domain}`, pattern, prior });
  };

  for (const r of ROLE_LOCALS) push(r.local, 'role', r.prior);

  // Person patterns: prefer an explicit decision-maker name; fall back to a
  // company name that is ITSELF a person name (NER yields exactly two brand
  // tokens and no descriptor — e.g. "Mario Rossi", not "Immobiliare Rossi").
  let personSource = input.personName;
  if (!personSource && input.companyName) {
    const ner = ItalianNerParser.parse(input.companyName);
    if (ner.descriptors.length === 0 && ner.brandTokens.length === 2) {
      personSource = ner.brandTokens.join(' ');
    }
  }
  if (personSource) {
    for (const c of personLocals(personSource)) push(c.local, c.pattern, c.prior);
  }

  return out.sort((a, b) => b.prior - a.prior);
}
