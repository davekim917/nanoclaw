/**
 * Slack rendering for the status subtext — the small gray line under an
 * agent's own reply naming the model, effort and context it ran on.
 *
 * Slack's small print is a Block Kit `context` block, and a message may carry
 * EITHER `markdown_text` OR `blocks`, never both ("markdown_text is mutually
 * exclusive with text and blocks" — @chat-adapter/slack, matching
 * https://docs.slack.dev/reference/block-kit/blocks/markdown-block/). So a
 * reply with a subtext has to move off the `markdown_text` field the adapter
 * normally uses and onto a blocks array — where Slack's `markdown` block
 * carries the same full-fidelity markdown, so nothing about the body's
 * rendering changes.
 *
 * WHY THIS WRAPS THE WEB CLIENT AND NOT `postMessage`: the adapter's own
 * postMessage does work we must not lose — it resolves mentions against the
 * workspace, normalizes `:emoji:`, and decides between the card, file and text
 * paths. Rebuilding the call ourselves would mean reimplementing all of that
 * against a vendored dist. Instead the adapter runs untouched and produces its
 * normal payload, and we rewrite that payload at the last possible moment.
 *
 * The subtext reaches the rewrite through an AsyncLocalStorage scope opened
 * around the adapter's postMessage rather than a module-level variable,
 * because Slack bridges run with `concurrency: 'concurrent'` and two replies
 * in flight would otherwise trade footers.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** The subtext belonging to the postMessage/editMessage call currently on the stack. */
const pendingSubtext = new AsyncLocalStorage<string>();

/** A Slack chat.postMessage argument object, as far as this module cares. */
type SlackPostArgs = Record<string, unknown> & { markdown_text?: unknown; blocks?: unknown; text?: unknown };

/**
 * Rewrite a `markdown_text` payload into `blocks` + a trailing context block.
 *
 * Returns the payload UNCHANGED when there is nothing to do, which is the
 * common case and every unusual one: no subtext in scope, a card (already
 * `blocks`, and its own renderer owns its layout), a raw/plain-text payload
 * (`text`, taken by adapters that pre-render native syntax), or an empty body.
 * Rewriting only the exact shape we understand keeps this from silently
 * reshaping a message some other code path built.
 */
export function applySlackSubtext(args: SlackPostArgs, subtext: string | undefined): SlackPostArgs {
  if (!subtext) return args;
  const markdown = args.markdown_text;
  if (typeof markdown !== 'string' || !markdown) return args;
  if (args.blocks !== undefined) return args;

  const { markdown_text: _dropped, ...rest } = args;
  return {
    ...rest,
    // Notification/preview fallback for clients that do not render blocks.
    // Slack shows `text` in the sidebar and push notification and does NOT
    // render it in the message body once `blocks` is present, so carrying the
    // body here duplicates nothing.
    text: markdown,
    blocks: [
      { type: 'markdown', text: markdown },
      { type: 'context', elements: [{ type: 'mrkdwn', text: subtext }] },
    ],
  };
}

/**
 * Open the subtext scope for one adapter postMessage call.
 *
 * Exported for the bridge-side wrapper below and for tests; callers outside
 * this module should not need it.
 */
function withSlackSubtext<T>(subtext: string | undefined, fn: () => T): T {
  return subtext ? pendingSubtext.run(subtext, fn) : fn();
}

/**
 * Wire an adapter so a body carrying `subtext` posts with a context block.
 *
 * Two wrappers, because the subtext and the payload never meet in one place:
 * `postMessage` is where the subtext arrives (on the body the bridge built)
 * and `chat.postMessage` is where the payload exists (after the adapter has
 * rendered it). The first opens a scope, the second reads it.
 *
 * Idempotent: installing twice on one adapter is a no-op, so a reconnect path
 * that rebuilds a bridge over a live adapter cannot stack wrappers.
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
    // A future adapter version that renames either seam should lose the
    // subtext, not the message. The drift test asserts this does not happen
    // silently; here the safe answer is to leave the adapter alone.
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

  // Edits. An agent correcting its own reply goes through the adapter's
  // editMessage, which builds the same `markdown_text` payload as a post
  // (toSlackPayload) and sends it with chat.update, so the same rewrite
  // applies. Wrapped separately so an adapter missing either seam still posts
  // normally and only the edit loses its footer.
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
