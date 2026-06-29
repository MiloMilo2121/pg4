# Legitimate Interest Assessment (LIA) — template

*Template only. NOT a completed assessment and NOT legal advice. The DPO/legal
owner completes, dates, and signs this before the lawful basis at checklist
item 0.1 can go GREEN. Italian B2B context (GDPR + d.lgs. 196/2003 as amended +
Provvedimenti del Garante).*

The three-part test must ALL pass for legitimate interest (Art. 6(1)(f)) to be
the lawful basis. If any part fails, do not rely on legitimate interest.

---

## 1. Purpose test — is there a legitimate interest?

- **Controller:** _______________________ (legal entity, P.IVA)
- **Interest pursued:** B2B prospecting — identifying companies whose published
  business profile matches a relevant commercial offer, and contacting them
  through business channels.
- **Is the interest real and present (not speculative)?** _______________
- **Whose interest?** Controller + (where applicable) the client on whose behalf
  processing occurs — name the relationship (controller / processor / joint).
- **Would a reasonable business expect this processing?** Note: B2B contact data
  published by the company itself (website, registry) carries a higher
  expectation of business contact than scraped personal data.

## 2. Necessity test — is the processing necessary for that interest?

- **Could the purpose be achieved with less data / a less intrusive means?**
  _______________
- **Data minimisation:** which fields are actually necessary for the outreach?
  pg4 distinguishes FREE-from-the-company's-own-page (email, PEC, P.IVA, socials)
  from inferred/paid data. List the fields in scope and justify each.
- **Sources:** company website (published by the data controller-company),
  PagineGialle, Google Maps, INI-PEC / Registro Imprese (official registries).
  Registry data has a defined public-purpose basis; note it per source.

## 3. Balancing test — does the interest override the data subject's rights?

- **Nature of the data:** business contact data of a legal person is NOT
  personal data; but a named person's email/PEC, a sole proprietor (ditta
  individuale), or a "nome.cognome@" address IS personal data — treat those
  rows under the higher standard.
- **Reasonable expectations:** would the individual behind a sole proprietorship
  expect cold B2B contact? Document the answer per data category.
- **Impact on the subject:** frequency caps, channel (business vs personal),
  immediate opt-out honoured (Art. 21).
- **Safeguards in place (technical):**
  - Per-tenant **suppression list** (Art. 21 objection → suppress, enforced
    pre-output in both pipeline stages).
  - **Retention** window enforced (Art. 5(1)(e)).
  - **Art. 14 notice** delivered (data not collected from the subject).
  - **RPO** check before any phone calling (incl. cell + sole proprietors).
  - **Provenance** recorded per field (`field_evidence`) so any subject's data
    is auditable and correctable (Art. 16).
- **Outcome:** interest overrides / does not override (circle one), with reasons.

---

## Decision

- **Lawful basis confirmed:** legitimate interest ☐ / other: __________
- **Conditions/limits imposed:** _______________________________________
- **Review date:** ____________
- **DPO / legal signature + date:** ____________________________________

> Until this is signed, the platform treats email enrichment as built-but-not-
> activated (Gate A). The free-gold extractor may *infer* a business email for
> internal display, but outreach to it is blocked behind this assessment.
