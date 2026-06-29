import { request } from 'undici';
import type { LLMProvider, LLMCompletionRequest, LLMCompletionResult, ProviderRole } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';

/**
 * Shared base for every OpenAI-compatible chat-completions provider. OpenAI,
 * DeepSeek, Zhipu GLM, Kimi/Moonshot, Perplexity (and OpenRouter) all expose the
 * SAME `POST {baseUrl}/chat/completions` contract with a Bearer key — so instead
 * of five near-identical files we configure one base. Matches the existing
 * OpenRouterProvider behaviour (401/403/429 → ProviderBlockError, json_schema
 * folded into the system message, deterministic text extraction).
 *
 * Tier 2 / paid, OFF by default — `available()` requires both the enable flag and
 * a non-empty key (the config closures read the live env each call).
 */
export interface OpenAICompatConfig {
  id: string;
  /** Base URL WITHOUT the trailing /chat/completions. */
  baseUrl: () => string;
  apiKey: () => string | undefined;
  model: () => string;
  enabled: () => boolean;
  costPerCallEur: number;
  roles: ProviderRole[];
  tier?: number;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly family = 'llm' as const;
  readonly tier: number;
  readonly costPerCallEur: number;
  readonly roles: ReadonlyArray<ProviderRole>;

  constructor(private readonly cfg: OpenAICompatConfig) {
    this.id = cfg.id;
    this.tier = cfg.tier ?? 2;
    this.costPerCallEur = cfg.costPerCallEur;
    this.roles = cfg.roles;
  }

  available(): boolean {
    const key = this.cfg.apiKey();
    return this.cfg.enabled() === true && typeof key === 'string' && key.length > 0;
  }

  async complete(req: LLMCompletionRequest, opts: { signal?: AbortSignal } = {}): Promise<LLMCompletionResult> {
    const apiKey = this.cfg.apiKey();
    if (!apiKey) throw new ProviderBlockError(this.id, `${this.id} key missing`);
    const model = this.cfg.model();
    const url = `${this.cfg.baseUrl().replace(/\/$/, '')}/chat/completions`;
    const system = [req.system, req.json_schema ? `Rispondi SOLO con JSON valido conforme a questo schema: ${JSON.stringify(req.json_schema)}` : '']
      .filter(Boolean)
      .join('\n\n');

    const res = await request(url, {
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

    if (res.statusCode === 401 || res.statusCode === 403) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, `${this.id} auth failure (${res.statusCode})`);
    }
    if (res.statusCode === 429) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, `${this.id} rate limit (429)`);
    }
    if (res.statusCode < 200 || res.statusCode >= 400) {
      await res.body.dump();
      throw new Error(`${this.id} http ${res.statusCode}`);
    }

    let json: unknown;
    try {
      json = await res.body.json();
    } catch (err) {
      throw new Error(`${this.id} json parse: ${(err as Error).message}`);
    }
    return { content: OpenAICompatibleProvider.extractText(json), cost_eur: this.costPerCallEur, model, provider: this.id };
  }

  /** Pure parser, exposed for tests. Handles the standard choices[0].message.content shape. */
  static extractText(json: unknown): string {
    if (!json || typeof json !== 'object') return '';
    const choices = (json as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return '';
    const msg = (choices[0] as { message?: { content?: unknown } }).message;
    return msg && typeof msg.content === 'string' ? msg.content.trim() : '';
  }
}
