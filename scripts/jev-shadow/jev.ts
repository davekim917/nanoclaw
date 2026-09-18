/**
 * Minimal TypeSafe System One client for the jev-shadow replays.
 *
 * Pinned to a versioned model, not the `jev-latest` alias: an alias moves on
 * release, and every threshold these replays report is only meaningful against
 * the model that produced it (docs.typesafe.ai/models, "Aliases").
 *
 * The key is read from the environment, else from this checkout's `.env`, and
 * never printed. This is a host-side, operator-run experiment; nothing here is
 * reachable from a container.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MODEL = 'jev-1.13.0';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// docs.typesafe.ai/models: $42 per billion input tokens; output tokens are free.
const PRICE_PER_INPUT_TOKEN = 42 / 1e9;

type Question =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface Answer {
  type: 'noul' | 'choice' | 'score';
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevResult {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  costUsd: number;
}

function readKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const envFile = path.resolve(import.meta.dirname, '../../.env');
  const line = fs
    .readFileSync(envFile, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('TYPESAFE_API_KEY='));
  if (!line) throw new Error(`TYPESAFE_API_KEY is neither in the environment nor in ${envFile}`);
  return line.slice('TYPESAFE_API_KEY='.length).trim().replace(/^['"]|['"]$/g, '');
}

let key: string | undefined;

export async function ask(state: unknown, questions: Record<string, Question>): Promise<JevResult> {
  key ??= readKey();
  const body = JSON.stringify({ state, model: MODEL, questions });
  for (let attempt = 0; ; attempt += 1) {
    const started = Date.now();
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if ((res.status === 429 || res.status === 529) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const out = (await res.json()) as Omit<JevResult, 'latencyMs' | 'costUsd'>;
    return { ...out, latencyMs: Date.now() - started, costUsd: out.usage.input_tokens * PRICE_PER_INPUT_TOKEN };
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}
