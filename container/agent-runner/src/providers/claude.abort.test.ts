import { describe, it, expect, mock } from 'bun:test';

/**
 * Deliverable B: aborting a query must kill the underlying CLI child, not
 * just stop reading from it. Before this fix, `abort()` only set a flag and
 * ended the input stream — the SDK's own graceful-close path runs on stdin
 * EOF, but nothing forced it, so an abandoned query (e.g. one interrupted by
 * a credential rotation) could keep its CLI child running on the exhausted
 * credential and burn another failure minutes after the replay was already
 * healthy. `options.abortController` is the SDK's documented mechanism for
 * an immediate teardown (sdk.d.ts `Options.abortController`).
 */

let capturedOptions: Record<string, unknown> | null = null;
let controllerRef: AbortController | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    capturedOptions = args.options ?? null;
    controllerRef = capturedOptions?.abortController as AbortController | undefined;
    // Mirrors the real SDK's shape closely enough for this test: the async
    // generator hangs until the caller's AbortController fires, then rejects
    // with the same "aborted"-classified error the real SDK's ProcessTransport
    // produces on an intentional abort (see sdk.mjs `Ly()` / errorClass:
    // "aborted") — the case translateEvents's `if (aborted) return;` guard,
    // plus the wrapping try/catch this fix adds, must swallow rather than
    // surface as an `error` event.
    const gen = (async function* () {
      await new Promise<void>((_resolve, reject) => {
        controllerRef?.signal.addEventListener('abort', () => {
          const err = new Error('Claude Code process aborted by user');
          (err as Error & { errorClass?: string }).errorClass = 'aborted';
          reject(err);
        });
      });
    })() as AsyncGenerator & {
      setModel: (m?: string) => Promise<void>;
      applyFlagSettings: (s: Record<string, unknown>) => Promise<void>;
    };
    gen.setModel = () => Promise.resolve();
    gen.applyFlagSettings = () => Promise.resolve();
    return gen;
  },
}));

const realContainerState = await import('../db/container-state.js');
mock.module('../db/container-state.js', () => ({
  ...realContainerState,
  clearContainerToolInFlight: () => {},
  setContainerToolInFlight: () => {},
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

function makeProvider(): InstanceType<typeof ClaudeProvider> {
  const p = new ClaudeProvider();
  p.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return p;
}

describe('ClaudeProvider.query().abort() tears the CLI child down', () => {
  it('passes a real AbortController as options.abortController, unaborted at query start', () => {
    capturedOptions = null;
    controllerRef = undefined;
    const provider = makeProvider();
    provider.query({ prompt: 'x', cwd: '/tmp' });
    expect(capturedOptions?.abortController).toBeInstanceOf(AbortController);
    expect((capturedOptions?.abortController as AbortController).signal.aborted).toBe(false);
  });

  it('abort() aborts that same controller', () => {
    capturedOptions = null;
    controllerRef = undefined;
    const provider = makeProvider();
    const query = provider.query({ prompt: 'x', cwd: '/tmp' });
    query.abort();
    expect(controllerRef?.signal.aborted).toBe(true);
  });

  it('abort() is idempotent — a second call does not throw', () => {
    const provider = makeProvider();
    const query = provider.query({ prompt: 'x', cwd: '/tmp' });
    query.abort();
    expect(() => query.abort()).not.toThrow();
  });

  it('an intentional abort does not surface as an error event', async () => {
    capturedOptions = null;
    controllerRef = undefined;
    const provider = makeProvider();
    const query = provider.query({ prompt: 'x', cwd: '/tmp' });

    const events: unknown[] = [];
    let threw: unknown = null;
    const consume = (async () => {
      try {
        for await (const event of query.events) events.push(event);
      } catch (err) {
        threw = err;
      }
    })();

    // Let the generator start (register its abort listener) before aborting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    query.abort();
    await consume;

    expect(threw).toBeNull();
    expect(events.some((e) => (e as { type?: string }).type === 'error')).toBe(false);
  });
});
