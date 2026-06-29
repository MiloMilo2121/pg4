/**
 * Italian NER (named-entity recognition) for company names.
 * Splits a company name into:
 *  - legalEntity (SRL / SPA / SNC / SAS / ...)
 *  - descriptors (generic activity words: "ristorante", "studio", "agriturismo")
 *  - brandTokens (the unique brand part, used for domain generation)
 *  - coreBrand (brandTokens joined)
 *
 * Pure, deterministic. Adapted from pg3/enricher/core/discovery/hyperguesser_vx/italian_ner_parser.ts.
 */

export interface NerResult {
  original: string;
  normalized: string;
  legalEntity: string | null;
  descriptors: string[];
  brandTokens: string[];
  coreBrand: string;
}

const LEGAL_ENTITIES = [
  'srl', 's.r.l.', 'srls', 's.r.l.s.', 'spa', 's.p.a.',
  'snc', 's.n.c.', 'sas', 's.a.s.', 'sapa', 's.a.p.a.',
  'ss', 's.s.', 'societa a responsabilita limitata',
  'societa per azioni', 'societa in nome collettivo',
  'societa in accomandita semplice', 'societa semplice',
  'coop', 'cooperativa', 'soc. coop.', 'societa cooperativa',
  'scarl', 's.c.a.r.l.', 'scrl', 's.c.r.l.',
  'onlus', 'a.p.s.', 'aps', 'ets',
];

const DESCRIPTORS = [
  'ditta', 'impresa', 'studio', 'officina', 'autofficina', 'carrozzeria',
  'autosoccorso', 'gommista', 'elettrauto', 'meccatronica', 'impianti',
  'elettrici', 'termoidraulica', 'costruzioni', 'edile', 'edilizia',
  'immobiliare', 'autotrasporti', 'logistica', 'servizi', 'pulizie',
  'ristorante', 'pizzeria', 'bar', 'hotel', 'albergo', 'agriturismo',
  'farmacia', 'parafarmacia', 'ottica', 'odontoiatrica', 'dentistico',
  'poliambulatorio', 'clinica', 'veterinaria', 'supermercato', 'minimarket',
  'macelleria', 'panificio', 'pasticceria', 'gelateria', 'abbigliamento',
  'calzature', 'pelletteria', 'lavanderia', 'estetica', 'parrucchiere',
  'barbiere', 'acconciature', 'fiorista', 'vivaio', 'agricola',
  'agraria', 'farm', 'fondazione', 'associazione', 'gruppo', 'group',
  'sistemi', 'systems', 'tecnologie', 'technologies', 'soluzioni',
  'solutions', 'consulting', 'consulenze', 'partners',
  'fratelli', 'f.lli', 'sorelle', 'figli', 'eredi',
  'di', 'e', '&', 'and',
];

export class ItalianNerParser {
  static parse(companyName: string): NerResult {
    const original = companyName;
    let normalized = companyName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9&.\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let legalEntity: string | null = null;
    for (const entity of LEGAL_ENTITIES) {
      const re = new RegExp(`(^|\\s)${entity.replace(/\./g, '\\.')}($|\\s)`, 'i');
      if (re.test(normalized)) {
        legalEntity = entity;
        normalized = normalized.replace(re, ' ').replace(/\s+/g, ' ').trim();
        break;
      }
    }

    const tokens = normalized.replace(/[.\-&]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const descriptors: string[] = [];
    let brandTokens: string[] = [];
    for (const tok of tokens) {
      if (DESCRIPTORS.includes(tok)) descriptors.push(tok);
      else brandTokens.push(tok);
    }
    if (brandTokens.length === 0 && tokens.length > 0) {
      brandTokens = [...tokens];
      descriptors.length = 0;
    }
    return {
      original,
      normalized,
      legalEntity,
      descriptors,
      brandTokens,
      coreBrand: brandTokens.join(' '),
    };
  }
}
