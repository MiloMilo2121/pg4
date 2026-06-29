import { describe, expect, it } from 'vitest';
import type { Lead } from '../../../src/types/lead';
import type { HarvestContext, PageFetcher } from '../../../src/judgment/harvest/source_harvest';
import { InMemoryEnrichmentCache } from '../../../src/persistence/enrichment_cache';
import { getActiveJudgmentConfig } from '../../../src/judgment/config';
import { runJudgment } from '../../../src/judgment/run_judgment';
import { collectA } from '../../../src/judgment/collectors/collect_a';
import { collectB } from '../../../src/judgment/collectors/collect_b';
import { judgeA } from '../../../src/judgment/judges/judge_a';
import { judgeB } from '../../../src/judgment/judges/judge_b';
import { gapReason } from '../../../src/judgment/judges/gap_reasoner';
import { buildFootprint } from '../../../src/judgment/discovery/footprint';
import { triage } from '../../../src/judgment/triage';
import { isWrongEntity } from '../../../src/enrichment/fields/field_registry';
import type { SegnaliA, SegnaliB, Signal } from '../../../src/types/judgment';

const NOW = 1_750_000_000_000;
const config = getActiveJudgmentConfig();

const lead = (o: Partial<Lead>): Lead => ({ company_name: 'Acme Srl', ...o });

function ctx(fetcher: PageFetcher, search?: HarvestContext['search']): HarvestContext {
  return { tenantId: 't', cache: new InMemoryEnrichmentCache(), fetcher, search, paidEnabled: false, now: () => NOW, ledgerMeta: { company_name: 'Acme Srl' } };
}

const RICH_HTML = `<!doctype html><html lang="it"><head>
<link rel="alternate" hreflang="en" href="/en"/>
<title>Acme</title></head><body>
<h1>Acme — macchinari di precisione</h1>
<p>Richiedi un preventivo. Le nostre certificazioni ISO 9001.</p>
<a href="https://instagram.com/acme">IG</a>
<a href="https://www.linkedin.com/company/acme">LinkedIn</a>
<a href="mailto:info@acme.it">info@acme.it</a>
<footer>© 2025 Acme Srl</footer></body></html>`;

const richFetcher: PageFetcher = async (url) => (url.includes('acme.it') ? RICH_HTML : undefined);
const deadFetcher: PageFetcher = async () => undefined;

describe('guardrail: A/B physical separation', () => {
  it('collectA emits ONLY axis A signals (never a 3.x surface)', async () => {
    const sigs = await collectA(lead({ official_website: 'https://acme.it', category: 'produzione macchinari' }), ctx(richFetcher), { byKind: {} });
    expect(sigs.length).toBeGreaterThan(0);
    for (const s of sigs) {
      expect(s.axis).toBe('A');
      expect(s.key.startsWith('3.')).toBe(false);
    }
  });

  it('collectB emits ONLY axis B signals (never a 2.x subdimension)', async () => {
    const sigs = await collectB(lead({ official_website: 'https://acme.it' }), ctx(richFetcher), { byKind: {} });
    expect(sigs.length).toBeGreaterThan(0);
    for (const s of sigs) {
      expect(s.axis).toBe('B');
      expect(s.key.startsWith('2.')).toBe(false);
    }
  });
});

describe('guardrail: three-state firewall (discovery failure ≠ B basso)', () => {
  it('a non-fetchable site yields website=unknown, NOT confirmed_absent', () => {
    const fp = buildFootprint(lead({ official_website: 'https://acme.it' }), { website: { source: 'website', sourceId: 'w', locator: 'https://acme.it', fetchedAt: '', ok: false, attributes: {}, signals: [] } }, '2026');
    const web = fp.channels.find((c) => c.channel === 'website')!;
    expect(web.state).toBe('unknown_not_found');
    expect(web.searchedSeriously).toBe(false);
  });

  it('confirmed_absent is impossible without searchedSeriously (coerced to unknown)', () => {
    // social never chased → social channels must be unknown, never absent
    const fp = buildFootprint(lead({ official_website: 'https://acme.it' }), {}, '2026');
    for (const ch of fp.channels) {
      if (ch.state === 'confirmed_absent') expect(ch.searchedSeriously).toBe(true);
    }
    const ig = fp.channels.find((c) => c.channel === 'instagram')!;
    expect(ig.state).toBe('unknown_not_found');
  });

  it('Judge B with all-unknown signals → level unknown, score 0, no absence fabricated', async () => {
    const segnaliB: SegnaliB = ['3.1', '3.2', '3.3', '3.5', '3.8'].map((k): Signal => ({ axis: 'B', key: k, state: 'unknown_not_found', evidence: [] }));
    const b = await judgeB(segnaliB, undefined, 'B2B_manufacturing', { config });
    expect(b.level).toBe('unknown');
    expect(b.score).toBe(0);
    expect((b.surfaces ?? []).every((s) => s.state !== 'absence_abandonment')).toBe(true);
  });

  it('GAP reasoner does NOT call a target when B is unknown (scoreB=0 ≠ B low)', async () => {
    const strongA: SegnaliA = [
      { axis: 'A', key: '2.1', state: 'confirmed_present', value: 'unique', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
      { axis: 'A', key: '2.1', state: 'confirmed_present', value: 'unique2', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
      { axis: 'A', key: '2.6', state: 'confirmed_present', value: '50', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
      { axis: 'A', key: '2.6', state: 'confirmed_present', value: '60', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
    ];
    const segnaliB: SegnaliB = ['3.1', '3.8'].map((k): Signal => ({ axis: 'B', key: k, state: 'unknown_not_found', evidence: [] }));
    const a = await judgeA(strongA, 'B2B_manufacturing', undefined, { config });
    const b = await judgeB(segnaliB, undefined, 'B2B_manufacturing', { config });
    const { verdict } = await gapReason(lead({}), 'B2B_manufacturing', a, b, strongA, segnaliB, undefined, { config });
    expect(verdict.target).toBe('borderline'); // never 'yes' on unknown B
  });
});

describe('guardrail: quadrant label never lets "A unknown" read as "A low" (§5.3.5 at label level)', () => {
  const strongA: SegnaliA = [
    { axis: 'A', key: '2.1', state: 'confirmed_present', value: 'x', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
    { axis: 'A', key: '2.1', state: 'confirmed_present', value: 'y', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
    { axis: 'A', key: '2.6', state: 'confirmed_present', value: 'z', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
    { axis: 'A', key: '2.6', state: 'confirmed_present', value: 'w', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
  ];

  it('A unknown + B observed → quadrant is A?B…, NOT A-B+ (not fuffa)', async () => {
    const unknownA: SegnaliA = ['2.1', '2.2', '2.6'].map((k): Signal => ({ axis: 'A', key: k, state: 'unknown_not_found', evidence: [] }));
    const presentB: SegnaliB = [
      { axis: 'B', key: '3.1', state: 'confirmed_present', value: ['has_h1', 'cta', 'proof'], evidence: [{ source: 'website_body', observedAt: '', confidence: 0.8 }] },
    ];
    const a = await judgeA(unknownA, 'B2B_manufacturing', undefined, { config });
    const b = await judgeB(presentB, undefined, 'B2B_manufacturing', { config });
    const { verdict } = await gapReason(lead({}), 'B2B_manufacturing', a, b, unknownA, presentB, undefined, { config });
    expect(verdict.quadrant.startsWith('A?')).toBe(true); // A not measured → '?'
    expect(verdict.quadrant).not.toBe('A-B+'); // must NOT read as fuffa
    expect(verdict.target).toBe('borderline');
  });

  it('B unknown → quadrant is A…B? (not A…B-)', async () => {
    const unknownB: SegnaliB = ['3.1', '3.8'].map((k): Signal => ({ axis: 'B', key: k, state: 'unknown_not_found', evidence: [] }));
    const a = await judgeA(strongA, 'B2B_manufacturing', undefined, { config });
    const b = await judgeB(unknownB, undefined, 'B2B_manufacturing', { config });
    const { verdict } = await gapReason(lead({}), 'B2B_manufacturing', a, b, strongA, unknownB, undefined, { config });
    expect(verdict.quadrant.endsWith('B?')).toBe(true);
  });

  it('THESIS path (logic-level): A measured-high + B measured-low → A+B-, target=yes', async () => {
    // B measured ABSENT on weighted surfaces (not unknown) → genuinely low, not "not looked at"
    const measuredLowB: SegnaliB = ['3.1', '3.2', '3.8'].map((k): Signal => ({ axis: 'B', key: k, state: 'confirmed_absent', evidence: [{ source: 'ad_library', observedAt: '', confidence: 0.6 }] }));
    const a = await judgeA(strongA, 'B2B_manufacturing', undefined, { config });
    const b = await judgeB(measuredLowB, undefined, 'B2B_manufacturing', { config });
    expect(a.level).toBe('high');
    expect(b.level).toBe('low'); // measured-low, NOT unknown
    const { verdict, levers } = await gapReason(lead({ company_name: 'Forte Silente Srl' }), 'B2B_manufacturing', a, b, strongA, measuredLowB, undefined, { config });
    expect(verdict.quadrant).toBe('A+B-');
    expect(verdict.target).toBe('yes');
    expect(levers.length).toBeGreaterThan(0); // intervention levers recommended
  });
});

describe('guardrail: evidence on every non-unknown signal', () => {
  it('every confirmed_present B signal carries evidence', async () => {
    const sigs = await collectB(lead({ official_website: 'https://acme.it' }), ctx(richFetcher), { byKind: {} });
    for (const s of sigs) {
      if (s.state === 'confirmed_present') expect(s.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe('guardrail: disqualifiers operate BEFORE the gap logic (§4.5)', () => {
  it('a permanently_closed company is never a target even with strong A', async () => {
    const strongA: SegnaliA = [
      { axis: 'A', key: '2.1', state: 'confirmed_present', value: 'x', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
      { axis: 'A', key: '2.1', state: 'confirmed_present', value: 'y', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
      { axis: 'A', key: '2.6', state: 'confirmed_present', value: 'z', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
      { axis: 'A', key: '2.6', state: 'confirmed_present', value: 'w', evidence: [{ source: 's', observedAt: '', confidence: 0.6 }] },
    ];
    const a = await judgeA(strongA, 'B2B_manufacturing', undefined, { config });
    const weakB: SegnaliB = [{ axis: 'B', key: '3.1', state: 'confirmed_absent', evidence: [] }];
    const b = await judgeB(weakB, undefined, 'B2B_manufacturing', { config });
    const { verdict } = await gapReason(lead({ permanently_closed: true }), 'B2B_manufacturing', a, b, strongA, weakB, undefined, { config });
    expect(verdict.target).toBe('no');
    expect(verdict.disqualifiers).toContain('permanently_closed');
  });

  it('§16 triage drops cheap disqualifiers before any collection', () => {
    expect(triage(lead({ permanently_closed: true }), config).pass).toBe(false);
    expect(triage(lead({ category: 'rivendita usato' }), config).disqualifier).toBe('pure_reseller');
    expect(triage(lead({ official_website: 'https://acme.it', category: 'produzione' }), config).pass).toBe(true);
  });
});

describe('guardrail: wrong-entity defense reused for VAT-keyed A signals (€58M class)', () => {
  it('isWrongEntity rejects a franchisor name on a local agency', () => {
    expect(isWrongEntity('Tecnocasa Franchising S.p.A.', 'Agenzia Immobiliare Tecnocasa Albignasego')).toBe(true);
    expect(isWrongEntity('IMMOBILIARE METROQUADRO A R.L.', 'Immobiliare Metroquadro')).toBe(false);
  });
});

describe('end-to-end runJudgment (offline, deterministic)', () => {
  it('produces all sections, separated axes, consistent validation', async () => {
    const rec = await runJudgment(lead({ official_website: 'https://acme.it', category: 'produzione macchinari', city: 'Padova' }), ctx(richFetcher), { config });
    expect(rec.footprint).toBeDefined();
    expect(rec.segnali_A && rec.segnali_A.every((s) => s.axis === 'A')).toBe(true);
    expect(rec.segnali_B && rec.segnali_B.every((s) => s.axis === 'B')).toBe(true);
    expect(rec.valutazione_A?.axis).toBe('A');
    expect(rec.valutazione_B?.axis).toBe('B');
    expect(rec.verdetto_gap).toBeDefined();
    // separation in citations: A subdims cite only signal_a, B surfaces only signal_b
    for (const sd of rec.valutazione_A?.subdims ?? []) for (const c of sd.citations) expect(c.startsWith('signal_b:')).toBe(false);
    for (const sv of rec.valutazione_B?.surfaces ?? []) for (const c of sv.citations) expect(c.startsWith('signal_a:')).toBe(false);
    // versioned meta (§20)
    expect(rec.meta?.ontologyVersion).toBe('v2');
    expect(rec.meta?.judgmentConfigVersion).toBe(config.version);
    // agentic validation present + no asymmetry breach
    expect(rec.validazione).toBeDefined();
    expect(rec.validazione?.flags).not.toContain('asymmetry_breach');
    // website was found → footprint website confirmed_present (owned)
    expect(rec.footprint?.channels.find((c) => c.channel === 'website')?.state).toBe('confirmed_present');
  });

  it('a triaged-out company short-circuits to target=no with no collection', async () => {
    const rec = await runJudgment(lead({ permanently_closed: true }), ctx(deadFetcher), { config });
    expect(rec.verdetto_gap?.target).toBe('no');
    expect(rec.segnali_A).toBeUndefined(); // collection skipped
  });
});
