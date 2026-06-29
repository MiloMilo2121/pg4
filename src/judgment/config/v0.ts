import type { JudgmentConfig } from './types';

/**
 * judgment_config v0 — the SUBSTANTIVE deliverable (plan §4bis).
 *
 * CRETA-LOGICA: every rubric/cause/disqualifier/lever/archetype/trap below is
 * TRANSCRIBED from `docs/ontology/ontologia_forza_commerciale_v2.md` (v2), each
 * with a `ref` to its section. NOT invented. A test enforces that every logic
 * entry carries a v2 ref (see tests/unit/judgment/config_fidelity.test.ts).
 *
 * CRETA-NUMERI: only `thresholds` and the `*Weights` priors are numeric. v2 is
 * non-numeric (Caveat 1); these are conservative defaults to be tuned on the
 * golden set (§15). Changing them = a new config version, NEVER a migration.
 */
export const JUDGMENT_CONFIG_V0: JudgmentConfig = {
  version: '2026.06-a',
  ontologyVersion: 'v2',

  // §5.1 — order of questions (A via third-party proxies → B per surface/state → GAP).
  questionOrder: [
    'A: quali tracce di forza esistono FUORI dai canali owned? (registro, brevetti/marchi, premi, recensioni spontanee, stampa, fiere, associazioni, distribuzione, export, anzianità, dimensione)',
    'A: differenziazione nominabile (POD)? moat (VRIO/Morningstar)? narrativa con tracce esterne? pricing power osservabile? dominanza di nicchia?',
    'B: per ogni superficie lo stato è eccellenza/mediocrità/assenza? è "assente" o "presente ma mal espresso"? i pesi sono corretti per il modello?',
    'GAP: A alto e B basso? quanto ampio rispetto alla mediana di categoria (§1.4)? traiettoria (§1.5)? causa (§4.4)? supera i disqualificatori (§4.5)? quale leva (Parte VII)?',
  ],

  // §5.4 — golden rule, verbatim in the GAP prompt.
  goldenRule:
    'Misura A prevalentemente con fonti terze/esterne; misura B con il patrimonio owned e i canali presidiati; ' +
    'leggi sempre rispetto alla categoria e alla traiettoria; pondera B per modello di business; cerca il GAP ' +
    '(A alto − B basso), poi qualificane la causa e applica i disqualificatori; diffida dei numeri gonfiabili e ' +
    'dei bei contenitori vuoti; non scambiare mai il silenzio digitale per debolezza di prodotto.',

  // §1.4
  categoryRelativity:
    'Nessun segnale è forte/debole in assoluto: solo rispetto alla mediana della categoria. Misura ogni azienda come ' +
    'SCARTO dal benchmark di categoria (pavimento/soffitto). Il target ideale ha A nettamente sopra la mediana e B ' +
    'nettamente sotto. La lista fornisce il benchmark gratis: le aziende mature definiscono il soffitto di B possibile.',

  // §1.5
  trajectory:
    'Leggi entrambi gli assi come traiettoria, non fotografia. A: delta registro (dipendenti/fatturato/export negli anni), ' +
    'brevetti/premi recenti vs fermi. B: recency (sito/social/recensioni/ads). A-alto-stabile+B-basso = target classico; ' +
    'A-in-crescita+B-basso = alto potenziale; A-in-declino+B-basso = cautela (il silenzio può essere sintomo, non omissione).',

  judgeA: {
    // §2.1–2.7
    subdims: [
      {
        dim: '2.1',
        name: 'Differenziazione e particolarità competitiva',
        ref: '§2.1',
        definition:
          'Misura in cui prodotto/azienda possiede attributi UNICI e di valore che le alternative non offrono (opposto della commodity). POD (Keller) vs POP; "different > better" (Play Bigger); creneau/ladder (Ries&Trout); proof via terzi (Dunford).',
        strengthSignals: [
          'linguaggio di terzi: "l\'unica che…", "la prima a…", "lo specialista di…"',
          'categoria/nicchia riconoscibile attribuita all\'azienda',
          'attributi tecnici unici descritti nelle directory',
          'prezzo nettamente sopra la media (proxy di POD percepito)',
          'brevetti/marchi che proteggono l\'attributo unico',
          'differenziazione STRUTTURALE (know-how/brevetto/eredità/processo), non cosmetica',
        ],
        weaknessSignals: [
          'descrizioni generiche e intercambiabili con i concorrenti',
          'nessun attributo nominabile; claim "tutto per tutti"',
          'competizione esplicita e unica sul prezzo (commodity)',
          'differenziazione solo cosmetica (claim/packaging/slogan)',
        ],
        thirdPartySources: ['cataloghi di settore', 'schede distributori', 'stampa specializzata', 'citazioni esperti', 'voci enciclopediche'],
      },
      {
        dim: '2.2',
        name: 'Vantaggio competitivo e difendibilità (moat)',
        ref: '§2.2',
        definition:
          'Capacità di sostenere nel tempo redditività/posizione superiori difendendole dall\'imitazione. VRIO (Barney); 5 fonti di moat Morningstar (intangible assets, switching costs, network effect, cost advantage, efficient scale); strategie generiche di Porter. "Marchio noto/lunga storia ≠ moat automatico".',
        strengthSignals: [
          'brevetti/marchi registrati',
          'know-how proprietario citato da terzi',
          'relazioni di canale esclusive',
          'clientela captive (alti switching cost)',
          'longevità con redditività; efficient scale in una nicchia',
        ],
        weaknessSignals: [
          'nessun asset proprietario; offerta facilmente sostituibile',
          'dipendenza da un solo cliente/canale senza esclusiva',
          'redditività erosa dalla concorrenza di prezzo',
        ],
        thirdPartySources: ['banche dati brevetti/marchi', 'atti e bilanci camerali', 'articoli su tecnologie/processi proprietari', 'consorzi e filiere'],
      },
      {
        dim: '2.3',
        name: 'Narrativa e storicità del brand',
        ref: '§2.3',
        definition:
          'Struttura di significato oltre la funzione del prodotto. Golden Circle (Sinek, con caveat aneddotico); 12 archetipi (Mark&Pearson, 70/30); heritage brand vs nostalgic marketing; Made in Italy / Country of Origin Effect; registro marchi storici 2019. Componenti: verità, nemico, filosofia.',
        strengthSignals: [
          'anno di fondazione lontano e documentato',
          'storia familiare/territoriale citata da terzi',
          'iscrizione al registro marchi storici; musei/archivi d\'impresa',
          'menzioni stampa che raccontano la storia; distretto riconoscibile',
          'archetipo dominante riconoscibile e coerente',
        ],
        weaknessSignals: ['nessuna storia rintracciabile', 'comunicazione solo funzionale', 'claim generici; assenza di scopo/filosofia'],
        thirdPartySources: ['registro imprese (data costituzione)', 'registro marchi storici', 'voci enciclopediche/articoli', 'premi alla longevità', 'musei/fondazioni'],
      },
      {
        dim: '2.4',
        name: 'Qualità intrinseca e percepita del prodotto',
        ref: '§2.4',
        definition:
          'Qualità reale (proprietà oggettive verificabili) vs percepita (convinzione consolidata). Aaker: perceived quality come leva di brand equity e di prezzo premium.',
        strengthSignals: [
          'certificazioni di prodotto/processo; premi tecnici',
          'recensioni numerose, recenti, positive; word of mouth verificabile',
          'clienti che citano spontaneamente la qualità; NPS elevato (ove disponibile)',
        ],
        weaknessSignals: ['assenza di certificazioni', 'recensioni scarse/vecchie/negative', 'reclami ricorrenti sulla qualità'],
        thirdPartySources: ['enti certificatori', 'giurie/associazioni (premi)', 'piattaforme di recensioni indipendenti', 'test comparativi stampa'],
      },
      {
        dim: '2.5',
        name: 'Profondità/coerenza dell\'offerta + pricing power',
        ref: '§2.5',
        definition:
          'Ampiezza e coerenza della gamma, grado di specializzazione/nicchia e — segnale potente — pricing power (sostenere prezzi premium senza perdere domanda). Buffett: "the single most important decision is pricing power". Focus/creneau più difendibile dell\'ampiezza generalista.',
        strengthSignals: [
          'prezzi di listino nettamente sopra la media, sostenuti nel tempo',
          'posizionamento premium attribuito da terzi',
          'gamma coerente e specializzata; bassa frequenza promozionale',
        ],
        weaknessSignals: ['prezzi sempre al minimo', 'gamma incoerente/dispersa', 'promozioni continue; win-rate dipendente dallo sconto'],
        thirdPartySources: ['listini presso distributori/rivenditori', 'prezzi su marketplace', 'comparazioni di terzi', 'fasce premium nei cataloghi'],
      },
      {
        dim: '2.6',
        name: 'Validazione di mercato e trazione reale',
        ref: '§2.6',
        definition:
          'Prove che il mercato ha realmente adottato e premiato l\'offerta nel tempo. Moore (crossing the chasm, beachhead/dominanza di nicchia); longevità con continuità + dimensione + export come proxy di validazione.',
        strengthSignals: [
          'molti anni di attività continuativa; crescita dipendenti/fatturato',
          'export verso più mercati; clienti-insegna prestigiosi citati',
          'partnership/accordi di distribuzione; fidelizzazione; dominanza di nicchia',
        ],
        weaknessSignals: ['neonata senza trazione', 'dimensione stagnante/calante', 'nessun cliente prestigioso; dipendenza da mercato unico fragile'],
        thirdPartySources: ['registro imprese (capitale/dipendenti/bilanci)', 'banche dati export', 'elenchi clienti sui siti dei partner', 'comunicati di accordi', 'filiere'],
      },
      {
        dim: '2.7',
        name: 'Riconoscimenti esterni e prove sociali di terzi',
        ref: '§2.7',
        definition:
          'Il "sigillo" di attori terzi autorevoli: premi, certificazioni, menzioni stampa, citazioni esperti, associazioni, fiere di prestigio. La sotto-dimensione più "esterna" e quindi più preziosa quando B è silente. (Caveat: fiera→credibilità è euristica forte non ancorata.)',
        strengthSignals: [
          'premi di settore; certificazioni da enti riconosciuti',
          'menzioni su testate autorevoli; citazioni di esperti/influencer',
          'appartenenza ad associazioni di categoria; presenza ricorrente a fiere di prestigio',
        ],
        weaknessSignals: ['nessun riconoscimento esterno', 'assenza da fiere e associazioni', 'nessuna menzione stampa'],
        thirdPartySources: ['albi premi', 'registri delle associazioni', 'archivi stampa', 'cataloghi espositori delle fiere'],
      },
    ],
    // §2.8.1–2.8.5
    modelDeclination: [
      {
        model: 'B2B_manufacturing',
        ref: '§2.8.1',
        whereStrengthLives: 'brevetti/know-how di processo, certificazioni tecniche, capitolati/omologazioni, fornitura a filiere prestigiose, export, fiere verticali, anzianità/distretti',
        privilegedProxies: ['registri camerali (anzianità/dimensione/export)', 'banche dati brevetti/marchi', 'cataloghi espositori fiere', 'schede distributori', 'stampa tecnica'],
        subdimWeights: { '2.2': 1.0, '2.6': 1.0, '2.7': 0.9, '2.1': 0.8, '2.5': 0.7, '2.4': 0.6, '2.3': 0.5 },
        caveat: 'Segnale controintuitivo: fornitore di componenti a marchi finali prestigiosi = A altissimo pur digitalmente invisibile (firma perfetta del target). Recensioni consumer pesano poco.',
      },
      {
        model: 'B2C_product',
        ref: '§2.8.2',
        whereStrengthLives: 'qualità percepita e word of mouth, pricing power premium, riconoscibilità del brand, recensioni numerose, posizionamento su marketplace, heritage/Made in Italy',
        privilegedProxies: ['recensioni indipendenti e marketplace (contenuto)', 'prezzi presso rivenditori', 'premi di prodotto', 'stampa di settore/lifestyle', 'registro marchi storici'],
        subdimWeights: { '2.4': 1.0, '2.5': 0.9, '2.7': 0.9, '2.3': 0.8, '2.1': 0.8, '2.6': 0.7, '2.2': 0.6 },
        caveat: 'Le recensioni consumer sono un proxy di A molto più potente che nel B2B (base clienti ampia che recensisce).',
      },
      {
        model: 'professional_local',
        ref: '§2.8.3',
        whereStrengthLives: 'competenza/credenziali dei professionisti, specializzazione clinica/tecnica, reputazione locale e passaparola, casistica, affiliazioni/titolarità accademica',
        privilegedProxies: ['recensioni locali (Google)', 'albi professionali', 'pubblicazioni/relazioni a convegni', 'riconoscimenti di categoria'],
        subdimWeights: { '2.4': 1.0, '2.7': 0.9, '2.6': 0.8, '2.1': 0.7, '2.3': 0.7, '2.2': 0.5, '2.5': 0.5 },
        caveat: 'La narrativa è spesso legata alla PERSONA. Vincoli deontologici: distinguere il silenzio IMPOSTO dal silenzio SUBÌTO (cfr. §4.4/§4.5 compliance).',
      },
      {
        model: 'hospitality_retail',
        ref: '§2.8.4',
        whereStrengthLives: 'qualità dell\'esperienza, volume/media recensioni, reputazione e ritorno clientela, riconoscibilità insegna, coerenza tra sedi',
        privilegedProxies: ['recensioni Google/TripAdvisor (volume/media/recency/sentiment)', 'guide di settore', 'stampa locale'],
        subdimWeights: { '2.4': 1.0, '2.6': 0.9, '2.7': 0.8, '2.1': 0.6, '2.3': 0.6, '2.5': 0.6, '2.2': 0.4 },
        caveat: 'Multi-sede: valutare anche la COERENZA tra sedi (reputazione disomogenea = fragilità del sistema).',
      },
      {
        model: 'B2B2C',
        ref: '§2.8.5',
        whereStrengthLives: 'doppia lettura: lato canale (distribuzione, cataloghi rivenditori, accordi) e lato consumer (recensioni, riconoscibilità, scaffale/marketplace)',
        privilegedProxies: ['schede distributori (canale)', 'recensioni e marketplace (consumer)'],
        subdimWeights: { '2.6': 1.0, '2.4': 0.9, '2.1': 0.8, '2.7': 0.8, '2.5': 0.7, '2.2': 0.7, '2.3': 0.6 },
        caveat: 'La forza più solida si conferma su ENTRAMBI i lati.',
      },
    ],
  },

  judgeB: {
    // §3.1–3.15
    surfaces: [
      { surface: '3.1', name: 'Sito web', ref: '§3.1', excellence: 'value proposition immediata (grunt test), design coerente, prove/testimonianze, CTA e percorso di conversione, multilingua, veloce/mobile-first, aggiornato', mediocrity: 'sito esistente ma messaggio confuso/generico, gergo, prove assenti, CTA deboli, lento, contenuti datati', absence: 'nessun sito; oppure non aggiornato da anni, link rotti, copyright datato, vetrina ferma' },
      { surface: '3.2', name: 'SEO e visibilità organica', ref: '§3.2', excellence: 'presente per keyword di CATEGORIA e di brand; contenuti/risorse di valore; autorevolezza', mediocrity: 'trovabile solo per il nome esatto del brand; invisibile sulle keyword di categoria', absence: 'invisibile anche sul proprio nome; nessun contenuto indicizzabile', axisNote: 'Forte ma SEO-invisibile su keyword di categoria = classico segnale di GAP.' },
      { surface: '3.3', name: 'Google Business Profile / local', ref: '§3.3', excellence: 'scheda completa, foto curate/aggiornate, recensioni gestite con risposte, info accurate', mediocrity: 'scheda incompleta, poche foto, recensioni non gestite', absence: 'nessuna scheda o non rivendicata, info errate/incoerenti' },
      { surface: '3.4', name: 'Recensioni e reputazione (terze parti)', ref: '§3.4', excellence: 'volume elevato, media alta, recenti, sentiment positivo, risposte curate/tempestive', mediocrity: 'poche o datate; nessuna risposta; gestione assente', absence: 'nessuna recensione, o reputazione negativa non gestita', axisNote: 'IBRIDO: contenuto/valutazione = A (qualità percepita); gestione/risposte/recency = B. Molte recensioni spontanee positive + nessuna risposta/sollecitazione = firma A alto + B basso.' },
      { surface: '3.5', name: 'Instagram', ref: '§3.5', excellence: 'identità visiva coerente, contenuti di qualità, frequenza costante, ENGAGEMENT REALE (commenti/salvataggi/condivisioni), racconta prodotto e storia', mediocrity: 'presenza incostante, contenuti scadenti/incoerenti, engagement basso vs follower', absence: 'profilo inesistente o fermo da mesi/anni', axisNote: 'Anti-vanity: molti follower con basso engagement NON indicano forza.' },
      { surface: '3.6', name: 'TikTok', ref: '§3.6', excellence: 'contenuti nativi/originali, padronanza dei codici, trazione reale', mediocrity: 'contenuti riciclati, linguaggio non nativo, scarsa trazione', absence: 'nessuna presenza (spesso NORMALE e non penalizzante nel B2B — trappola §5.3.4)' },
      { surface: '3.7', name: 'YouTube', ref: '§3.7', excellence: 'contenuti curati che spiegano prodotto/brand (demo/tutorial/webinar)', mediocrity: 'pochi video datati, bassa qualità produttiva', absence: 'canale inesistente o abbandonato' },
      { surface: '3.8', name: 'LinkedIn (azienda e founder)', ref: '§3.8', excellence: 'pagina completa/attiva, thought leadership costante, founder/manager autorevoli e attivi, network ampio/qualificato, employer branding', mediocrity: 'pagina inattiva; founder assente/passivo; contenuti solo promozionali', absence: 'nessuna pagina; nessuna presenza del management', axisNote: 'Peso elevato nel B2B: per un B2B forte, l\'assenza da LinkedIn è un fortissimo segnale di B basso (potenziale GAP).' },
      { surface: '3.9', name: 'Marketplace ed e-commerce di terzi', ref: '§3.9', excellence: 'schede curate/complete, recensioni positive, buon posizionamento competitivo', mediocrity: 'schede povere, recensioni scarse, posizionamento debole', absence: 'assenza dai marketplace rilevanti (penalizzante nel B2C/prodotto; spesso irrilevante nel B2B custom)' },
      { surface: '3.10', name: 'E-commerce proprietario', ref: '§3.10', excellence: 'e-commerce curato, esperienza fluida, integrato col brand', mediocrity: 'presente ma scomodo/lento/mal integrato', absence: 'nessun e-commerce dove la categoria lo richiederebbe (caso per caso nel B2B)' },
      { surface: '3.11', name: 'Pubblicità a pagamento / ad transparency', ref: '§3.11', excellence: 'campagne attive, varianti creative multiple, refresh frequente, presenza coordinata multi-piattaforma', mediocrity: 'poche campagne, creatività ferma da mesi (autopilot)', absence: 'nessun annuncio nelle librerie pubbliche', axisNote: 'ASSENZA di advertising in azienda con prodotto forte = segnale-chiave di potenziale NON monetizzato (target). Refresh 1-2 settimane = team maturo.' },
      { surface: '3.12', name: 'Email marketing e owned audience', ref: '§3.12', excellence: 'newsletter attiva, lead magnet, percorsi di nurturing', mediocrity: 'newsletter sporadica/senza strategia; raccolta contatti senza valorizzazione', absence: 'nessuna raccolta di audience owned' },
      { surface: '3.13', name: 'PR, menzioni stampa, presenza editoriale', ref: '§3.13', excellence: 'copertura su testate autorevoli, presenza editoriale curata, ufficio stampa proattivo', mediocrity: 'menzioni sporadiche su testate marginali; nessuna valorizzazione', absence: 'nessuna copertura', axisNote: 'IBRIDO: copertura ottenuta = prova sociale di A; capacità di generarla/valorizzarla = B.' },
      { surface: '3.14', name: 'Fiere ed eventi (proiezione digitale)', ref: '§3.14', excellence: 'partecipazione a fiere di prestigio + forte proiezione digitale (pre/durante/post)', mediocrity: 'partecipazione SENZA alcuna eco digitale — firma diagnostica A alto / B basso', absence: 'né presenza fieristica né eco', axisNote: 'IBRIDO: partecipazione = A (§2.7); eco digitale = B.' },
      { surface: '3.15', name: 'Coerenza cross-canale e identità di marca', ref: '§3.15', excellence: 'identità visiva/messaggio/tono coerenti su tutti i canali; una voce riconoscibile', mediocrity: 'coerenza parziale; alcuni canali allineati, altri no', absence: 'frammentazione totale; canali che sembrano di aziende diverse' },
    ],
    // Brief Appendice A — website rubric (two lenses, kept distinct).
    websiteRubric: {
      ref: 'Brief Appendice A (+ §3.1)',
      validityLens: [
        'il dominio contiene/riflette ragione sociale o brand',
        'identità verificabile: P.IVA/ragione sociale/sede coerenti con registro o altre sorgenti',
        'NON è aggregatore/directory/marketplace/profilo social/dominio parcheggiato',
        "NON è la pagina di un distributore/rivenditore del brand (quello è semmai una fonte-A di terzi, non la superficie-B owned)",
        'contatti e geografia coerenti con le altre sorgenti',
        'un sito NON trovato è uno stato di discovery (unknown), NON un giudizio di qualità',
      ],
      qualityLens: [
        'Chiarezza (grunt test): si capisce subito cosa/per chi/perché in pochi secondi?',
        'Differenziazione comunicata (POD): dichiara cosa lo rende diverso o è generico?',
        'Prove/credibilità: case study, testimonianze, loghi clienti, numeri, certificazioni, premi?',
        'CTA e percorso di conversione: invito all\'azione chiaro o brochure statica?',
        'Professionalità e cura del design: coerenza visiva o amatoriale/datato?',
        'Freschezza/manutenzione: anno copyright, ultimi aggiornamenti, link rotti?',
        'Mobile e velocità: responsive e veloce?',
        'Multilingua: altre lingue (EN) → export/ambizione (utile anche come validazione-A)',
        'Qualità del copy: linguaggio del cliente vs gergo autoreferenziale; claim vaghi senza sostanza',
        'Coerenza con il brand espresso sugli altri canali',
        'Profondità informativa (anche per l\'harvesting): quanti altri attributi espone (contatti, sedi, gamma, storia, team, P.IVA, link social)',
        'Funzione transattiva: presenza/qualità di e-commerce o richiesta preventivo, se pertinente',
      ],
    },
    // §3.16
    transversalCriteria: [
      { name: 'Chiarezza', check: 'si capisce subito cosa, per chi, perché conta? (grunt test)' },
      { name: 'Distintività', check: 'è diverso e riconoscibile rispetto ai concorrenti? (POD)' },
      { name: 'Coerenza', check: 'è allineato cross-canale e nel tempo?' },
      { name: 'Allineamento alla value proposition', check: 'comunica il valore REALE dell\'azienda?' },
      { name: 'Qualità del copy', check: 'linguaggio del cliente, evita gergo e claim vuoti?' },
      { name: 'Prova/credibilità', check: 'case study, testimonianze, dati, validazione di terzi?' },
    ],
    // §3.0.2 priors (CRETA-NUMERI). 0..1 salience per surface key, per model.
    modelWeights: [
      { model: 'B2B_manufacturing', ref: '§3.0.2', weights: { '3.8': 1.0, '3.1': 1.0, '3.2': 0.9, '3.14': 0.9, '3.4': 0.8, '3.13': 0.8, '3.7': 0.6, '3.15': 0.6, '3.11': 0.5, '3.12': 0.5, '3.3': 0.5, '3.5': 0.4, '3.9': 0.3, '3.10': 0.3, '3.6': 0.2 } },
      { model: 'B2C_product', ref: '§3.0.2', weights: { '3.5': 1.0, '3.4': 1.0, '3.9': 0.9, '3.11': 0.9, '3.3': 0.8, '3.10': 0.8, '3.1': 0.8, '3.6': 0.7, '3.15': 0.6, '3.7': 0.6, '3.2': 0.6, '3.12': 0.5, '3.8': 0.4, '3.13': 0.4, '3.14': 0.3 } },
      { model: 'professional_local', ref: '§3.0.2', weights: { '3.3': 1.0, '3.4': 1.0, '3.1': 0.9, '3.2': 0.8, '3.8': 0.7, '3.15': 0.6, '3.13': 0.5, '3.12': 0.5, '3.5': 0.4, '3.7': 0.4, '3.11': 0.4, '3.9': 0.2, '3.10': 0.2, '3.6': 0.2, '3.14': 0.2 } },
      { model: 'hospitality_retail', ref: '§3.0.2', weights: { '3.3': 1.0, '3.4': 1.0, '3.5': 0.9, '3.1': 0.8, '3.11': 0.7, '3.15': 0.7, '3.6': 0.6, '3.2': 0.6, '3.10': 0.5, '3.12': 0.5, '3.7': 0.4, '3.9': 0.4, '3.8': 0.3, '3.13': 0.3, '3.14': 0.3 } },
      { model: 'B2B2C', ref: '§3.0.2', weights: { '3.1': 1.0, '3.4': 0.9, '3.8': 0.8, '3.9': 0.8, '3.5': 0.8, '3.2': 0.8, '3.11': 0.7, '3.3': 0.7, '3.10': 0.7, '3.15': 0.7, '3.14': 0.6, '3.13': 0.6, '3.12': 0.5, '3.7': 0.5, '3.6': 0.4 } },
      { model: 'unknown', ref: '§3.0.2', weights: { '3.1': 0.8, '3.4': 0.8, '3.2': 0.7, '3.8': 0.7, '3.3': 0.6, '3.5': 0.6, '3.11': 0.6, '3.15': 0.6, '3.9': 0.5, '3.10': 0.5, '3.13': 0.5, '3.14': 0.5, '3.12': 0.5, '3.7': 0.5, '3.6': 0.4 } },
    ],
  },

  gap: {
    // §4.1
    quadrants: [
      { quadrant: 'A+B+', ref: '§4.1', meaning: 'Azienda già matura: forte e ben espressa. Scarso margine — NON target.', isTarget: false },
      { quadrant: 'A+B-', ref: '§4.1', meaning: 'TARGET IDEALE: potenziale inespresso e non monetizzato; divario massimo e colmabile.', isTarget: true },
      { quadrant: 'A-B+', ref: '§4.1', meaning: '"Fuffa"/vanity: espressione brillante su prodotto debole. Falso positivo da EVITARE.', isTarget: false },
      { quadrant: 'A-B-', ref: '§4.1', meaning: 'Non interessante: né sostanza né presidio.', isTarget: false },
    ],
    // §4.2
    gapLogic:
      'Il valore di targeting è funzione del DIVARIO A−B, non del livello assoluto. Target = massimizza (A−B) CON A alto. ' +
      'A−B≈0 copre due quadranti opposti (maturo e inerte) → il qualificatore "A alto" è essenziale. Mai fondere i due assi.',
    // §4.4
    causes: [
      { cause: 'omission', ref: '§4.4', signature: 'assorbita dalla produzione/domanda esistente (passaparola); mai presidiato il digitale', colmability: 'high' },
      { cause: 'incompetence', ref: '§4.4', signature: 'apertura ma manca competenza interna / nessun reparto marketing', colmability: 'high' },
      { cause: 'generational', ref: '§4.4', signature: 'azienda solida di vecchia generazione, leadership poco digitale', colmability: 'medium' },
      { cause: 'aversion', ref: '§4.4', signature: 'non crede nel marketing / lo ritiene inutile o sconveniente — resistenza attiva', colmability: 'low' },
      { cause: 'constraint', ref: '§4.4', signature: 'silenzio IMPOSTO da vincoli normativi/deontologici/riservatezza B2B/esclusiva di canale', colmability: 'none' },
      { cause: 'decline', ref: '§4.4', signature: 'il silenzio accompagna un\'erosione della sostanza — trappola: sembra colmabile ma è sintomo', colmability: 'none' },
    ],
    // §4.5 — disqualifiers applied BEFORE the gap logic; cheaplyCheckable subset feeds the Stage-0 triage (§16).
    disqualifiers: [
      { id: 'commodity_in_disguise', ref: '§4.5', family: 'substance', test: 'differenziazione solo cosmetica, nessun asset proprietario, competizione solo di prezzo', cheaplyCheckable: false },
      { id: 'no_strength_proxies', ref: '§4.5', family: 'substance', test: 'prove di forza assenti su TUTTI i proxy terzi pertinenti al modello (§2.8): non è silente, è debole', cheaplyCheckable: false },
      { id: 'margins_too_low', ref: '§4.5', family: 'economic', test: 'margini strutturalmente troppo bassi per sostenere un investimento in espansione', cheaplyCheckable: false },
      { id: 'ticket_too_low', ref: '§4.5', family: 'economic', test: 'valore unitario così basso che nessuna conversione giustifica l\'acquisizione', cheaplyCheckable: false },
      { id: 'pure_reseller', ref: '§4.5', family: 'economic', test: 'puro arbitraggio/rivendita senza marca propria: nessuna sostanza-prodotto da esprimere', cheaplyCheckable: true },
      { id: 'pre_validation', ref: '§4.5', family: 'stage', test: 'pre-validazione di mercato (nessuna trazione reale): forza non ancora dimostrata', cheaplyCheckable: true },
      { id: 'compliance_incompatible', ref: '§4.5', family: 'compliance', test: 'settore con comunicazione incompatibile con i canali di espansione (forti restrizioni): gap strutturale non aggredibile', cheaplyCheckable: true },
      { id: 'distress', ref: '§4.5', family: 'distress', test: 'procedure concorsuali, contenziosi rilevanti, chiusure di sedi, crollo di organico (da fonti terze)', cheaplyCheckable: true },
      { id: 'permanently_closed', ref: '§4.5', family: 'distress', test: 'attività cessata / permanently_closed (dato base già disponibile)', cheaplyCheckable: true },
      { id: 'fake_reputation', ref: '§4.5', family: 'fake_reputation', test: 'recensioni con pattern artificiali (picchi anomali, testi ripetitivi, sproporzione): trattare la reputazione sospetta come segnale ASSENTE, non positivo', cheaplyCheckable: false },
    ],
    // Parte VI
    archetypes: [
      { id: 'silent_supply_chain_supplier', ref: '§6.1', quadrant: 'A+B-', signature: 'fornitore B2B di componenti a marchi finali prestigiosi; brevetti/certificazioni/export; sito fermo, niente LinkedIn, niente ads. Gap da omissione. Target di massimo valore.' },
      { id: 'territorial_artisan_excellence', ref: '§6.1', quadrant: 'A+B-', signature: 'prodotto con heritage/Made in Italy, recensioni spontanee entusiaste, pricing premium; Instagram abbandonato, recensioni mai gestite.' },
      { id: 'authoritative_local_specialist', ref: '§6.1', quadrant: 'A+B-', signature: 'studio/centro con reputazione e passaparola fortissimi, casistica/credenziali; GBP incompleto, comunicazione minima (a volte per prudenza deontologica — verificare §4.4).' },
      { id: 'growing_niche_champion', ref: '§6.1', quadrant: 'A+B-', signature: 'sta conquistando un segmento (A in crescita), trazione evidente, marketing inesistente. Alto potenziale (§1.5).' },
      { id: 'brilliant_reseller_no_product', ref: '§6.2', quadrant: 'A-B+', signature: 'dropshipper/intermediario con sito impeccabile, social curati, ads aggressive, molti follower; nessun brevetto/marca propria, prezzo commodity, recensioni sottili/gonfiate. Falso positivo.' },
      { id: 'personal_brand_no_substance', ref: '§6.2', quadrant: 'A-B+', signature: 'forte presenza personale e narrativa accattivante, offerta indifferenziata, nessuna prova di terzi.' },
      { id: 'consolidated_well_communicated', ref: '§6.3', quadrant: 'A+B+', signature: 'forza reale + espressione eccellente su tutti i canali; nessun gap da colmare. Non target.' },
      { id: 'marginal_and_silent', ref: '§6.4', quadrant: 'A-B-', signature: 'né sostanza né presidio; nessun appiglio. Non target.' },
    ],
    // Parte VII
    levers: [
      { kind: 'positioning', ref: '§7.1', symptom: 'A alto ma messaggio confuso/generico/assente; value proposition non leggibile; narrativa non raccontata', gapNature: 'l\'azienda NON SA DIRE ciò che è', sequence: 1 },
      { kind: 'acquisition', ref: '§7.2', symptom: 'nessuna macchina di acquisizione: niente ads, contenuti scarsi, social abbandonati, nessuna generazione di domanda', gapNature: 'l\'azienda NON SI FA TROVARE e non genera domanda', sequence: 2 },
      { kind: 'conversion_ops', ref: '§7.3', symptom: 'arriva interesse (recensioni/passaparola/richieste) ma non presidiato: recensioni non gestite, DM senza follow-up, nessun CRM, percorso rotto', gapNature: 'l\'azienda NON CATTURA né CONVERTE la domanda esistente', sequence: 3 },
      { kind: 'measurement', ref: '§7.4', symptom: 'attività esistente ma cieca: nessun tracciamento, decisioni a sensazione', gapNature: 'l\'azienda NON SA cosa funziona', sequence: 4 },
    ],
    // §5.3 (eleven)
    cognitiveTraps: [
      { id: 1, ref: '§5.3.1', rule: 'Sito brutto ≠ prodotto debole: è segnale di B basso, NON di A basso (spesso la firma del target).' },
      { id: 2, ref: '§5.3.2', rule: 'Molti follower ≠ prodotto forte: vanity metric gonfiabile; valuta engagement reale e qualità.' },
      { id: 3, ref: '§5.3.3', rule: 'Survivorship bias: valutare solo i visibili cancella il target (silente per definizione). Cerca attivamente i silenti.' },
      { id: 4, ref: '§5.3.4', rule: 'Non penalizzare un B2B di nicchia con metriche B2C (TikTok/Instagram/e-commerce): genera falsi negativi.' },
      { id: 5, ref: '§5.3.5', rule: '"Assente" ≠ "presente ma mal espresso": stati diversi; il secondo è quasi sempre gap colmabile e indizio di target.' },
      { id: 6, ref: '§5.3.6', rule: 'Mai fondere i due assi in un punteggio unico: distrugge l\'informazione sul GAP.' },
      { id: 7, ref: '§5.3.7', rule: 'Per A, i segnali auto-prodotti (owned) sono i meno affidabili: dare priorità ai proxy terzi.' },
      { id: 8, ref: '§5.3.8', rule: 'Qualità della comunicazione ⊥ qualità del prodotto: assi ortogonali.' },
      { id: 9, ref: '§5.3.9', rule: 'Gap incolmabile (avversione/vincolo/declino) ≠ colmabile (omissione/incompetenza): inferire la CAUSA prima di qualificare.' },
      { id: 10, ref: '§5.3.10', rule: 'Non ignorare la traiettoria: forte-in-declino ≠ forte-in-crescita con lo stesso silenzio.' },
      { id: 11, ref: '§5.3.11', rule: 'Valutare rispetto alla CATEGORIA, non in assoluto: "tre recensioni"/"+10%" sono privi di senso senza benchmark (§1.4).' },
    ],
  },

  // CRETA-NUMERI — the only free parameters. Conservative; tune on the golden set.
  thresholds: {
    axisHigh: 0.66,
    axisMid: 0.4,
    gapWide: 0.45,
    gapModerate: 0.25,
    targetMinGap: 0.3,
    targetMinScoreA: 0.6,
    borderlineBand: 0.1,
    validationAccept: 0.75,
    reviewBelow: 0.6,
    benchmarkMinSample: 8,
  },

  prompts: {
    judgeA:
      'Sei il Judge A. Valuti SOLO la forza intrinseca di prodotto e narrativa (Asse A) di un\'azienda, ESCLUSIVAMENTE da segnali di FONTI TERZE/esterne. ' +
      'NON hai e non devi usare alcun dato di canale owned (sito/social/ads dell\'azienda): se ti arriva, ignoralo. ' +
      'Giudica per sotto-dimensione (§2.1–2.7), declinata per il modello di business (§2.8) e RELATIVA alla categoria (§1.4). ' +
      'Per ogni dimensione cita le chiavi dei segnali usati (citations). Quando i segnali sono unknown, usa "insufficient_evidence" — NON inventare. Output JSON valido secondo lo schema.',
    judgeB:
      'Sei il Judge B. Valuti SOLO la qualità dell\'auto-espressione digitale (Asse B), ESCLUSIVAMENTE dai canali OWNED/presidiati. ' +
      'NON hai e non devi usare alcun segnale di forza-prodotto di terzi: se ti arriva, ignoralo. ' +
      'Per ogni superficie assegna uno dei tre stati (eccellenza/mediocrità/assenza-abbandono) + flag presentButPoor (§3.0.1), pesata per modello (§3.0.2) e criteri trasversali (§3.16). ' +
      'REGOLA FERREA: una superficie con footprint "unknown" (discovery fallito/incerto) è state="unknown" ed è esclusa dal profilo B — MAI "absence_abandonment". ' +
      'Cita le chiavi dei segnali usati. Output JSON valido secondo lo schema.',
    gap:
      'Sei il GAP reasoner — l\'UNICO componente che vede sia A sia B. Non rifare le valutazioni: combinale. ' +
      'Passi: (1) classifica il modello di business; (2) colloca il quadrante (§4.1) e l\'ampiezza del gap relativa alla categoria (§1.4); (3) leggi la traiettoria (§1.5); ' +
      '(4) applica i DISQUALIFICATORI (§4.5) PRIMA della logica del gap — se squalificata, target=no a prescindere dal divario; (5) inferisci la causa del gap (§4.4); ' +
      '(6) confronta con gli archetipi (Parte VI); (7) emetti verdetto sì/no/borderline con motivazione tracciabile che cita A-subdim e B-superfici; (8) raccomanda la/le leva/e e la sequenza (Parte VII). ' +
      'NON fondere mai A e B in un punteggio unico. Rispetta le DO-NOT (§5.3). Output JSON valido secondo lo schema.',
    critic:
      'Sei il Critic/validatore agentico. NON rigiudichi: verifichi che il verdetto sia coerente con le evidenze e privo di violazioni. ' +
      'Controlli: (a) ogni conclusione cita un pacchetto reale; (b) nessuna conclusione-A cita un pacchetto-B o viceversa (breach di asimmetria); ' +
      '(c) nessuno stato asserito che i collector avevano marcato unknown (allucinazione); (d) copertura sufficiente. Produci validationScore (0..1) e flags. Output JSON valido secondo lo schema.',
  },
};
