import type { NormalizedLead } from '../../../types/discovery';
import { ItalianNerParser } from './italian_ner_parser';

/**
 * Generates an aggressive set of plausible domains for a company by combining
 * NER-extracted brand tokens with city tokens, acronyms, and descriptors.
 * Output is post-filtered to length 3..60 to avoid pinging entire TLD blocks.
 *
 * Pure, deterministic. Adapted from pg3 hyperguesser_vx/generator.ts.
 */
export class HyperGuesserGenerator {
  private static readonly TLDS = ['.it', '.com', '.eu', '.net', '.org'];

  static generate(lead: NormalizedLead): string[] {
    const domains = new Set<string>();
    const name = lead.company_name || '';
    const city = lead.city || '';
    if (!name) return [];

    const ner = ItalianNerParser.parse(name);
    const brandTokens = ner.brandTokens;

    const cleanName = ner.coreBrand.replace(/[^a-z0-9]/g, '');
    const cleanCity = city.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

    // Base brand permutations
    this.add(domains, cleanName);
    this.add(domains, brandTokens.join('-'));
    this.add(domains, ner.normalized.replace(/[^a-z0-9]/g, ''));
    this.add(domains, ner.normalized.replace(/\s+/g, '-'));
    this.add(domains, name.toLowerCase().replace(ner.legalEntity || '', '').replace(/[^a-z0-9]/g, ''));

    // Acronyms (multi-token brands only)
    if (brandTokens.length > 1) {
      const acro1 = brandTokens.map((w) => w[0]).join('');
      const acro2 = brandTokens.map((w) => w.substring(0, 2)).join('');
      this.add(domains, acro1);
      this.add(domains, acro2);
      if (brandTokens.length > 2) {
        const firstPlusAcro = brandTokens[0] + brandTokens.slice(1).map((w) => w[0]).join('');
        this.add(domains, firstPlusAcro);
      }
    }

    // City combinations (very common for Italian local businesses)
    if (cleanCity) {
      this.add(domains, `${cleanName}${cleanCity}`);
      this.add(domains, `${cleanCity}${cleanName}`);
      this.add(domains, `${cleanName}-${cleanCity}`);
      if (brandTokens.length > 0) this.add(domains, `${brandTokens[0]}${cleanCity}`);
      if (brandTokens.length > 1) {
        const acro = brandTokens.map((w) => w[0]).join('');
        this.add(domains, `${acro}${cleanCity}`);
        this.add(domains, `${acro}-${cleanCity}`);
      }
    }

    // Descriptors + brand
    if (ner.descriptors.length > 0) {
      const d = ner.descriptors[0];
      this.add(domains, `${d}${cleanName}`);
      this.add(domains, `${cleanName}${d}`);
      this.add(domains, `${d}-${cleanName}`);
    }

    return Array.from(domains).filter((d) => d.length >= 4 && d.length <= 60);
  }

  private static add(set: Set<string>, base: string): void {
    if (!base || base.length < 2) return;
    const cleaned = base.replace(/^-|-$/g, '').replace(/-{2,}/g, '-');
    if (cleaned.length < 2) return;
    for (const tld of this.TLDS) set.add(`${cleaned}${tld}`);
  }
}
