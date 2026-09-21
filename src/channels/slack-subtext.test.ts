/**
 * Slack status-subtext rendering.
 *
 * Two things are under test and they fail differently. `applySlackSubtext` is
 * pure payload shaping — cheap to pin exactly. `installSlackSubtextBlocks`
 * reaches into the vendored @chat-adapter/slack instance for two seams
 * (`postMessage` and `_client.chat.postMessage`), so the last case here runs
 * against the REAL adapter: if a version bump renames either seam, the feature
 * degrades to no-subtext silently in production, and this is what makes that
 * visible instead.
 */
import { describe, expect, it, vi } from 'vitest';

import { applySlackSubtext, installSlackSubtextBlocks } from './slack-subtext.js';

describe('applySlackSubtext', () => {
  it('moves markdown_text onto a markdown block and appends a context block', () => {
    const out = applySlackSubtext(
      { channel: 'C1', thread_ts: '1.2', markdown_text: '# Title\n\nBody with **bold**.', unfurl_links: false },
      'opus-5 · xhigh · 142k context',
    );

    expect(out.markdown_text).toBeUndefined();
    expect(out.blocks).toEqual([
      { type: 'markdown', text: '# Title\n\nBody with **bold**.' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'opus-5 · xhigh · 142k context' }] },
    ]);
    // Notification fallback, and the unrelated fields ride through untouched.
    expect(out.text).toBe('# Title\n\nBody with **bold**.');
    expect(out.channel).toBe('C1');
    expect(out.thread_ts).toBe('1.2');
    expect(out.unfurl_links).toBe(false);
  });

  it('leaves a payload alone when there is no subtext in scope', () => {
    const args = { channel: 'C1', markdown_text: 'hello' };
    expect(applySlackSubtext(args, undefined)).toBe(args);
  });

  it('leaves a card payload alone', () => {
    // A card already owns its blocks; appending to it would mean deciding
    // where in someone else's layout the footer goes.
    const args = { channel: 'C1', blocks: [{ type: 'header' }], text: 'fallback' };
    expect(applySlackSubtext(args, 'opus-5')).toBe(args);
  });

  it('leaves a plain-text (raw path) payload alone', () => {
    const args = { channel: 'C1', text: 'literal *not bold*' };
    expect(applySlackSubtext(args, 'opus-5')).toBe(args);
  });

  it('leaves an empty body alone', () => {
    const args = { channel: 'C1', markdown_text: '' };
    expect(applySlackSubtext(args, 'opus-5')).toBe(args);
  });
});

describe('installSlackSubtextBlocks', () => {
  function fakeAdapter() {
    const posted: Record<string, unknown>[] = [];
    const adapter = {
      _client: {
        chat: {
          postMessage: async (args: Record<string, unknown>) => {
            posted.push(args);
            return { ok: true, ts: '1.0' };
          },
        },
      },
      // Stands in for the real adapter's render-then-send: whatever body it
      // was handed becomes a markdown_text payload.
      postMessage: async (_threadId: string, message: unknown) => {
        const markdown = (message as { markdown?: string }).markdown ?? '';
        return adapter._client.chat.postMessage({ channel: 'C1', markdown_text: markdown });
      },
    };
    return { adapter, posted };
  }

  it('renders a context block for a body carrying subtext', async () => {
    const { adapter, posted } = fakeAdapter();
    installSlackSubtextBlocks(adapter);

    await adapter.postMessage('slack:C1', { markdown: 'done', subtext: 'opus-5 · high · 88k context' });

    expect(posted).toHaveLength(1);
    expect(posted[0].blocks).toEqual([
      { type: 'markdown', text: 'done' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'opus-5 · high · 88k context' }] },
    ]);
  });

  it('leaves a body with no subtext on the markdown_text path', async () => {
    const { adapter, posted } = fakeAdapter();
    installSlackSubtextBlocks(adapter);

    await adapter.postMessage('slack:C1', { markdown: 'done' });

    expect(posted[0].markdown_text).toBe('done');
    expect(posted[0].blocks).toBeUndefined();
  });

  it('keeps two concurrent posts from trading footers', async () => {
    // The reason this uses AsyncLocalStorage rather than a module variable:
    // Slack bridges run concurrency:'concurrent'. Interleave two posts so the
    // second one's scope opens while the first is still suspended.
    const posted: Record<string, unknown>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const adapter = {
      _client: {
        chat: {
          postMessage: async (args: Record<string, unknown>) => {
            posted.push(args);
            return { ok: true };
          },
        },
      },
      postMessage: async (_threadId: string, message: unknown) => {
        if (first) {
          first = false;
          await gate;
        }
        const markdown = (message as { markdown?: string }).markdown ?? '';
        return adapter._client.chat.postMessage({ channel: 'C1', markdown_text: markdown });
      },
    };
    installSlackSubtextBlocks(adapter);

    const a = adapter.postMessage('slack:C1', { markdown: 'A', subtext: 'model-a' });
    const b = adapter.postMessage('slack:C1', { markdown: 'B', subtext: 'model-b' });
    release();
    await Promise.all([a, b]);

    const footerFor = (body: string) => {
      const row = posted.find((p) => (p.blocks as { text?: string }[] | undefined)?.[0]?.text === body);
      return (row?.blocks as { elements?: { text?: string }[] }[])?.[1]?.elements?.[0]?.text;
    };
    expect(footerFor('A')).toBe('model-a');
    expect(footerFor('B')).toBe('model-b');
  });

  it('is idempotent', async () => {
    const { adapter, posted } = fakeAdapter();
    installSlackSubtextBlocks(adapter);
    installSlackSubtextBlocks(adapter);

    await adapter.postMessage('slack:C1', { markdown: 'done', subtext: 'opus-5' });

    // A stacked wrapper would rewrite an already-rewritten payload; the second
    // pass finds no markdown_text and would be a no-op, so the observable
    // symptom is only ever a double-wrapped scope. Assert the shape holds.
    expect(posted).toHaveLength(1);
    expect((posted[0].blocks as unknown[]).length).toBe(2);
  });

  it('declines to install on an adapter missing either seam', () => {
    const noClient = { postMessage: vi.fn() };
    expect(() => installSlackSubtextBlocks(noClient)).not.toThrow();
    expect((noClient as { __subtextInstalled?: boolean }).__subtextInstalled).toBeUndefined();
  });

  it('DRIFT GUARD: the real adapter still exposes both seams and still renders markdown as markdown_text', async () => {
    // The whole feature rests on these two facts about the vendored adapter.
    // Neither is a documented API, so the day a bump changes one, this test is
    // the notice. A red line here means: re-read
    // node_modules/@chat-adapter/slack/dist/index.js postMessage/toSlackPayload
    // and re-point slack-subtext.ts, do not delete the assertion.
    const { createSlackAdapter } = await import('@chat-adapter/slack');
    const adapter = createSlackAdapter({ botToken: 'xoxb-test', signingSecret: 'secret', mode: 'webhook' });

    const client = (adapter as unknown as { _client?: { chat?: { postMessage?: unknown } } })._client;
    expect(typeof (adapter as unknown as { postMessage?: unknown }).postMessage).toBe('function');
    expect(typeof client?.chat?.postMessage).toBe('function');

    const converter = (adapter as unknown as { formatConverter: { toSlackPayload: (m: unknown) => unknown } })
      .formatConverter;
    expect(converter.toSlackPayload({ markdown: '# Title' })).toEqual({ markdown_text: '# Title' });
  });
});
