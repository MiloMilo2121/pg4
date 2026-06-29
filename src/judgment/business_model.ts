import type { Lead } from '../types/lead';
import type { BusinessModel } from '../types/judgment';

/**
 * Deterministic business-model classifier (a PRIOR, §2.8/§3.0.2 — never a rigid
 * rule). Reads the lead's category/ATECO-ish text and maps it to one of the five
 * ontology models. The GAP reasoner may refine it with collected evidence.
 *
 * Tuned to the four Cypher verticals: manifattura, dentale/medico, ristorazione
 * multi-sede, e-commerce di prodotto.
 */
const RULES: Array<{ model: BusinessModel; re: RegExp }> = [
  { model: 'B2B_manufacturing', re: /manifatt|industr|meccanic|metalmecc|produzione|produttor|component|impiant|stamp|lavorazione|utensil|macchinari|arredo|serrament|automazione|fonderia|plastica|gomma/i },
  { model: 'professional_local', re: /dentist|odontoiatr|medic|clinic|poliambulator|fisioterap|studio (?:legale|tecnico|dentistico|medico)|avvocat|commercialist|architett|ingegner|notai|veterinar|psicolog|centro (?:medico|estetico|specializzato)/i },
  { model: 'hospitality_retail', re: /ristorant|pizzeri|trattoria|osteria|hotel|albergo|\bb&b\b|agriturismo|bar\b|catering|gelateria|pasticceria|caff[eè]|resort|ricettiv/i },
  { model: 'B2C_product', re: /e-?commerce|negozio|\bshop\b|store|abbigliament|calzatur|gioieller|cosmesi|profumeria|alimentar|enotec|cantina|food|moda|design (?:prodotto)?/i },
];

export function classifyBusinessModel(lead: Lead): BusinessModel {
  const text = `${(lead.category as string | undefined) ?? ''} ${(lead.category_match as string | undefined) ?? ''}`.toLowerCase();
  if (!text.trim()) return 'unknown';
  for (const r of RULES) if (r.re.test(text)) return r.model;
  return 'unknown';
}
