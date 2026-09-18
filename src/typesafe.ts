/**
 * Host-side client for TypeSafe's Jev (docs.typesafe.ai): send one `state`
 * and a map of typed questions, get typed answers with probabilities back.
 *
 * The key is never in this process. Requests go through the OneCLI gateway
 * proxy (the same dispatcher `src/llm.ts` uses for Anthropic), which injects
 * the `TypeSafe` secret for api.typesafe.ai — the host's OneCLI agent needs
 * that secret granted, otherwise the gateway answers 403 and this throws.
 */
import { fetch as undiciFetch } from 'undici';

import { getProxyDispatcher } from './llm.js';

/** Pinned: a threshold tuned against one model means nothing after an alias moves. */
export const JEV_MODEL = 'jev-1.13.0';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

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
  // Fail closed: without the gateway proxy nothing injects the credential, and
  // the request body would still leave the host. Never send it direct.
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
