/**
 * Host-side client for TypeSafe's Jev: one `state` plus typed questions in, typed answers with probabilities out.
 * The key never enters this process: the OneCLI gateway proxy injects it, and without the secret granted to the
 * host's agent the gateway answers 403 and this throws.
 */
import { fetch as undiciFetch } from 'undici';

import { getProxyDispatcher } from './llm.js';

/** Pinned: a threshold tuned against one model means nothing after an alias moves. */
export const JEV_MODEL = 'jev-1.13.0';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** An object holds the question in one field and the data it refers to in others ("structured instructions"). */
type JevInstructions = string | Record<string, unknown>;

export type JevQuestion =
  | { type: 'noul'; instructions: JevInstructions; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: JevInstructions; criteria: Record<string, string> }
  | { type: 'score'; instructions: JevInstructions; criteria: string[] };

export interface JevAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export type JevFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  options: { timeoutMs?: number; fetch?: JevFetch } = {},
): Promise<Record<string, JevAnswer>> {
  const dispatcher = options.fetch ? null : getProxyDispatcher();
  // Fail closed: without the gateway proxy nothing injects the credential, yet the body would still leave the host.
  if (!options.fetch && !dispatcher) throw new Error('TypeSafe: no OneCLI gateway proxy configured');
  const fetchImpl: JevFetch =
    options.fetch ??
    ((url, init) =>
      dispatcher
        ? (undiciFetch(url, { ...init, dispatcher } as Parameters<
            typeof undiciFetch
          >[1]) as unknown as Promise<Response>)
        : fetch(url, init));
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}`);
  const body = (await res.json()) as { answers?: Record<string, JevAnswer> };
  return body.answers ?? {};
}
