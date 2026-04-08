import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  OnGateAction,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  /**
   * Invoked when a channel-native interactive gate control (Slack button,
   * Discord button) is activated by a user. Wired to resolveInMemoryGate
   * in index.ts so the plugin hook poll unblocks.
   */
  onGateAction?: OnGateAction;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
