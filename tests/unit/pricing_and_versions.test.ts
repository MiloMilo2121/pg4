import { describe, expect, it } from 'vitest';
import { CALL_COST_EUR, HUNTER_OP_COST_EUR } from '../../src/providers/pricing';
import { ROLE_REGISTRY } from '../../src/providers/role_registry';
import { ExaProvider } from '../../src/providers/serp/exa';
import { SerperProvider } from '../../src/providers/serp/serper';
import { TavilyProvider } from '../../src/providers/serp/tavily';
import { FirecrawlProvider } from '../../src/providers/http/firecrawl';
import { BrightDataUnlockerProvider } from '../../src/providers/http/brightdata';
import { AnthropicProvider } from '../../src/providers/llm/anthropic';
import { OpenRouterProvider } from '../../src/providers/llm/openrouter';
import { OpenAIProvider, DeepSeekProvider, ZhipuGlmProvider, KimiProvider, PerplexityLlmProvider } from '../../src/providers/llm/openai_family';
import { DEFAULT_MODELS } from '../../src/config/models';
import { CHROME_MAJOR, FIREFOX_MAJOR } from '../../src/config/browser_versions';
import { DEFAULTS } from '../../src/config/defaults';
import { DEFAULT_USER_AGENT, USER_AGENTS, fingerprintFor } from '../../src/runtime/fingerprint';

describe('one price table: adapters and the role registry cannot drift apart', () => {
  it('every adapter charges exactly what the table says', () => {
    expect(new SerperProvider().costPerCallEur).toBe(CALL_COST_EUR.serper);
    expect(new TavilyProvider().costPerCallEur).toBe(CALL_COST_EUR.tavily);
    expect(new ExaProvider().costPerCallEur).toBe(CALL_COST_EUR.exa);
    expect(new FirecrawlProvider().costPerCallEur).toBe(CALL_COST_EUR.firecrawl);
    expect(new BrightDataUnlockerProvider().costPerCallEur).toBe(CALL_COST_EUR.brightdata);
    expect(new AnthropicProvider().costPerCallEur).toBe(CALL_COST_EUR.anthropic);
    expect(new OpenRouterProvider().costPerCallEur).toBe(CALL_COST_EUR.openrouter);
    expect(OpenAIProvider().costPerCallEur).toBe(CALL_COST_EUR.openai);
    expect(DeepSeekProvider().costPerCallEur).toBe(CALL_COST_EUR.deepseek);
    expect(ZhipuGlmProvider().costPerCallEur).toBe(CALL_COST_EUR.zhipu_glm);
    expect(KimiProvider().costPerCallEur).toBe(CALL_COST_EUR.kimi);
    expect(PerplexityLlmProvider().costPerCallEur).toBe(CALL_COST_EUR.perplexity);
  });

  it('the plan (role registry) budgets at least what the ledger will record — never less', () => {
    const table: Record<string, number> = { ...CALL_COST_EUR, brightdata_serp: CALL_COST_EUR.brightdata, brightdata_unlocker: CALL_COST_EUR.brightdata };
    for (const entry of ROLE_REGISTRY) {
      for (const step of entry.steps) {
        if (!step.paid) continue;
        const charged = table[step.providerId];
        if (charged !== undefined) expect(step.costEur, `${entry.role}/${step.providerId}`).toBe(charged);
      }
    }
  });

  it('Tavily and Exa were under-charged by their adapters (0.005 vs vendor price); regression lock', () => {
    expect(new TavilyProvider().costPerCallEur).toBeGreaterThan(0.005);
    expect(new ExaProvider().costPerCallEur).toBeGreaterThan(0.005);
  });

  it('Hunter charges per operation', () => {
    expect(HUNTER_OP_COST_EUR.verify).toBeLessThan(HUNTER_OP_COST_EUR.find);
  });
});

describe('model defaults are not retired ids', () => {
  it.each([
    ['deepseek', 'deepseek-chat'],
    ['zhipu', 'glm-4-flash'],
    ['kimi', 'moonshot-v1-8k'],
  ] as const)('%s no longer defaults to %s', (provider, retired) => {
    expect(DEFAULT_MODELS[provider]).not.toBe(retired);
  });

  it('DEFAULTS.llm is fed by the registry', () => {
    expect(DEFAULTS.llm.anthropicModel).toBe(DEFAULT_MODELS.anthropic);
    expect(DEFAULTS.llm.openrouterModel).toBe(DEFAULT_MODELS.openrouter);
  });
});

describe('browser fingerprints come from one version table', () => {
  it('every Chrome UA and its client hints agree on the same major; Firefox uses its own', () => {
    for (const ua of USER_AGENTS) {
      const chrome = ua.match(/Chrome\/(\d+)\./)?.[1];
      const firefox = ua.match(/Firefox\/(\d+)\./)?.[1];
      if (chrome) expect(Number(chrome)).toBe(CHROME_MAJOR);
      if (firefox) expect(Number(firefox)).toBe(FIREFOX_MAJOR);
    }
    expect(DEFAULT_USER_AGENT).toContain(`Chrome/${CHROME_MAJOR}.`);
    expect(DEFAULTS.http.userAgent).toContain(`Chrome/${CHROME_MAJOR}.`);
  });

  it('client hints match the UA browser (Chrome brands carry the same major)', () => {
    for (const host of ['a.example', 'b.example', 'c.example', 'd.example', 'e.example', 'f.example']) {
      const fp = fingerprintFor(host);
      const hint = fp.headers['sec-ch-ua'];
      if (fp.userAgent.includes('Chrome/')) expect(hint).toContain(`v="${CHROME_MAJOR}"`);
      else expect(hint).toBeUndefined();
    }
  });
});
