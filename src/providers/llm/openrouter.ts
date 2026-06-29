import { request } from 'undici';
import type { LLMProvider, LLMCompletionRequest, LLMCompletionResult } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';
import { getEnv } from '../../config/env';

/**
 * OpenRouter — OpenAI-compatible gateway; lets us reach Claude (or others)
 * WITHOUT a dedicated Anthropic key. Tier 2 / paid, OFF by default. The default
 * model is Claude via OpenRouter (DEFAULTS.llm.openrouterModel). A no-new-secret
 * path to the same judge.
 *
 * Endpoint: POST https://openrouter.ai/api/v1/chat/completions (chat-completions).
 */
export class OpenRouterProvider implements LLMProvider {
  readonly id = 'openrouter';
  readonly family = 'llm' as const;
  readonly tier = 2;
  readonly costPerCallEur = 0.02;

  available(): boolean {
    const e = getEnv();
    return e.OPENROUTER_ENABLED === true && typeof e.OPENROUTER_API_KEY === 'string' && e.OPENROUTER_API_KEY.length > 0;
  }

  async complete(req: LLMCompletionRequest, opts: { signal?: AbortSignal } = {}): Promise<LLMCompletionResult> {
    const e = getEnv();
    const apiKey = e.OPENROUTER_API_KEY;
    if (!apiKey) throw new ProviderBlockError(this.id, 'openrouter key missing');
    const model = e.OPENROUTER_MODEL;
    const system = [req.system, req.json_schema ? `Rispondi SOLO con JSON valido conforme a questo schema: ${JSON.stringify(req.json_schema)}` : '']
      .filter(Boolean)
      .join('\n\n');

    let res;
    try {
      res = await request('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        bodyTimeout: DEFAULTS.pipeline.requestTimeoutMs * 3,
        headersTimeout: DEFAULTS.pipeline.requestTimeoutMs * 3,
        signal: opts.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': DEFAULTS.http.userAgent,
        },
        body: JSON.stringify({
          model,
          max_tokens: req.max_tokens ?? DEFAULTS.llm.judgeMaxTokens,
          temperature: req.temperature ?? DEFAULTS.llm.temperature,
          messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: req.prompt }],
        }),
      });
    } catch (err) {
      throw err;
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, `openrouter auth failure (${res.statusCode})`);
    }
    if (res.statusCode === 429) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, 'openrouter rate limit (429)');
    }
    if (res.statusCode < 200 || res.statusCode >= 400) {
      await res.body.dump();
      throw new Error(`openrouter http ${res.statusCode}`);
    }

    let json: unknown;
    try {
      json = await res.body.json();
    } catch (err) {
      throw new Error(`openrouter json parse: ${(err as Error).message}`);
    }
    return { content: OpenRouterProvider.extractText(json), cost_eur: this.costPerCallEur, model, provider: this.id };
  }

  /** Pure parser, exposed for tests. */
  static extractText(json: unknown): string {
    if (!json || typeof json !== 'object') return '';
    const choices = (json as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return '';
    const msg = (choices[0] as { message?: { content?: unknown } }).message;
    return msg && typeof msg.content === 'string' ? msg.content.trim() : '';
  }
}
