/**
 * The OpenAI-compatible LLM family — thin configs over OpenAICompatibleProvider.
 * One file so the cascade's LLM tier is declared in one place. Each is tier-2/paid,
 * OFF by default; keys recovered into .env (gitignored). Costs are €/call estimates
 * from docs/provider_integration_specs.md (authoritative per addendum R7).
 *
 * Roles (per role_registry.ts):
 *  - openai    → LLM_JUDGE, LLM_REASON, LLM_CHEAP, EMBEDDINGS
 *  - deepseek  → LLM_REASON, LLM_CHEAP
 *  - zhipu_glm → LLM_CHEAP
 *  - kimi      → LLM_CHEAP, LLM_REASON (long-context)
 *  - perplexity→ LLM_REASON (grounded answer; addendum R6: LLM role, NOT SEARCH_WEB)
 */
import { getEnv } from '../../config/env';
import { OpenAICompatibleProvider } from './openai_compatible';

export const OpenAIProvider = () =>
  new OpenAICompatibleProvider({
    id: 'openai',
    baseUrl: () => getEnv().OPENAI_BASE_URL,
    apiKey: () => getEnv().OPENAI_API_KEY,
    model: () => getEnv().OPENAI_MODEL,
    enabled: () => getEnv().OPENAI_ENABLED === true,
    costPerCallEur: 0.01,
    roles: ['LLM_JUDGE', 'LLM_REASON', 'LLM_CHEAP', 'EMBEDDINGS'],
  });

export const DeepSeekProvider = () =>
  new OpenAICompatibleProvider({
    id: 'deepseek',
    baseUrl: () => getEnv().DEEPSEEK_BASE_URL,
    apiKey: () => getEnv().DEEPSEEK_API_KEY,
    model: () => getEnv().DEEPSEEK_MODEL,
    enabled: () => getEnv().DEEPSEEK_ENABLED === true,
    costPerCallEur: 0.002,
    roles: ['LLM_REASON', 'LLM_CHEAP'],
  });

export const ZhipuGlmProvider = () =>
  new OpenAICompatibleProvider({
    id: 'zhipu_glm',
    baseUrl: () => getEnv().ZHIPU_BASE_URL,
    apiKey: () => getEnv().ZHIPU_API_KEY,
    model: () => getEnv().ZHIPU_MODEL,
    enabled: () => getEnv().ZHIPU_ENABLED === true,
    costPerCallEur: 0.0003,
    roles: ['LLM_CHEAP'],
  });

export const KimiProvider = () =>
  new OpenAICompatibleProvider({
    id: 'kimi',
    baseUrl: () => getEnv().KIMI_BASE_URL,
    apiKey: () => getEnv().KIMI_API_KEY,
    model: () => getEnv().KIMI_MODEL,
    enabled: () => getEnv().KIMI_ENABLED === true,
    costPerCallEur: 0.001,
    roles: ['LLM_CHEAP', 'LLM_REASON'],
  });

export const PerplexityLlmProvider = () =>
  new OpenAICompatibleProvider({
    id: 'perplexity',
    baseUrl: () => getEnv().PERPLEXITY_BASE_URL,
    apiKey: () => getEnv().PERPLEXITY_API_KEY,
    model: () => getEnv().PERPLEXITY_MODEL,
    enabled: () => getEnv().PERPLEXITY_ENABLED === true,
    costPerCallEur: 0.012,
    roles: ['LLM_REASON'],
  });
