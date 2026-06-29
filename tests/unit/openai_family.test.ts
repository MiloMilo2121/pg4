import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '../../src/providers/llm/openai_compatible';
import { OpenAIProvider, DeepSeekProvider, ZhipuGlmProvider, KimiProvider, PerplexityLlmProvider } from '../../src/providers/llm/openai_family';

describe('OpenAICompatibleProvider.extractText', () => {
  it('extracts choices[0].message.content', () => {
    const json = { choices: [{ message: { content: '  hello  ' } }] };
    expect(OpenAICompatibleProvider.extractText(json)).toBe('hello');
  });
  it('returns empty string on malformed shapes', () => {
    expect(OpenAICompatibleProvider.extractText(null)).toBe('');
    expect(OpenAICompatibleProvider.extractText({})).toBe('');
    expect(OpenAICompatibleProvider.extractText({ choices: [] })).toBe('');
    expect(OpenAICompatibleProvider.extractText({ choices: [{ message: {} }] })).toBe('');
  });
});

describe('OpenAI-compatible family factories', () => {
  const all = [
    { p: OpenAIProvider(), id: 'openai', roles: ['LLM_JUDGE', 'LLM_REASON', 'LLM_CHEAP', 'EMBEDDINGS'] },
    { p: DeepSeekProvider(), id: 'deepseek', roles: ['LLM_REASON', 'LLM_CHEAP'] },
    { p: ZhipuGlmProvider(), id: 'zhipu_glm', roles: ['LLM_CHEAP'] },
    { p: KimiProvider(), id: 'kimi', roles: ['LLM_CHEAP', 'LLM_REASON'] },
    { p: PerplexityLlmProvider(), id: 'perplexity', roles: ['LLM_REASON'] },
  ];

  it('each declares the right id, family, tier, roles', () => {
    for (const { p, id, roles } of all) {
      expect(p.id).toBe(id);
      expect(p.family).toBe('llm');
      expect(p.tier).toBe(2);
      expect(p.costPerCallEur).toBeGreaterThan(0);
      expect(p.roles).toEqual(roles);
    }
  });

  it('all are unavailable by default (paid-gate: no *_ENABLED set in test env)', () => {
    for (const { p } of all) expect(p.available()).toBe(false);
  });
});
