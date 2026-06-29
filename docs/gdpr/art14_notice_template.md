# Art. 14 Privacy Notice — template (data not obtained from the data subject)

*Template only, not legal advice. Complete + host at a stable URL; wire that URL
into every outreach message. Required because pg4 collects contact data from
third-party sources (company websites, directories, registries), NOT from the
data subject — Art. 14 GDPR applies. Provide within a reasonable period and at
the latest at first contact.*

---

## Informativa privacy (IT)

**Titolare del trattamento:** _________________ (ragione sociale, P.IVA, sede,
email/PEC del titolare).

**Dati trattati e origine.** Trattiamo dati di contatto aziendali (ragione
sociale, indirizzo, telefono, email/PEC, P.IVA, sito web, profili social
pubblici) raccolti da **fonti pubbliche**: il sito web della Sua azienda,
elenchi/directory di imprese, e registri ufficiali (es. INI-PEC, Registro
Imprese). Non abbiamo raccolto questi dati direttamente da Lei.

**Finalità e base giuridica.** Contatto commerciale B2B (prospecting) sulla base
del **legittimo interesse** del titolare (art. 6(1)(f) GDPR), come valutato in
un'analisi di bilanciamento documentata.

**Categorie di destinatari.** Fornitori che agiscono come responsabili del
trattamento (hosting/database, strumenti di invio, eventuali servizi di
arricchimento dati), vincolati da accordo ex art. 28.

**Conservazione.** I dati sono conservati per il periodo strettamente necessario
alla finalità (periodo definito: ______), poi cancellati o anonimizzati.

**I Suoi diritti.** Accesso, rettifica, cancellazione, limitazione, portabilità
e **opposizione (art. 21)**. Per opporsi o esercitare i diritti:
**[email/PEC dedicata]**. L'opposizione comporta l'inserimento immediato nella
nostra lista di soppressione e la cessazione dei contatti.

**Reclamo.** Ha diritto di proporre reclamo al **Garante per la protezione dei
dati personali** (www.gpdp.it).

**Trasferimenti extra-UE.** [Indicare se presenti + garanzie.]

---

## Privacy notice (EN — short form)

We process **business contact data** (company name, address, phone, email/PEC,
VAT, website, public social profiles) obtained from **public sources** (your
company website, business directories, official registries) — not from you
directly. **Lawful basis:** legitimate interest (Art. 6(1)(f)) for B2B
prospecting, per a documented balancing test. **Recipients:** Art. 28 processors
only. **Retention:** _____. **Your rights:** access, rectification, erasure,
restriction, portability, and **objection (Art. 21)** — contact **[address]**;
an objection immediately suppresses your data and stops contact. **Complaint:**
the Italian Garante (gpdp.it).

---

## Wiring (technical)

- Host this notice at a stable URL; include the link in every outreach message.
- An **objection** received → call `POST /api/suppression` with reason
  `art21_objection` (or `art14`), which writes a tenant-scoped suppression row;
  the engine drops the subject pre-output in both pipeline stages on the next run.
- Log the notice delivery + any objection as an `audit_events` row (Art. 30).
