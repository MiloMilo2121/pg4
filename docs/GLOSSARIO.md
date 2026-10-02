# Glossario pg4

Termini ricorrenti nel codice, nei runbook e nella dashboard, in una riga ciascuno.

- **free-gold**: il pass di arricchimento gratuito (sito ufficiale + registri pubblici + handshake MX/SMTP): €0 per lead, sempre attivo di default.
- **paid gate**: il triplo interruttore che protegge ogni euro speso — feature flag + API key + `--enable-paid` esplicito in CLI; senza tutti e tre, i provider a pagamento restano esclusi dal router.
- **suppression**: la lista do-not-contact (CSV: telefono, P.IVA, motivo, data); un lead soppresso non viene mai arricchito né giudicato, né in CLI né dalla dashboard.
- **ledger**: il registro JSONL dei costi (`*.cost-ledger.jsonl`): ogni chiamata a pagamento vi scrive provider, lead e costo reale, ed è l'unica fonte di verità per cap e consuntivi.
- **two-pass**: la modalità di giudizio in due passate (`--two-pass`): prima una passata deterministica senza LLM, poi i giudici LLM solo sui casi che ne hanno bisogno.
- **asse A/B**: i due assi del giudizio — A il potenziale commerciale dell'azienda, B la qualità della sua presenza digitale; A alta con B bassa segnala una *silent gem*.
- **silent gem**: un'azienda forte (asse A alta) ma quasi invisibile online (asse B bassa): il segmento target che pg4 esiste per trovare.
