/**
 * What a model's API accepts. Kept in one place so that a request built for a
 * model that cannot take a parameter never carries it — a rejected parameter is
 * an HTTP 400 on EVERY call, not a degraded answer.
 */

/**
 * Models that reject sampling parameters (`temperature`, `top_p`, `top_k`) with a
 * 400 (or only accept their default). Anything not listed keeps receiving them,
 * so an unknown model behaves as before.
 *
 *   - Claude Opus 4.7 / 4.8, Opus 5 / 5.5, Sonnet 5 / 5.5, Fable, Mythos
 *   - OpenAI reasoning models (o-series, gpt-5*)
 *
 * Omitting the parameter is always safe: the model then uses its own default.
 */
const REJECTS_SAMPLING: readonly RegExp[] = [
  /^claude-(?:fable|mythos)-/,
  /^claude-opus-(?:5|4-[78])(?:-|$)/,
  /^claude-sonnet-5(?:-|$)/,
  /^(?:o\d|gpt-5)(?:-|$|\.)/,
];

/** Strip a gateway prefix (`anthropic/…`) and normalise dotted versions (`4.8` → `4-8`). */
function canonicalModelId(model: string): string {
  return model.replace(/^[\w.-]+\//, '').replace(/\./g, '-').toLowerCase();
}

export function acceptsSamplingParams(model: string): boolean {
  const id = canonicalModelId(model);
  return !REJECTS_SAMPLING.some((rx) => rx.test(id));
}

/** `{ temperature }` when the model takes it, `{}` otherwise — spread into a request body. */
export function samplingParams(model: string, temperature: number): { temperature?: number } {
  return acceptsSamplingParams(model) ? { temperature } : {};
}
