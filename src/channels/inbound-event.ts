/**
 * The host's ingress producer: the one place an adapter's `onInbound`
 * message becomes a routable `InboundEvent`.
 *
 * This exists as a named function rather than a closure inside `main()` for
 * one reason — it is where `nativeId` is decided, and `nativeId` is the field
 * the router stamps into a written row's `platformMsgId` (src/router.ts, the
 * single write site) and the runner renders as `platform_msg_id`. A test can
 * only prove the CLI exclusion and the assignment itself by driving the
 * producer; poking `nativeId` into a hand-built event proves nothing about
 * either (review finding, PR #710).
 *
 * Two host-side stampings happen here and nowhere else:
 *
 *   - `instance` — adapters stay instance-blind; the host stamps the
 *     receiving instance on every inbound event.
 *   - `nativeId` — the platform's own confirmed message id, set ONLY for
 *     genuine, non-CLI adapter ingress. `message.id` is the routing/dedup key
 *     and is set for every event, synthetic or not; the CLI adapter's own
 *     "plain chat" path arrives through `onInbound` too (src/channels/cli.ts)
 *     but mints a host-synthesized `cli-<ms>-<rand>` id, so it is excluded
 *     exactly as every `onInboundEvent` caller is — those build their own
 *     `InboundEvent` and never come through here at all.
 */
import type { ChannelAdapter, InboundEvent, InboundMessage } from './adapter.js';

/** The adapter identity this producer needs: its channel type and instance. */
export type IngressAdapter = Pick<ChannelAdapter, 'channelType' | 'instance'>;

export function adapterInboundEvent(
  adapter: IngressAdapter,
  platformId: string,
  threadId: string | null,
  message: InboundMessage,
): InboundEvent {
  return {
    channelType: adapter.channelType,
    instance: adapter.instance ?? adapter.channelType,
    platformId,
    threadId,
    isDM: message.isDM,
    recovered: message.recovered,
    message: {
      id: message.id,
      kind: message.kind,
      content: JSON.stringify(message.content),
      timestamp: message.timestamp,
      isMention: message.isMention,
      isGroup: message.isGroup,
      // Trust-bearing only for genuine platform ingress — see the file
      // comment and adapter.ts InboundEvent.message.nativeId.
      nativeId: adapter.channelType === 'cli' ? undefined : message.id,
    },
  };
}
