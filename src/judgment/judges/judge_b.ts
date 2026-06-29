import type { AxisAssessment, BusinessModel, EvidenceRef, Footprint, SegnaliB, SurfaceState, SurfaceVerdict } from '../../types/judgment';
import type { JudgmentConfig } from '../config/types';
import { type JudgeLLM, levelFromScore, parseJsonLoose, clamp01 } from './shared';

/**
 * Judge B — quality of digital self-expression (Axis B). Consumes ONLY
 * segnali_B (owned channels). Enforced by signature. Per surface §3.1–3.15,
 * three states (§3.0.1), weighted by model §3.0.2.
 *
 * §5.3.5 firewall (enforced here AND at collection): a surface backed only by
 * `unknown` signals → state 'unknown', EXCLUDED from the score — never
 * 'absence_abandonment'. Only a `confirmed_absent` signal yields absence.
 */

const STATE_NUM: Record<SurfaceState, number | null> = { excellence: 1, mediocrity: 0.45, absence_abandonment: 0.05, unknown: null };

export interface JudgeBDeps {
  config: JudgmentConfig;
  llm?: JudgeLLM;
}

function richness(values: unknown[]): number {
  let n = 0;
  for (const v of values) {
    if (Array.isArray(v)) n += v.length;
    else if (v !== undefined && v !== null && v !== '') n += 1;
  }
  return n;
}

function deterministicSurfaces(segnaliB: SegnaliB, config: JudgmentConfig, model: BusinessModel): SurfaceVerdict[] {
  const weights = config.judgeB.modelWeights.find((w) => w.model === model)?.weights ?? config.judgeB.modelWeights.find((w) => w.model === 'unknown')?.weights ?? {};
  return config.judgeB.surfaces.map((surf) => {
    const key = surf.surface;
    const sigs = segnaliB.filter((s) => s.key === key);
    const present = sigs.filter((s) => s.state === 'confirmed_present');
    const absent = sigs.filter((s) => s.state === 'confirmed_absent');
    let state: SurfaceState;
    if (present.length > 0) {
      // deterministic excellence/mediocrity split by observed richness
      state = richness(present.map((s) => s.value)) >= 3 ? 'excellence' : 'mediocrity';
    } else if (absent.length > 0) {
      state = 'absence_abandonment';
    } else {
      state = 'unknown';
    }
    const presentButPoor = present.length > 0 && state === 'mediocrity';
    const citations = [...present, ...absent].map((s) => `signal_b:${s.key}`);
    return {
      surface: key,
      state,
      presentButPoor,
      weight: weights[key] ?? 0.5,
      confidence: present.length || absent.length ? 0.6 : 0.2,
      citations,
      rationale: `det: ${present.length} present, ${absent.length} absent`,
    };
  });
}

function scoreFromSurfaces(surfaces: SurfaceVerdict[]): number {
  let num = 0;
  let den = 0;
  for (const s of surfaces) {
    const val = STATE_NUM[s.state];
    if (val === null) continue; // unknown excluded — the firewall in numeric form
    num += s.weight * val;
    den += s.weight;
  }
  return den > 0 ? clamp01(num / den) : 0;
}

export async function judgeB(segnaliB: SegnaliB, footprint: Footprint | undefined, model: BusinessModel, deps: JudgeBDeps): Promise<AxisAssessment> {
  const { config } = deps;
  let surfaces = deterministicSurfaces(segnaliB, config, model);
  let rationale = 'deterministic baseline (no LLM)';

  if (deps.llm) {
    const prompt = renderJudgeBPrompt(segnaliB, footprint, model, config);
    const text = await deps.llm({ system: config.prompts.judgeB, prompt, json_schema: JUDGE_B_SCHEMA, temperature: 0 });
    const parsed = parseJsonLoose(text) as { surfaces?: Array<{ surface: string; state: string; presentButPoor?: boolean; rationale?: string; citations?: string[] }>; rationale?: string } | undefined;
    if (parsed?.surfaces?.length) {
      const bySurf = new Map(parsed.surfaces.map((s) => [s.surface, s]));
      surfaces = surfaces.map((base) => {
        const llmS = bySurf.get(base.surface);
        let state = isSurfaceState(llmS?.state) ? (llmS!.state as SurfaceState) : base.state;
        // FIREWALL: the LLM may NOT turn an unknown into absence. If the
        // deterministic base is 'unknown' (no observed signal), keep it unknown.
        if (base.state === 'unknown' && state === 'absence_abandonment') state = 'unknown';
        return { ...base, state, presentButPoor: llmS?.presentButPoor ?? base.presentButPoor, citations: llmS?.citations?.length ? llmS.citations : base.citations, rationale: llmS?.rationale ?? base.rationale };
      });
      rationale = parsed.rationale ?? 'LLM-refined';
    }
  }

  const score = scoreFromSurfaces(surfaces);
  const present = segnaliB.filter((s) => s.state === 'confirmed_present');
  const basedOn: EvidenceRef[] = present.flatMap((s) => s.evidence);
  return {
    axis: 'B',
    score,
    level: levelFromScore(score, config.thresholds),
    rationale,
    signalsConsidered: segnaliB.length,
    signalsPresent: present.length,
    signalsUnknown: segnaliB.filter((s) => s.state === 'unknown_not_found').length,
    surfaces,
    basedOn,
  };
}

function isSurfaceState(v: unknown): v is SurfaceState {
  return v === 'excellence' || v === 'mediocrity' || v === 'absence_abandonment' || v === 'unknown';
}

export function renderJudgeBPrompt(segnaliB: SegnaliB, footprint: Footprint | undefined, model: BusinessModel, config: JudgmentConfig): string {
  const rubrics = config.judgeB.surfaces.map((s) => `- ${s.surface} ${s.name} (${s.ref}): ECC=${s.excellence} | MED=${s.mediocrity} | ASS=${s.absence}${s.axisNote ? ` [${s.axisNote}]` : ''}`).join('\n');
  const weights = config.judgeB.modelWeights.find((w) => w.model === model)?.weights ?? {};
  const fp = footprint ? `\nFOOTPRINT (stati per canale): ${footprint.channels.map((c) => `${c.channel}=${c.state}`).join(', ')}` : '';
  const signalsTxt = segnaliB.map((s) => `[${s.key}] ${s.state}${s.value !== undefined ? ` = ${JSON.stringify(s.value)}` : ''}${s.notes ? ` (${s.notes})` : ''}`).join('\n');
  return [
    `RUBRICHE ASSE B (§3.1–3.15, tre stati §3.0.1):\n${rubrics}`,
    `\nPESI PER MODELLO ${model} (§3.0.2): ${JSON.stringify(weights)}`,
    `\nCriteri trasversali (§3.16): ${config.judgeB.transversalCriteria.map((c) => c.name).join(', ')}`,
    fp,
    `\nSEGNALI B (solo owned):\n${signalsTxt}`,
    `\nREGOLA FERREA: una superficie con footprint/segnali 'unknown' è state="unknown" (esclusa), MAI "absence_abandonment". Restituisci JSON {surfaces:[{surface,state,presentButPoor,citations,rationale}], rationale}.`,
  ].join('\n');
}

export const JUDGE_B_SCHEMA = {
  type: 'object',
  properties: {
    surfaces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          surface: { type: 'string' },
          state: { type: 'string', enum: ['excellence', 'mediocrity', 'absence_abandonment', 'unknown'] },
          presentButPoor: { type: 'boolean' },
          citations: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
        required: ['surface', 'state'],
      },
    },
    rationale: { type: 'string' },
  },
  required: ['surfaces'],
};
