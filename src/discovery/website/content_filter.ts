/**
 * Pure functions for classifying URLs and HTML content. Ported from
 * pg3/src/enricher/core/discovery/content_filter.ts but exposed as plain
 * functions instead of a class.
 */

/**
 * Hosts that must NEVER be stored as `official_website`.
 *
 * Phase 3.7 audit of pg3 outputs (`MASTER_WITH_WEBSITE.csv`, 1700 rows)
 * found ~25% of records with `website` set to one of these. They polluted
 * downstream enrichment, decision-maker discovery, and final outreach
 * lists. See `docs/legacy_failure_taxonomy.md` §2.
 */
const DIRECTORIES = new Set([
  // Search engines — never the answer to "what's the company's website?"
  'google.com', 'google.it', 'bing.com', 'duckduckgo.com', 'lite.duckduckgo.com',

  // Italian phone / business directories
  'paginegialle.it', 'paginebianche.it', 'yelp.it', 'yelp.com', 'tripadvisor.it',

  // Social / messaging — including PG-generated "click to chat" surfaces
  'facebook.com', 'instagram.com', 'linkedin.com', 'linkedin.it', 'twitter.com', 'x.com',
  'wa.me', 'whatsapp.com', 'api.whatsapp.com', 'chat.whatsapp.com',
  't.me', 'telegram.me', 'linktr.ee', 'maps.app.goo.gl', 'g.page', 'm.me', 'messenger.com',

  // Italian aggregators / directory portals
  'virgilio.it', 'aziende.virgilio.it', 'kompass.com', 'europages.com',
  'misterimprese.it', 'prontopro.it', 'prontoimprese.it', 'habitissimo.it',
  // Phase E.1 (p72 VR audit) — directory portals that bypassed the
  // SerpDeduplicator and got accepted as official_website. Same family
  // as inelenco.com from earlier audits. Each manually verified to
  // serve "<lead>/azienda/..." or "<lead>/informazioni-dettagliate/..."
  // listing URLs, not the firm's own site.
  'coobiz.it', 'italialei.it', 'inelenco.com',
  // Phase G.1 (p90 PD Serper audit) — paid SERP returned dozens of
  // listing-aggregator hosts that BL/TV/VR/PD free providers never
  // surfaced. Each one observed in p90 SERP_PAID matches as a
  // listing/profile page rather than the firm's own site.
  'cercacasa.it',                  // agency-listing portal
  'atoka.io',                       // company-data aggregator
  'agentiimmobiliariabilitati.it',  // FIAIP-adjacent listing
  'padovamls.it',                  // local MLS aggregator
  'portaleagenzieimmobiliari.it',  // listing portal
  'infoisinfo.it',                 // generic business directory
  'oikia.it',                      // real-estate directory
  'companyreports.it',             // company-data aggregator
  'gowork.it',                     // job/business directory
  'ioaffitto.it',                  // rental listings portal
  'fiaipveneto.it',                // professional association directory
  'anacipadova.it',                // condominium-admins directory
  'immobiliweb.com',               // agency-listing portal
  'reportazienda.it',              // company-data aggregator
  'tellows.it',                    // phone reverse-lookup
  'bachecacase.com',               // listing aggregator
  'risorseimmobiliari.it',         // listing aggregator
  'realadvisor.it',                // listing aggregator
  'distrettodelbacchiglione.it',   // local territory portal
  'mia-azienda.com', 'visurissima.it', 'reteimprese.it',
  // Phase G.1 — Italian wrong-sector / public-admin hosts seen as
  // p90 FPs because they happen to mention the company name in some
  // page (e.g. employee bio, condo admin list, encyclopedia entry).
  // These are never a real-estate-agency website.
  'treccani.it',                   // encyclopedia
  'unipd.it',                      // university (incl. subdomains)
  'consorziopadovaovest.it',       // public consortium
  'pickandroll.it',                // basketball news
  'bed-and-breakfast.it',          // B&B portal
  'helvetia.com',                  // insurance multinational
  'bonaldo.com',                   // furniture brand
  'wordpress.com',                 // generic blog hosting
  'pd.camcom.it', 'vi.camcom.it',  // chambers of commerce
  // R6.1 (p_recal2 PD audit) — SERP_COMPANY FPs surfaced after the
  // PgDetailStage semantic-veto + cache fixes increased free-pass
  // recall. Each manually verified via WebFetch.
  'luxuryestate.com',              // global luxury-listing aggregator
  'netcenterpadova.eu',            // Padova business-center / coworking
  'itpres.com',                    // weak HG candidate (Italy Prime
                                    // Estates "itpres.com" — appears as
                                    // generic Italian-prestige domain)
  // R7.1 (paid PD audit) — Serper-induced FP class: business-data
  // aggregators that publish the firm's P.IVA in a directory entry,
  // satisfying piva_match without being the firm's own site. Each
  // manually verified via WebFetch in scripts/extract_gains audit.
  'aziende.it',                    // Ad Intend Srl — Italian business-data aggregator
  'eulerpool.com',                 // German financial-data aggregator
  'gestionaleimmobiliare.it',      // generic real-estate sales-software portal
  'xrayfinance.it',                // financial-data aggregator
  'dbiz.it',                       // METRIKS.AI — Italian business directory
  'sahibkimdir.com',               // Turkish phone/business lookup portal
  'creditsafe.com',                // credit-reporting / business-data aggregator
  'openbdap.rgs.mef.gov.it',       // Italian Min. Economia public-admin DB
  'bur.regione.veneto.it',         // Bollettino Ufficiale Regione Veneto
  'comunichiamoimpresa.it',        // Italian state-aid disclosure registry
  'amministrazionicomunali.it',    // Italian municipal-tax tools portal
  // R7.1 (paid PD audit) — wrong-sector cross-publishing: same legal
  // entity (P.IVA) operates a non-real-estate business. Adding by
  // host because the lead's vat happens to match these pages and
  // there's no cheaper way to distinguish. 1-off but unambiguous.
  'lafemmestore.eu',               // women's clothing store — same vat as a
                                    // Retecasa Vigonza lead (owner has multiple businesses)
  'centrobachelet.org',            // community center / non-profit — wrong sector
  // R7.1.b (paid PD round-2 audit) — public-administration / transport
  // sites that publish business data for their own purposes. Distinct
  // class from aggregators: govt portals + state-owned operators.
  'opencoesione.gov.it',           // Italian govt PNRR / cohesion-funds tracker
  'fsbusitalia.it',                // Gruppo FS Italiane bus operator (public transport)
  'provincia.pd.it',               // Provincia di Padova administrative site
  // R7.1.c (paid PD round-3 audit) — final residuals: municipal
  // service portals, research institutes, and a reviews aggregator
  // that surfaced in the free pass after the paid blocklist
  // tightened. Each manually verified.
  'servizi.comune.albignasego.pd.it', // Comune di Albignasego service portal
  'ac.infn.it',                     // Istituto Nazionale di Fisica Nucleare (national research)
  'italiarecensioni.com',           // Italian business-reviews aggregator
  // R8.1.BL audit — generalization run on Belluno province surfaced
  // 6 paid FPs (precision 67/73 = 91.8 % — above target). Two new
  // host families:
  'telefonforsaljare.nu',           // Swedish phone-spam aggregator (×5 in BL)
  'generali.it',                    // Generali insurance group (covers
                                    // agenzie.generali.it directory listings)
  // R9 simulator — additional BL hosts surfaced by the offline
  // PaidEvidenceGate simulation that the first BL audit missed.
  // Each verified by inspection.
  'gazzettaufficiale.it',           // Italian Official Gazette
  'cercaaziendepro.it',             // business directory (CercaAziendePro)
  'cenatesotto.halleyweb.it',       // Comune di Cenate Sotto bandi-gara portal
  'domus-picta.com',                // Prosecco DOC wine portal (vineyard)
  // R10 (paid VR rerun with R9 gate) — confirmation surfaced 2 FPs
  // that bypassed the sector-density rule because the page lists
  // "immobiliare" as an industry-category 6 times (member profile
  // with category nav). Industrial-association class, parent host
  // for all Confindustria provincial branches.
  'confindustria.it',               // Italian industrial confederation (covers
                                    // *.confindustria.it — vicenza/verona/etc.)
  // R8.1.VR audit — generalization run on Verona province dropped
  // precision to 75.9 % (44 TP / 14 FP / 58 paid). Triggered the
  // 85 % stop-rule before TV. 12 new host families surfaced —
  // mostly aggregators + wrong-sector cross-publishing.
  // R10.b TV audit (paid TV rerun with R9 gate) — 2 FPs out of 65
  // SERP_PAID gains slipped past the structural gate. One is a
  // government transparency portal that surfaces vat references in
  // contractor PDFs; the other is a real-estate listing aggregator.
  'cultura.gov.it',                 // Italian Ministry of Culture — covers
                                    // trasparenza.cultura.gov.it (contractor
                                    // disclosure PDFs that cite vat codes)
  'infoimmobile.it',                // real-estate listings portal (info-style)
  'casabitare.it',                  // real-estate aggregator/portal (×3)
  'babileather.it',                 // leather/furniture firm sharing vat with
                                    // a real-estate division (×2 in VR)
  'youtube.com',                    // YouTube — generic video platform (covers m.youtube.com)
  'cnr.it',                         // Italian National Research Council (CNR)
  'opencup.gov.it',                 // Italian govt project tracker (PNRR class)
  'visure24.com',                   // visure/business-document aggregator
  'univalpo.it',                    // libera università popolare Valpolicella (educ)
  'startuplus.it',                  // startup directory / incubator portal
  'sihappy.it',                     // multi-category marketplace (immobiliare among others)
  'ingebau.it',                     // engineering / construction firm (wrong sector)
  'tipsammartino.it',               // print shop (wrong sector — Sammartino vat collision)
  // Phase G.2 (p91 PD Serper round-2 audit) — additional Serper-
  // observed FPs that slipped past G.1 blocklist. Each manually
  // verified or classified by URL pattern in the p91 SERP_PAID set.
  'casavenezia.it',                // agency-listing portal (Venezia)
  'impresaitalia.info',            // company-data aggregator
  'mioaffitto.it',                 // rental listings (variant of ioaffitto)
  'cittanostra.it',                // local listings portal
  'bedandbreakfast.it',            // B&B portal (no-hyphen variant)
  'bancadellecase.it',             // listing aggregator
  'icribis.com',                   // company-data aggregator
  'agenziaroma.com',               // generic real-estate franchise — geo mismatch
  'aterpadova.it',                 // public housing authority (PA, not agency)
  'aopd.veneto.it',                // Azienda Ospedaliera Padova (hospital!)
  'arte-casa.info',                // .info parked-style
  'intercasarredamenti.it',         // furniture brand — wrong sector for "Intercasa" real-estate lead

  // Job boards
  'infojobs.it', 'indeed.com', 'glassdoor.it', 'trovalavoro.it',
  'bakeca.it', 'subito.it',

  // Other portals + reference sites
  'wikipedia.org', 'amazon.it', 'ebay.it', 'groupon.it',

  // Italian business/registry portals
  'guidatitolari.it', 'registroimprese.it', 'ufficiocamerale.it',
  'informazione-aziende.it', 'trovanumeri.com', 'reteimprese.it', 'area-clienti.com',
  'pagineimprese.it',

  // Sales-intel / contact enrichment vendors
  'signalhire.com', 'rocketreach.co', 'zoominfo.com', 'apollo.io',
  'lusha.com', 'arounddeal.com', 'datanyze.com',

  // Italian B2B intel
  'companywall.it', 'visura.pro', 'registroaziende.it', 'wogha.com',
  'fatturatoitalia.it', 'saikoo.ai', 'reportaziende.it',

  // Real-estate listing portals (NEVER the agency's own website)
  'immobiliare.it', 'idealista.it', 'casa.it', 'tuttocitta.it',
  'soloaffitti.it', 'immobiliare.info', 'annuncicase.it', 'cercasicasa.it',
  'attico.it', 'wikicasa.it', 'caasa.it', 'trovacasa.it', 'cheannunci.it',

  // Real-estate FRANCHISE master portals (Phase 3.7 audit: 432/1700 records
  // were mistakenly tagged as the agency's website, when in fact they were
  // the franchise's flagship site, e.g. `tecnocasa.it/agenzie/foo`).
  'tecnocasa.it', 'gabetti.it', 'remax.it', 'professionecasa.it',
  'retecasa.it', 'intercasanet.it', 'myhomegroup.it', 'gruppocasa.com',
  'centrocasa.it', 'primacasa.it', 'stabilia.it', 'agenziagruppocasa.it',

  // News / classified / generic
  'money.it', 'guidamonaci.it', 'abbrevia.it', 'dnb.com', 'cloudfront.net',
]);

/** Italian directories from which we CAN extract structured data (different from pure social). */
const EXTRACTABLE_REGISTRIES = new Set([
  'fatturatoitalia.it', 'reportaziende.it', 'guidatitolari.it', 'visura.pro',
  'registroimprese.it', 'ufficiocamerale.it', 'paginegialle.it',
]);

const PARKING_KEYWORDS = [
  'domain is for sale', 'buy this domain', 'questo dominio è in vendita',
  'domain parked', 'godaddy', 'sedo', 'dan.com', 'afternic',
  'huge domains', 'domain name is available', 'acquista questo dominio',
  'is available for purchase', 'under verification',
];

const CONSTRUCTION_KEYWORDS = [
  'coming soon', 'lavori in corso', 'sito in manutenzione',
  'website under construction', 'stiamo arrivando', 'work in progress',
  'sito in allestimento', 'torneremo presto', 'sito in costruzione',
];

const ITALIAN_STOP_WORDS = [
  ' il ', ' lo ', ' la ', ' i ', ' gli ', ' le ',
  ' di ', ' a ', ' da ', ' in ', ' con ', ' su ', ' per ', ' tra ', ' fra ',
  ' è ', ' sono ', ' siamo ', ' azienda ', ' contatti ', ' chi siamo ',
  ' home ', ' servizi ', ' prodotti ',
];

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function isDirectoryOrSocial(url: string): boolean {
  const h = hostname(url);
  if (!h) return false;
  if (DIRECTORIES.has(h)) return true;
  // also match parent domains (e.g. blog.tecnocasa.it)
  for (const d of DIRECTORIES) {
    if (h.endsWith(`.${d}`)) return true;
  }
  return false;
}

export function isExtractableRegistry(url: string): boolean {
  const h = hostname(url);
  if (!h) return false;
  if (EXTRACTABLE_REGISTRIES.has(h)) return true;
  for (const d of EXTRACTABLE_REGISTRIES) {
    if (h.endsWith(`.${d}`)) return true;
  }
  return false;
}

export function isParked(htmlLower: string): boolean {
  return PARKING_KEYWORDS.some((kw) => htmlLower.includes(kw));
}

export function isUnderConstruction(htmlLower: string): boolean {
  return CONSTRUCTION_KEYWORDS.some((kw) => htmlLower.includes(kw));
}

export function isLikelyItalian(htmlLower: string): boolean {
  if (htmlLower.length < 200) return false;
  const matches = ITALIAN_STOP_WORDS.reduce((acc, sw) => acc + (htmlLower.includes(sw) ? 1 : 0), 0);
  return matches >= 4;
}
