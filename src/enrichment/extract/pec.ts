/**
 * Single source of truth for "is this a PEC (certified e-mail) address?".
 *
 * PEC is a legal channel, never an outreach one, so it is routed to the `pec`
 * field and kept out of `email_inferred` / email-domain inference. The match is
 * anchored on whole domain LABELS: a label equal to a known PEC provider name
 * (`pec`, `legalmail`, `arubapec`, `cert`, …) followed by at least one more
 * label. A bare substring test (`/pec/`) wrongly flagged business domains such
 * as `speciale.it`, `pecoraimmobiliare.it` or `spectrum.it`.
 *
 *   isPecAddress('amministrazione@pec.acme.it')  → true
 *   isPecAddress('acme@pec.aruba.it')           → true
 *   isPecAddress('acme@lamiapec.it')            → true
 *   isPecAddress('info@pecoraimmobiliare.it')   → false
 */
const PEC_LABELS = [
  'pec',
  'legalmail',
  'arubapec',
  'postecert',
  'postacert',
  'pecimprese',
  'legpec',
  'lamiapec',
  'mypec',
  'sicurezzapostale',
  'twtcert',
  'cert',
];

const PEC_ADDRESS_RE = new RegExp(`@(?:[a-z0-9-]+\\.)*(?:${PEC_LABELS.join('|')})\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*$`, 'i');

export function isPecAddress(email: string | undefined | null): boolean {
  return typeof email === 'string' && PEC_ADDRESS_RE.test(email.trim());
}
