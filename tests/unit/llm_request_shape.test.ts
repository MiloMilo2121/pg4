import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../../src/config/env';
import { acceptsSamplingParams, samplingParams } from '../../src/providers/llm/model_capabilities';
import { AnthropicProvider } from '../../src/providers/llm/anthropic';
import { OpenRouterProvider } from '../../src/providers/llm/openrouter';

describe('acceptsSamplingParams', () => {
  it.each([
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-fable-5-1',
    'claude-mythos-5',
    'anthropic/claude-opus-4-8',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-opus-5-5',
    'gpt-5',
    'gpt-5.5',
    'o3-mini',
  ])('%s rejects sampling parameters → omitted', (model) => {
    expect(acceptsSamplingParams(model)).toBe(false);
    expect(samplingParams(model, 0)).toEqual({});
  });

  it.each(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'gpt-4o-mini', 'deepseek-chat', 'anthropic/claude-3.5-sonnet'])(
    '%s keeps temperature',
    (model) => {
      expect(acceptsSamplingParams(model)).toBe(true);
      expect(samplingParams(model, 0)).toEqual({ temperature: 0 });
    },
  );

  it('does not mistake a different family for a listed one', () => {
    expect(acceptsSamplingParams('claude-opus-4-60')).toBe(true);
    expect(acceptsSamplingParams('claude-opus-50')).toBe(true);
    expect(acceptsSamplingParams('gpt-50')).toBe(true);
  });
});

/** Capture the JSON body an adapter POSTs, without touching the network. */
describe('adapter request bodies', () => {
  let agent: MockAgent;
  let previous: Dispatcher;
  let sent: Record<string, unknown> | undefined;

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    sent = undefined;
    process.env.ANTHROPIC_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.OPENROUTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'test-key';
  });
  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(previous);
    for (const k of ['ANTHROPIC_ENABLED', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'OPENROUTER_ENABLED', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL']) delete process.env[k];
    resetEnvCache();
  });

  function capture(origin: string, path: string, reply: unknown): void {
    agent
      .get(origin)
      .intercept({ path, method: 'POST' })
      .reply(200, (opts) => {
        sent = JSON.parse(String(opts.body)) as Record<string, unknown>;
        return reply;
      });
  }

  it('Anthropic: no temperature for claude-opus-4-8 (it would be a 400 on every judge call)', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8';
    resetEnvCache();
    capture('https://api.anthropic.com', '/v1/messages', { content: [{ type: 'text', text: '{"ok":true}' }] });
    const res = await new AnthropicProvider().complete({ prompt: 'p', temperature: 0 });
    expect(res.content).toBe('{"ok":true}');
    expect(sent).toBeDefined();
    expect(sent).not.toHaveProperty('temperature');
    expect(sent).toMatchObject({ model: 'claude-opus-4-8' });
  });

  it('Anthropic: keeps temperature for a model that accepts it', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-6';
    resetEnvCache();
    capture('https://api.anthropic.com', '/v1/messages', { content: [{ type: 'text', text: 'x' }] });
    await new AnthropicProvider().complete({ prompt: 'p', temperature: 0 });
    expect(sent).toMatchObject({ temperature: 0 });
  });

  it('OpenRouter: no temperature for anthropic/claude-opus-4-8, kept for an OpenAI chat model', async () => {
    process.env.OPENROUTER_MODEL = 'anthropic/claude-opus-4-8';
    resetEnvCache();
    capture('https://openrouter.ai', '/api/v1/chat/completions', { choices: [{ message: { content: 'x' } }] });
    await new OpenRouterProvider().complete({ prompt: 'p', temperature: 0 });
    expect(sent).not.toHaveProperty('temperature');

    process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini';
    resetEnvCache();
    sent = undefined;
    capture('https://openrouter.ai', '/api/v1/chat/completions', { choices: [{ message: { content: 'x' } }] });
    await new OpenRouterProvider().complete({ prompt: 'p', temperature: 0 });
    expect(sent).toMatchObject({ temperature: 0 });
  });
});
