/** The host clears a failure streak only on this report: a spawn on the primary proves nothing until it answers. */
import { randomUUID } from 'node:crypto';

import { getConfig } from './config.js';
import { writeMessageOut } from './db/messages-out.js';
import { getSessionRouting } from './db/session-routing.js';
import type { MessageInRow } from './db/messages-in.js';

let unconfirmed = true;

export function markProviderTurnUnconfirmed(): void {
  unconfirmed = true;
}

interface FallbackReturn {
  provider: string;
  from: string;
}

function fallbackReturnIn(messages: readonly MessageInRow[]): FallbackReturn | null {
  for (const message of messages) {
    try {
      const system = (JSON.parse(message.content) as { _system?: Record<string, unknown> })._system;
      if (
        system?.kind === 'provider_fallback_return' &&
        typeof system.provider === 'string' &&
        typeof system.from === 'string'
      ) {
        return { provider: system.provider, from: system.from };
      }
    } catch {}
  }
  return null;
}

export async function confirmProviderTurn(
  messages: readonly MessageInRow[],
  opts: { providerName: string; onFallback: boolean },
  log: (message: string) => void,
): Promise<void> {
  let fallbackProvider: string | undefined;
  try {
    fallbackProvider = getConfig().providerFallback?.provider;
  } catch {
    return;
  }
  if (!fallbackProvider) return;

  const back = opts.onFallback ? null : fallbackReturnIn(messages);
  if (back && back.provider.toLowerCase() === opts.providerName.toLowerCase()) {
    try {
      const routing = getSessionRouting();
      await writeMessageOut({
        id: `provider-return-note-${randomUUID()}`,
        kind: 'chat',
        platform_id: routing.platform_id,
        channel_type: routing.channel_type,
        thread_id: routing.thread_id,
        content: JSON.stringify({
          text: `⚙️ ${back.provider} is available again — this thread has moved back from ${back.from}.`,
          _system: { kind: 'provider_fallback_return', provider: back.provider, from: back.from },
        }),
      });
    } catch (err) {
      log(`Failed to post the provider-return note: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!unconfirmed) return;
  try {
    await writeMessageOut({
      id: `provider-turn-completed-${randomUUID()}`,
      kind: 'system',
      content: JSON.stringify({
        action: 'provider_turn_completed',
        provider: opts.providerName,
        completedAt: new Date().toISOString(),
      }),
    });
    unconfirmed = false;
  } catch (err) {
    log(`Failed to report a completed provider turn: ${err instanceof Error ? err.message : String(err)}`);
  }
}
