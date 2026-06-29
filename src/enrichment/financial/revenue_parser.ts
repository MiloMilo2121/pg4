/**
 * R13 — Italian revenue / "fatturato" parsing. PURE: no network, no I/O.
 *
 * Ported and consolidated from pg3:
 *   - `FatturatoItaliaProvider.parseEurAmount()` (Mld/Mln/IT-number formats)
 *   - `patterns.ts` REVENUE regexes
 *   - `BilancioHunter.parseFinancialSnippet()` separator heuristic
 *
 * Italian financial text is messy: amounts appear as `€ 1.234.567`,
 * `1,5 mln`, `200 mila`, `1.5M`, `1,2 Mld`. The number itself uses `.` for
 * thousands and `,` for decimals — the opposite of English. We resolve the
 * decimal separator by position, then apply any magnitude suffix.
 */

interface RevenueMatch {
  /** Numeric EUR value when parseable. */
  amount?: number;
  /** The raw matched amount substring (incl. suffix), kept for audit. */
  raw?: string;
  /** Year detected near the amount, if any. */
  year?: string;
}

/** Magnitude suffixes, longest-first so "milioni" wins over "mila"/"m". */
const MULTIPLIERS: Array<{ re: RegExp; factor: number }> = [
  { re: /^(mld|miliardi|miliardo)$/i, factor: 1_000_000_000 },
  { re: /^(mln|milioni|milione|mio|m)$/i, factor: 1_000_000 },
  { re: /^(mila|k)$/i, factor: 1_000 },
];

/**
 * Parse a loose Italian/English number token (no suffix) into a float.
 * Resolves which of `.` / `,` is the decimal separator:
 *   - if both appear, the right-most one is the decimal separator;
 *   - if only one appears, it's a decimal separator only when it has
 *     1–2 trailing digits (`1,5` → 1.5) — otherwise it's a thousands
 *     group (`1.500` → 1500, `200.000` → 200000).
 */
function parseLooseNumber(token: string): number | undefined {
  const t = token.replace(/[^\d.,]/g, '');
  if (!t) return undefined;

  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  const dec = Math.max(lastDot, lastComma);

  let normalized: string;
  if (dec === -1) {
    normalized = t;
  } else {
    const sepChar = t[dec];
    const otherSep = sepChar === '.' ? ',' : '.';
    const fractLen = t.length - dec - 1;
    const isDecimal = t.includes(otherSep) ? true : fractLen >= 1 && fractLen <= 2;
    normalized = isDecimal
      ? t.slice(0, dec).replace(/[.,]/g, '') + '.' + t.slice(dec + 1)
      : t.replace(/[.,]/g, '');
  }

  const v = Number.parseFloat(normalized);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Normalize a raw amount string (with optional currency symbol and
 * magnitude suffix) into an integer number of euros.
 * Returns undefined when nothing numeric can be extracted.
 */
export function normalizeRevenueAmount(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/€|eur/gi, '').trim();
  if (!cleaned) return undefined;

  // Split the numeric head from a trailing magnitude word/letter
  // (case-insensitive; covers "M", "Mln", "MILA", accented forms).
  const m = cleaned.match(/^([\d.,\s]+?)\s*([a-zà-ùA-ZÀ-Ù]+)?\s*$/);
  if (!m) return undefined;

  const numberToken = (m[1] || '').replace(/\s/g, '');
  const suffix = (m[2] || '').trim();

  const base = parseLooseNumber(numberToken);
  if (base === undefined) return undefined;

  let factor = 1;
  if (suffix) {
    const hit = MULTIPLIERS.find((x) => x.re.test(suffix));
    if (hit) {
      factor = hit.factor;
    } else {
      // Unknown trailing word (e.g. "euro", "annui") — ignore it, keep base.
      factor = 1;
    }
  }

  const value = Math.round(base * factor);
  return value >= 0 ? value : undefined;
}

/** A financial keyword that should precede a revenue figure. */
const FINANCIAL_KEYWORD =
  /(?:fatturato|ricavi(?:\s+delle\s+vendite)?|valore\s+della\s+produzione|volume\s*d['’]affari)/i;

/**
 * A *monetary-looking* amount. Deliberately does NOT match a bare 4-digit
 * number (so a year like "2023" right after the keyword is never mistaken
 * for the revenue). An amount must be one of:
 *   1. € / EUR prefixed,
 *   2. thousands-grouped (1.500.000), or
 *   3. number + magnitude suffix (2,3 mln / 500k / 1.5M).
 */
const AMOUNT_RE =
  /(?:€|eur)\s*([\d.,]+(?:\s*(?:mld|miliardi?|mln|milioni?|milione|mio|mila|k))?)|(\d{1,3}(?:\.\d{3})+(?:,\d+)?)|(\d+(?:[.,]\d+)?\s*(?:mld|miliardi?|mln|milioni?|milione|mio|mila|k|m))/gi;

/** A 4-digit year in a plausible bilancio range. */
function inYearRange(y: number): boolean {
  return y >= 1990 && y <= 2099;
}

/**
 * Find a revenue year in free text. Prefers a year adjacent to a financial
 * keyword (`fatturato 2023`, `bilancio (2022)`, `esercizio 2021`); falls
 * back to the most recent plausible 4-digit year in the text.
 */
export function parseRevenueYear(text: string | null | undefined): string | undefined {
  if (!text) return undefined;

  const keyed = text.match(
    /(?:fatturato|bilancio|ricavi|esercizio|anno)\s*(?:\(\s*)?(\d{4})/i,
  );
  if (keyed && inYearRange(Number(keyed[1]))) return keyed[1];

  const all = text.match(/\b(19|20)\d{2}\b/g);
  if (!all || all.length === 0) return undefined;

  const years = all.map((y) => Number(y)).filter(inYearRange);
  if (years.length === 0) return undefined;
  return String(Math.max(...years));
}

/**
 * Parse the first revenue figure out of a block of Italian text.
 * Returns the numeric amount, the raw matched substring, and any nearby
 * year. Empty object when no revenue is found (never throws).
 */
export function parseItalianRevenueText(text: string | null | undefined): RevenueMatch {
  if (!text) return {};

  const kw = text.match(FINANCIAL_KEYWORD);
  if (!kw || kw.index === undefined) return {};
  const from = kw.index;

  AMOUNT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AMOUNT_RE.exec(text)) !== null) {
    if (m.index < from) continue;
    // The amount should sit reasonably close to the keyword.
    if (m.index - from > 80) break;
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    const amount = normalizeRevenueAmount(raw);
    if (amount !== undefined && amount > 0) {
      const fragment = text.slice(from, m.index + m[0].length);
      const year = parseRevenueYear(fragment) ?? parseRevenueYear(text);
      return { amount, raw, year };
    }
  }

  return {};
}

/** Format an integer EUR amount as an Italian display string: "€ 1.500.000". */
export function formatRevenueDisplay(amount: number | undefined): string | undefined {
  if (amount === undefined || !Number.isFinite(amount)) return undefined;
  return `€ ${amount.toLocaleString('it-IT')}`;
}
