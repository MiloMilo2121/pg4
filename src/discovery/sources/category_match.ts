/**
 * Category-shape sanity check for Maps cards.
 *
 * Phase 3.7 audit: pg3 stored every Maps result with the requested
 * category as a label, even when the card's own type tag was something
 * unrelated (`bar`, `parrucchiere`, `pizzeria` returned by a fuzzy
 * `agenzie immobiliari` search). Downstream filtering treated all of
 * them as the requested category, polluting the campaign list.
 *
 * The classifier is deliberately permissive: lower-case Italian token
 * overlap on the card's category-tag string vs the expected category
 * tokens. Returns 'confirmed' / 'unknown' / 'mismatch'.
 *
 * Maintained as a small map; extend as new categories ship.
 */

const EXPECTED_TOKENS: Array<{ canonical: string; tokens: string[] }> = [
  {
    canonical: 'agenzie immobiliari',
    tokens: ['agenzia', 'agenzie', 'immobiliare', 'immobiliari', 'agente', 'real estate', 'property'],
  },
  {
    canonical: 'centro estetico',
    tokens: ['estetic', 'centro estetico', 'beauty', 'salone di bellezza', 'epilazione'],
  },
  {
    canonical: 'parrucchiere',
    tokens: ['parrucchiere', 'parrucchiera', 'salone', 'hair', 'acconciatura', 'barbiere'],
  },
  {
    canonical: 'ristorante',
    tokens: ['ristorante', 'trattoria', 'osteria', 'pizzeria', 'restaurant'],
  },
  {
    canonical: 'studio dentistico',
    tokens: ['dentista', 'odontoiatr', 'dentist', 'studio dentistico'],
  },
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensFor(category: string): string[] {
  const cat = normalize(category);
  for (const e of EXPECTED_TOKENS) {
    if (e.tokens.some((t) => cat.includes(t)) || e.canonical === cat) {
      return e.tokens;
    }
  }
  // Unknown category: fall back to using its own words as the expected set.
  return cat.split(' ').filter((t) => t.length >= 4);
}

/**
 * @param requestedCategory  the search keyword (e.g. "agenzie immobiliari")
 * @param cardTypeTag        the card's category-tag text (e.g. "Agenzia immobiliare")
 *                           — empty string / undefined means we have no tag
 */
export function classifyCategoryMatch(
  requestedCategory: string | undefined,
  cardTypeTag: string | undefined
): 'confirmed' | 'unknown' | 'mismatch' {
  if (!requestedCategory) return 'unknown';
  const tag = normalize(cardTypeTag ?? '');
  if (!tag) return 'unknown';
  const expected = tokensFor(requestedCategory);
  if (expected.length === 0) return 'unknown';
  const match = expected.some((t) => tag.includes(normalize(t)));
  return match ? 'confirmed' : 'mismatch';
}
