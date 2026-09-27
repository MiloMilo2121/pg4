/**
 * Single source of truth for "is this a PEC (certified e-mail) address?".
 *
 * PEC is a legal channel, never an outreach one, so it is routed to the `pec`
 * field and kept out of `email_inferred` / email-domain inference. The match is
 * on whole domain LABELS (each followed by at least one more label):
 *   - any label ENDING in `pec` — the providers' naming convention: pec,
 *     arubapec, lamiapec, registerpec, casellapec, gigapec, sicurpec, …
 *   - a known provider label that does not: legalmail(pa), postecert, cert, …
 * A bare substring test (`/pec/`) wrongly flagged business domains such as
 * `speciale.it`, `pecoraimmobiliare.it` or `spectrum.it`.
 *
 *   isPecAddress('amministrazione@pec.acme.it')  → true
 *   isPecAddress('acme@registerpec.it')         → true
 *   isPecAddress('info@pecoraimmobiliare.it')   → false
 */
const PEC_LABELS = [
  '[a-z0-9-]*pec',
  'legalmail',
  'legalmailpa',
  'postecert',
  'postacert',
  'pecimprese',
  'pecsicura',
  'sicurezzapostale',
  'actaliscertymail',
  'twtcert',
  'cert',
];

const PEC_ADDRESS_RE = new RegExp(`@(?:[a-z0-9-]+\\.)*(?:${PEC_LABELS.join('|')})\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*$`, 'i');

export function isPecAddress(email: string | undefined | null): boolean {
  return typeof email === 'string' && PEC_ADDRESS_RE.test(email.trim());
}
