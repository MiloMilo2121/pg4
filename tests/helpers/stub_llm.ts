import type { JudgeLLM } from '../../src/judgment/judges/shared';
import type { LLMCompletionRequest } from '../../src/types/providers';

/**
 * A scripted `JudgeLLM` for tests that exercise the LLM branch of the judges
 * without a network. Each call returns the next scripted reply (objects are
 * JSON-encoded, strings pass through, `null` simulates an empty completion);
 * the last reply repeats once the script is exhausted. Every request is kept
 * in `calls` so a test can assert on the prompt the judge actually sent.
 */
export interface StubLLM extends JudgeLLM {
  calls: LLMCompletionRequest[];
}

export function stubLLM(...replies: Array<object | string | null>): StubLLM {
  const calls: LLMCompletionRequest[] = [];
  const llm = (async (req: LLMCompletionRequest) => {
    calls.push(req);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply === undefined || reply === null) return null;
    return typeof reply === 'string' ? reply : JSON.stringify(reply);
  }) as StubLLM;
  llm.calls = calls;
  return llm;
}
