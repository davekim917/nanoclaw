import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  options: null as unknown,
  respond: null as unknown,
  request: null as unknown,
  lookup: vi.fn(),
}));
vi.mock('node:dns', () => ({ default: { lookup: harness.lookup } }));
vi.mock('node:https', () => ({
  default: {
    get: (_url: URL, options: unknown, respond: unknown) => {
      harness.options = options;
      harness.respond = respond;
      return harness.request;
    },
  },
}));
import { retrieveSource } from './sources.js';
import { parsePolicy, digest } from './policy.js';

const policy = parsePolicy({
  version: 1,
  workgroupId: 'example',
  repository: 'wiki',
  defaultRef: 'refs/heads/main',
  writerGroupId: 'writer',
  verifierGroupId: 'verifier',
  seriesId: 'synth-example',
  sourcePrefixes: ['https://primary.example/'],
  notification: { channelType: 'test', platformId: 'example', threadId: null },
});
class Response extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = { 'content-type': 'text/plain' };
  complete = true;
  destroy(error: Error) {
    this.emit('error', error);
    this.emit('close');
    return this;
  }
}
function start() {
  const request = new Response();
  harness.request = request;
  const result = retrieveSource('https://primary.example/materials', policy).finally(() => request.emit('close'));
  return {
    result,
    respond: harness.respond as (response: Response) => void,
    options: harness.options as {
      agent: boolean;
      family: number;
      headers: Record<string, string>;
      lookup: (host: string, options: object, callback: (...args: unknown[]) => void) => void;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  harness.lookup.mockReset();
});
describe('actual primary-fetch transport contract', () => {
  it('returns the full body and digest with no proxy, cookies or credentials', async () => {
    const { result, respond, options } = start();
    const response = new Response();
    respond(response);
    response.emit('data', Buffer.from('primary '));
    response.emit('data', Buffer.from('statement'));
    response.emit('end');
    expect(await result).toMatchObject({ body: 'primary statement', sha256: digest('primary statement') });
    expect(options.agent).toBe(false);
    expect(options.family).toBe(4);
    expect(Object.keys(options.headers).sort()).toEqual(['Accept', 'Accept-Encoding']);
  });
  it('returns only the validated DNS address to the connection, and refuses a private answer', async () => {
    const { result, options } = start();
    harness.lookup.mockImplementationOnce((_host, _options, callback) =>
      callback(null, [{ address: '8.8.8.8', family: 4 }]),
    );
    const accepted = vi.fn();
    options.lookup('primary.example', {}, accepted);
    expect(accepted).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    harness.lookup.mockImplementationOnce((_host, _options, callback) =>
      callback(null, [{ address: '127.0.0.1', family: 4 }]),
    );
    const denied = vi.fn();
    options.lookup('primary.example', {}, denied);
    expect(denied.mock.calls[0][0]).toBeInstanceOf(Error);
    (harness.request as Response).destroy(new Error('fixture termination'));
    await expect(result).rejects.toThrow();
  });
  it.each(['redirect', 'binary', 'compressed', 'oversize', 'incomplete'])(
    'refuses %s rather than treating it as a source',
    async (failure) => {
      const { result, respond } = start();
      const response = new Response();
      if (failure === 'redirect') response.statusCode = 302;
      if (failure === 'binary') response.headers['content-type'] = 'application/pdf';
      if (failure === 'compressed') response.headers['content-encoding'] = 'gzip';
      if (failure === 'incomplete') response.complete = false;
      respond(response);
      if (failure === 'oversize') response.emit('data', Buffer.alloc(256 * 1024 + 1));
      if (failure === 'incomplete') {
        response.emit('data', Buffer.from('partial'));
        response.emit('end');
      }
      await expect(result).rejects.toThrow('no-source');
    },
  );
  it('aborts the connection on the fixed deadline', async () => {
    vi.useFakeTimers();
    const { result } = start();
    const rejected = expect(result).rejects.toThrow('no-source');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
  });
});
