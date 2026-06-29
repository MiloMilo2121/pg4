import { request } from 'undici';
import type { LLMProvider, LLMCompletionRequest, LLMCompletionResult } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';
import { getEnv } from '../../config/env';

/**
 * Anthropic (Claude) — the default judge LLM for the judgment layer (L4/L5).
 *
 * Tier 2 / paid. OFF by default (paid-gate). Available only when
 * `ANTHROPIC_ENABLED=true` AND `ANTHROPIC_API_KEY` is set. The router-level paid
 * gate is the load-bearing safeguard; `available()` only reports availability.
 *
 * Endpoint: POST https://api.anthropic.com/v1/messages
 * Auth:     header `x-api-key` + `anthropic-version`
 *
 * Structured output: the Anthropic Messages API has no JSON-schema mode here, so
 * the judge prompts instruct "JSON only matching the schema"; callers validate
 * + retry. `json_schema` is forwarded into the system prompt as a contract hint.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly family = 'llm' as const;
  readonly tier = 2;
  readonly costPerCallEur = 0.02;

  available(): boolean {
    const e = getEnv();
    return e.ANTHROPIC_ENABLED === true && typeof e.ANTHROPIC_API_KEY === 'string' && e.ANTHROPIC_API_KEY.length > 0;
  }

  async complete(req: LLMCompletionRequest, opts: { signal?: AbortSignal } = {}): Promise<LLMCompletionResult> {
    const e = getEnv();
    const apiKey = e.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ProviderBlockError(this.id, 'anthropic key missing');
    const model = e.ANTHROPIC_MODEL;
    const system = [req.system, req.json_schema ? `Rispondi SOLO con JSON valido conforme a questo schema: ${JSON.stringify(req.json_schema)}` : '']
      .filter(Boolean)
      .join('\n\n');

    let res;
    try {
      res = await request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        bodyTimeout: DEFAULTS.pipeline.requestTimeoutMs * 3, // LLM is slower than a SERP
        headersTimeout: DEFAULTS.pipeline.requestTimeoutMs * 3,
        signal: opts.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': DEFAULTS.http.userAgent,
        },
        body: JSON.stringify({
          model,
          max_tokens: req.max_tokens ?? DEFAULTS.llm.judgeMaxTokens,
          temperature: req.temperature ?? DEFAULTS.llm.temperature,
          system: system || undefined,
          messages: [{ role: 'user', content: req.prompt }],
        }),
      });
    } catch (err) {
      throw err; // transport/timeout → router classifies + breaker sees it
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, `anthropic auth failure (${res.statusCode})`);
    }
    if (res.statusCode === 429) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, 'anthropic rate limit (429)');
    }
    if (res.statusCode < 200 || res.statusCode >= 400) {
      await res.body.dump();
      throw new Error(`anthropic http ${res.statusCode}`);
    }

    let json: unknown;
    try {
      json = await res.body.json();
    } catch (err) {
      throw new Error(`anthropic json parse: ${(err as Error).message}`);
    }
    return { content: AnthropicProvider.extractText(json), cost_eur: this.costPerCallEur, model, provider: this.id };
  }

  /** Pure parser, exposed for tests. Concatenates text content blocks. */
  static extractText(json: unknown): string {
    if (!json || typeof json !== 'object') return '';
    const content = (json as { content?: unknown }).content;
    if (!Array.isArray(content)) return '';
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join('')
      .trim();
  }
}
