import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { OpenRouterProvider } from '../providers/llm/openrouter';
import type { RecoveryEnvelope } from '../runtime/run_coverage';

const ALLOWED_PREFIXES = ['src/discovery/', 'src/browser/', 'src/runtime/', 'tests/unit/'];
const FORBIDDEN_TEXT = [/--skip-preflight/i, /OPENROUTER_API_KEY/i, /GITHUB_TOKEN/i, /\.github\/workflows/i];

interface PatchResponse {
  summary: string;
  patch: string;
}

interface ReviewResponse {
  approve: boolean;
  reasons: string[];
}

function readJson(filePath: string): RecoveryEnvelope {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RecoveryEnvelope;
}

function stripFence(value: string): string {
  return value.replace(/^```[^\n]*\n?/i, '').replace(/\s*```$/, '').trim();
}

function assertSafePatch(patch: string): void {
  if (!patch || !patch.includes('diff --git ')) throw new Error('recovery agent did not return a unified diff');
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+++ b/')) continue;
    const target = line.slice('+++ b/'.length);
    if (!ALLOWED_PREFIXES.some((prefix) => target.startsWith(prefix))) {
      throw new Error(`recovery patch touches forbidden path: ${target}`);
    }
  }
  if (FORBIDDEN_TEXT.some((rule) => rule.test(patch))) throw new Error('recovery patch contains forbidden bypass or credential text');
}

function sourceContext(): string {
  const files = [
    'src/discovery/sources/maps_live.ts',
    'src/discovery/sources/pg_live.ts',
    'src/discovery/preflight.ts',
    'src/runtime/retry.ts',
    'src/runtime/run_coverage.ts',
  ];
  return files.map((file) => `--- ${file}\n${fs.readFileSync(path.resolve(file), 'utf8')}`).join('\n\n');
}

async function askForPatch(incident: RecoveryEnvelope): Promise<PatchResponse> {
  const provider = new OpenRouterProvider();
  if (!provider.available()) throw new Error('OpenRouter recovery agent is disabled or missing OPENROUTER_API_KEY');
  const result = await provider.complete({
    system: [
      'You are a constrained production recovery engineer.',
      'Return strict JSON with keys summary and patch. patch must be a unified git diff.',
      'Only change src/discovery, src/browser, src/runtime, or tests/unit.',
      'Never disable preflight or validation, never include secrets, and add a focused regression test.',
      'If the evidence cannot support a safe code fix, return an empty patch.',
    ].join(' '),
    prompt: `Incident envelope:\n${JSON.stringify(incident, null, 2)}\n\nCurrent implementation:\n${sourceContext()}`,
    temperature: 0,
    max_tokens: 8_000,
  });
  try {
    return JSON.parse(stripFence(result.content)) as PatchResponse;
  } catch (err) {
    throw new Error(`recovery agent returned invalid JSON: ${(err as Error).message}`);
  }
}

async function askForReview(incident: RecoveryEnvelope): Promise<ReviewResponse> {
  const provider = new OpenRouterProvider();
  if (!provider.available()) throw new Error('OpenRouter recovery reviewer is disabled or missing OPENROUTER_API_KEY');
  const diff = execFileSync('git', ['diff', '--no-ext-diff'], { encoding: 'utf8' });
  const result = await provider.complete({
    system: 'You are an independent strict code reviewer. Return strict JSON: {"approve":boolean,"reasons":string[]}. Reject missing regression tests, unsafe bypasses, credentials, or changes unrelated to the incident.',
    prompt: `Incident:\n${JSON.stringify(incident, null, 2)}\n\nProposed diff:\n${diff}`,
    temperature: 0,
    max_tokens: 4_000,
  });
  try {
    return JSON.parse(stripFence(result.content)) as ReviewResponse;
  } catch (err) {
    throw new Error(`recovery reviewer returned invalid JSON: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const incidentPath = process.argv[3];
  if ((mode !== 'patch' && mode !== 'review') || !incidentPath) {
    throw new Error('usage: recovery_agent.ts patch|review <incident.json>');
  }
  const incident = readJson(incidentPath);
  if (mode === 'patch') {
    const response = await askForPatch(incident);
    const patch = stripFence(response.patch);
    assertSafePatch(patch);
    const patchPath = path.resolve('.recovery-agent.patch');
    fs.writeFileSync(patchPath, patch, 'utf8');
    execFileSync('git', ['apply', '--check', patchPath], { stdio: 'inherit' });
    execFileSync('git', ['apply', patchPath], { stdio: 'inherit' });
    fs.unlinkSync(patchPath);
    process.stdout.write(`${response.summary}\n`);
    return;
  }
  const review = await askForReview(incident);
  if (!review.approve) throw new Error(`recovery reviewer rejected patch: ${review.reasons.join('; ')}`);
  process.stdout.write('recovery reviewer approved patch\n');
}

main().catch((err) => {
  process.stderr.write(`recovery agent failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
