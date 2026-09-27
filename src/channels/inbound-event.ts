/**
 * The host's ingress producer: where an adapter's `onInbound` message becomes a routable `InboundEvent`. A named
 * function so tests drive the real producer rather than hand-built events.
 * The host stamps `instance` here (adapters stay instance-blind) and `nativeId`, the platform's own message id that
 * the router writes as `platformMsgId`. `nativeId` is set ONLY for genuine non-CLI ingress: the CLI adapter's plain
 * chat also arrives through `onInbound` but carries a synthesized `cli-<ms>-<rand>` id.
 */
import type { ChannelAdapter, InboundEvent, InboundMessage } from './adapter.js';

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
      // Trust-bearing only for genuine platform ingress; see adapter.ts InboundEvent.message.nativeId.
      nativeId: adapter.channelType === 'cli' ? undefined : message.id,
    },
  };
}
