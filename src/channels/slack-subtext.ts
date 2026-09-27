/**
 * Slack rendering for the status subtext (the small gray line naming model, effort and context). Slack's small print
 * is a `context` block, and a message may carry EITHER `markdown_text` OR `blocks`, never both, so a reply with a
 * subtext moves onto a blocks array whose `markdown` block renders the body identically.
 * Wraps the adapter's Web client rather than `postMessage`: the adapter's postMessage resolves mentions, normalizes
 * emoji and picks card/file/text paths, so it runs untouched and its final payload is rewritten.
 * The subtext travels in an AsyncLocalStorage scope, not a module variable: Slack bridges run concurrently and two
 * in-flight replies would trade footers.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const pendingSubtext = new AsyncLocalStorage<string>();

type SlackPostArgs = Record<string, unknown> & { markdown_text?: unknown; blocks?: unknown; text?: unknown };

/**
 * Returns the payload UNCHANGED unless it is exactly the shape understood here: no subtext, a card (`blocks`), a raw
 * `text` payload and an empty body all pass through.
 */
export function applySlackSubtext(args: SlackPostArgs, subtext: string | undefined): SlackPostArgs {
  if (!subtext) return args;
  const markdown = args.markdown_text;
  if (typeof markdown !== 'string' || !markdown) return args;
  if (args.blocks !== undefined) return args;

  const { markdown_text: _dropped, ...rest } = args;
  return {
    ...rest,
    // Fallback for notifications and clients that do not render blocks; Slack does not render `text` in the body once
    // `blocks` is present.
    text: markdown,
    blocks: [
      { type: 'markdown', text: markdown },
      { type: 'context', elements: [{ type: 'mrkdwn', text: subtext }] },
    ],
  };
}

function withSlackSubtext<T>(subtext: string | undefined, fn: () => T): T {
  return subtext ? pendingSubtext.run(subtext, fn) : fn();
}

/**
 * Two wrappers because the subtext and the payload never meet: `postMessage` receives the subtext and opens the
 * scope, `chat.postMessage` sees the rendered payload and reads it. Idempotent, so a reconnect cannot stack wrappers.
 */
export function installSlackSubtextBlocks(adapter: unknown): void {
  const target = adapter as {
    __subtextInstalled?: boolean;
    postMessage: (threadId: string, message: unknown) => Promise<unknown>;
    editMessage?: (threadId: string, messageId: string, message: unknown) => Promise<unknown>;
    _client?: {
      chat?: {
        postMessage: (args: SlackPostArgs) => Promise<unknown>;
        update?: (args: SlackPostArgs) => Promise<unknown>;
      };
    };
  };
  if (target.__subtextInstalled) return;
  const chat = target._client?.chat;
  if (typeof target.postMessage !== 'function' || !chat || typeof chat.postMessage !== 'function') {
    // An adapter version that renames either seam should lose the subtext, not the message; the drift test catches
    // this.
    return;
  }
  target.__subtextInstalled = true;

  const originalPost = target.postMessage.bind(adapter);
  target.postMessage = (threadId, message) => {
    const subtext =
      message && typeof message === 'object' && typeof (message as { subtext?: unknown }).subtext === 'string'
        ? ((message as { subtext: string }).subtext as string)
        : undefined;
    return withSlackSubtext(subtext, () => originalPost(threadId, message));
  };

  const originalChatPost = chat.postMessage.bind(chat);
  chat.postMessage = (args: SlackPostArgs) => originalChatPost(applySlackSubtext(args, pendingSubtext.getStore()));

  // Edits build the same `markdown_text` payload and send it with chat.update, so the same rewrite applies. Wrapped
  // separately so a missing seam costs only the edit's footer.
  if (typeof target.editMessage === 'function' && typeof chat.update === 'function') {
    const originalEdit = target.editMessage.bind(adapter);
    target.editMessage = (threadId, messageId, message) => {
      const subtext =
        message && typeof message === 'object' && typeof (message as { subtext?: unknown }).subtext === 'string'
          ? ((message as { subtext: string }).subtext as string)
          : undefined;
      return withSlackSubtext(subtext, () => originalEdit(threadId, messageId, message));
    };
    const originalChatUpdate = chat.update.bind(chat);
    chat.update = (args: SlackPostArgs) => originalChatUpdate(applySlackSubtext(args, pendingSubtext.getStore()));
  }
}
