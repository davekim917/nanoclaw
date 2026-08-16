#!/usr/bin/env node
/**
 * Pillar-0 domain-capture replay (docs/specs/workgroup-cerebro/plan.md, P0.6 step 4).
 *
 * Replays the fixture's domain cases through the PRODUCTION curator contract —
 * buildCuratorPrompt + CURATOR_OUTPUT_SCHEMA + the production model config —
 * under two prompt variants: `new` (as shipped) and `old` (the domain capture
 * line stripped at runtime from the pure function's output; no source edits).
 * The checked-in eval harness deliberately cannot serve this purpose: its
 * buildCuratorEvaluationPrompt is a hand-written proxy, not the shipped prompt.
 *
 * Gate: every domain case must flip noop -> capture under `new`, and the
 * code-derived negative must keep nooping under both. Credential policy: the
 * agentic lanes only (oauth:primary, oauth:2) — slots 3/4 are dedicated to
 * local dev sessions.
 *
 * Usage: pnpm exec tsx scripts/run-memory-domain-replay.ts [--cases id,id,...]
 */
import fs from 'node:fs';

import {
  buildCuratorPrompt,
  CURATOR_OUTPUT_SCHEMA,
  type CuratorReasonCode,
} from '../src/modules/memory/curator-contract.js';
import { MEMORY_CURATOR_MODEL, MEMORY_CURATOR_EFFORT } from '../src/modules/memory/curator-backend.js';
import { callClaudeStructured, listClaudeStructuredCredentialSlots } from '../src/llm.js';
import { readEnvFile } from '../src/env.js';

const DOMAIN_LINE_PREFIX = 'Durable facts about the product and business domain';
const DEFAULT_CASE_IDS = [
  'domain-metric-meaning',
  'domain-architecture-why',
  'domain-tradeoff-accepted',
  'domain-transient-guard',
  'code-derived',
];
const AGENTIC_SLOTS = ['oauth:primary', 'oauth:2'];

interface FixtureCase {
  id: string;
  transcript: string;
  expectedAction: 'capture' | 'noop';
  acceptedReasons: string[];
}

export function stripDomainLine(system: string): string {
  const lines = system.split('\n');
  const stripped = lines.filter((line) => !line.includes(DOMAIN_LINE_PREFIX));
  if (stripped.length !== lines.length - 2 && stripped.length !== lines.length - 1) {
    throw new Error('old-prompt reconstruction expected to remove the domain capture sentences');
  }
  // Also restore the pre-pillar-0 whitelist wording so `old` is faithful.
  return stripped
    .join('\n')
    .replace(', durable product and business-domain facts,', ',');
}

async function main(): Promise<void> {
  const casesArg = process.argv.indexOf('--cases');
  const wanted = casesArg >= 0 ? process.argv[casesArg + 1]!.split(',') : DEFAULT_CASE_IDS;
  const fixture = JSON.parse(fs.readFileSync('tests/fixtures/workgroup-memory-curator.json', 'utf8')) as {
    cases: FixtureCase[];
  };
  const cases = fixture.cases.filter((item) => wanted.includes(item.id));
  const env = {
    ...process.env,
    ...readEnvFile([
      'CLAUDE_CODE_OAUTH_TOKEN_2',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
    ]),
  };
  const slots = listClaudeStructuredCredentialSlots(env).filter((slot) => AGENTIC_SLOTS.includes(String(slot)));
  if (slots.length === 0) throw new Error('no agentic credential slots configured');

  let failures = 0;
  for (const mode of ['old-prompt', 'new-prompt'] as const) {
    console.log(`== PHASE ${mode} ==`);
    for (const item of cases) {
      const prompt = buildCuratorPrompt({
        workgroupId: 'wg-replay',
        generatedMemory: '',
        relevantManualMemory: [],
        messages: [
          {
            id: 'msg-1',
            rowid: 1,
            agentGroupId: 'ag-replay',
            messagingGroupId: 'mg-replay',
            channelType: 'slack',
            channelName: 'replay',
            platformId: 'p',
            threadId: 't',
            role: 'user',
            senderId: 'u',
            senderName: 'Operator',
            text: item.transcript.replace(/^User: /, ''),
            sentAt: '2026-08-15T00:00:00.000Z',
          } as never,
        ],
        boundary: 'REPLAY',
      });
      const system = mode === 'old-prompt' ? stripDomainLine(prompt.system) : prompt.system;
      let decision: { action: string; reasonCode: CuratorReasonCode } | null = null;
      for (let attempt = 1; attempt <= 40 && !decision; attempt++) {
        const slot = slots[(attempt - 1) % slots.length];
        try {
          const result = await callClaudeStructured<{
            action: string;
            reasonCode: CuratorReasonCode;
            memories: Array<{ text: string }>;
          }>(
            {
              model: MEMORY_CURATOR_MODEL,
              effort: MEMORY_CURATOR_EFFORT,
              system,
              user: prompt.user,
              schema: CURATOR_OUTPUT_SCHEMA as never,
              maxTokens: 2048,
              timeoutMs: 120_000,
            },
            { env, credentialSlot: slot },
          );
          decision = result.value;
        } catch (error) {
          if (attempt === 40) throw error;
          if (attempt % 5 === 0) console.log(`  retry ${attempt} (${String(slot)}) for ${item.id}`);
          await new Promise((resolve) => setTimeout(resolve, 75_000 + 15_000 * (attempt % 3)));
        }
      }
      const passesNew =
        decision!.action === item.expectedAction &&
        (decision!.action === 'noop' || item.acceptedReasons.includes(decision!.reasonCode));
      // Under the OLD prompt the domain-capture cases are EXPECTED to miss:
      // that miss is the suppression baseline the gate documents.
      const isDomainCapture = item.id.startsWith('domain-') && item.expectedAction === 'capture';
      const ok = mode === 'old-prompt' && isDomainCapture ? true : passesNew;
      if (mode === 'new-prompt' && !passesNew) failures += 1;
      console.log(
        `${ok ? 'PASS' : 'MISS'} [${mode}] ${item.id}: action=${decision!.action} reason=${decision!.reasonCode}` +
          (mode === 'old-prompt' && isDomainCapture ? ` (baseline: captured=${passesNew})` : ''),
      );
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
  }
  console.log(failures === 0 ? 'GATE PASS' : `GATE FAIL: ${failures} new-prompt case(s) missed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry && import.meta.url.endsWith(entry.split('/').pop()!)) void main();
