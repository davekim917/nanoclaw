import { afterEach, describe, expect, it } from 'vitest';

import { askJev } from './typesafe.js';

describe('askJev', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('refuses to send anything when no gateway proxy is configured', async () => {
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
    await expect(askJev({ t: 'x' }, { q: { type: 'noul', instructions: 'x' } })).rejects.toThrow(/no OneCLI gateway/);
  });

  it('returns the answers from an injected transport', async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ answers: { q: { type: 'noul', noul: 0.9 } } }), { status: 200 });
    expect(await askJev({ t: 'x' }, { q: { type: 'noul', instructions: 'x' } }, { fetch })).toEqual({
      q: { type: 'noul', noul: 0.9 },
    });
  });
});
