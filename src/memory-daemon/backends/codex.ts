/**
 * Codex backend for the classifier-client facade. Wraps the `codex` CLI as a
 * subprocess using the same structured-output discipline as /team-qa Validator E:
 *   - --yolo to bypass the bwrap sandbox (we run inside an externally-sandboxed
 *     systemd unit; double sandbox = SIGTRAP)
 *   - --ephemeral so each call has no persisted session state
 *   - --output-schema to enforce JSON shape at the CLI layer
 *   - --output-last-message to capture the structured output to a file (more
 *     reliable than parsing stdout, which may include progress text)
 *   - --config model_reasoning_effort=<level> for the effort knob
 *   - </dev/null for stdin (codex hangs forever otherwise — stdin-watch mode
 *     even when prompt is passed as argv)
 *
 * Trade-offs vs the Anthropic backend:
 *   - LOSE Anthropic's `cache_control: ephemeral` prompt caching. Each call
 *     ships the full ~5K system prompt fresh. OpenAI does implicit caching
 *     server-side for repeated prefixes but it isn't surfaced via the CLI.
 *   - SPAWN cost ~200-500ms per call (CLI startup). Acceptable in the daemon's
 *     60s async sweep loop; not acceptable in tight loops.
 *   - LOSE structured fetch errors. We capture exit code, stderr, and parse
 *     errors and log them; production telemetry hooks emit to memory-health.json
 *     via the daemon's health recorder when available.
 *
 * Auth: relies on `codex` CLI being authenticated already (`codex login` on
 * the host). This subprocess does not handle credentials directly.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import type { CallClassifierOpts, ClassifierBackend, Effort } from '../classifier-client.js';
import { ClassifierParseError, stripCodeFence, validateClassifierOutput } from '../classifier-client.js';

export interface CodexBackendOpts {
  model: string;
  effort: Effort;
}

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';

// JSON Schema that codex CLI enforces on the model's output. Matches
// ClassifierOutput exactly so validateClassifierOutput is mostly a no-op
// when the schema fires — defense in depth covers the case where codex
// validates loosely.
const CLASSIFIER_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['worth_storing', 'facts'],
  additionalProperties: false,
  properties: {
    worth_storing: { type: 'boolean' },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['content', 'category', 'importance', 'entities', 'source_role'],
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          category: { type: 'string', enum: ['preference', 'decision', 'insight', 'fact', 'context'] },
          importance: { type: 'number', minimum: 1, maximum: 5 },
          entities: { type: 'array', items: { type: 'string' } },
          source_role: { type: 'string', enum: ['user', 'assistant', 'joint', 'external'] },
        },
      },
    },
  },
};

function effortToCodexFlag(effort: Effort): string | null {
  switch (effort) {
    case 'default':
      return null;
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
  }
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
  signal: NodeJS.Signals | null;
}

function runCodex(args: string[], opts: { signal?: AbortSignal; timeoutMs: number }): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'], // </dev/null for stdin — required (see file header)
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    let killed = false;
    const cleanup = () => {
      if (killed) return;
      killed = true;
      try {
        child.kill('SIGTERM');
        // Give it 500ms to exit gracefully, then SIGKILL.
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, 500);
      } catch {
        /* already dead */
      }
    };

    const timer = setTimeout(cleanup, opts.timeoutMs);
    const onAbort = () => cleanup();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code: code ?? 1, signal });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout: '', stderr: err.message, code: 1, signal: null });
    });
  });
}

export function makeCodexBackend(opts: CodexBackendOpts): ClassifierBackend {
  const codexEffort = effortToCodexFlag(opts.effort);

  return async function callClassifierCodex(
    systemPrompt: string,
    userPrompt: string,
    callOpts?: CallClassifierOpts,
  ) {
    const timeoutMs = callOpts?.timeoutMs ?? 30_000;

    // Each call gets its own tempdir so concurrent sweeps don't trample each
    // other's schema/output files. mkdtempSync returns a unique-by-mtime name.
    const tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'mnemon-classify-'));
    const schemaPath = path.join(tmpDir, 'schema.json');
    const outputPath = path.join(tmpDir, 'output.json');

    try {
      fs.writeFileSync(schemaPath, JSON.stringify(CLASSIFIER_OUTPUT_SCHEMA), 'utf8');

      // Combine system + user prompts. Codex CLI doesn't have a separate system-
      // prompt slot the way the Anthropic API does; we concatenate with a
      // visible boundary so the model treats the user-prompt section as the
      // input being classified.
      const combinedPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

      const args: string[] = [
        'exec',
        '--yolo',
        '--ephemeral',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        '--model',
        opts.model,
      ];
      if (codexEffort) {
        args.push('--config', `model_reasoning_effort=${codexEffort}`);
      }
      // The prompt goes as the final positional argument.
      args.push(combinedPrompt);

      const result = await runCodex(args, { timeoutMs, signal: callOpts?.signal });

      if (result.code !== 0) {
        throw new ClassifierParseError(
          `codex exec exited with code ${result.code}${result.signal ? ` (signal=${result.signal})` : ''}: ${result.stderr.slice(0, 500)}`,
        );
      }

      let outputContent: string;
      try {
        outputContent = fs.readFileSync(outputPath, 'utf8');
      } catch (err) {
        throw new ClassifierParseError(
          `codex output file unreadable (${(err as Error).message}); stdout: ${result.stdout.slice(0, 300)}`,
        );
      }

      // Codex's --output-last-message file may itself be a JSON envelope that
      // wraps the model's text. Try to parse the full content first; fall back
      // to fence-stripping + balanced-brace extraction (same heuristics the
      // Anthropic backend uses for code-fenced responses).
      const cleaned = stripCodeFence(outputContent);
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        throw new ClassifierParseError(
          `codex output is not valid JSON: ${cleaned.slice(0, 200)}`,
        );
      }

      return validateClassifierOutput(parsed);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  };
}
