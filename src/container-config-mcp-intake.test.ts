import fs from 'fs';

import { describe, expect, it } from 'vitest';

import { parseMcpServerConfig, validateMcpServerName } from './container-config.js';

/**
 * The host is the only validator of an agent's `add_mcp_server` request: the
 * container forwards the raw fields, and the self-mod precheck runs these two
 * functions before any approval card.
 */
function intake(input: Record<string, unknown>): unknown {
  if (typeof input.name === 'string') validateMcpServerName(input.name);
  return parseMcpServerConfig(input);
}

const URL_OK = 'https://example.com/mcp';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('add_mcp_server intake on the host', () => {
  it('rejects every credential shape in the shared fixture, as a header value', () => {
    const shapes = JSON.parse(fs.readFileSync('tests/fixtures/mcp-known-secret-shapes.json', 'utf8')) as {
      name: string;
      value: string;
    }[];
    expect(shapes.length).toBeGreaterThan(0);
    for (const { name, value } of shapes) {
      expect(() => intake({ name: 'shape-check', url: URL_OK, headers: { 'User-Agent': value } }), name).toThrow(
        /raw credential/,
      );
    }
  });

  it.each([
    ['a non-placeholder credential header', { url: URL_OK, headers: { Authorization: 'Bearer real-token' } }],
    [
      'a secret smuggled beside the placeholder',
      { url: URL_OK, headers: { Authorization: 'Bearer x onecli-managed' } },
    ],
    ['an unknown header carrying a key', { url: URL_OK, headers: { 'X-Functions-Key': 'abc123' } }],
    ['plain http off loopback', { url: 'http://example.com/mcp' }],
    [
      'a placeholder header on a loopback server',
      { url: 'http://localhost:8080/mcp', headers: { Authorization: 'Bearer onecli-managed' } },
    ],
    ['userinfo in the url', { url: 'https://user:pass@example.com/mcp' }],
    ['a url fragment', { url: 'https://example.com/mcp#frag' }],
    ['a credential-named query key', { url: `${URL_OK}?accessKey=abc123` }],
    ['a raw credential in the url path', { url: 'https://hooks.example.com/s/sk-ant-api03-J8sK2mN9pQ4rT6vX1zA3/mcp' }],
    ['a raw credential in a query value', { url: `${URL_OK}?tools=ghp_deadbeef1234` }],
    ['a JWT in a neutral query value', { url: `${URL_OK}?code=${JWT}` }],
    ['a JWT in the url path', { url: `https://example.com/callback/${JWT}` }],
    ['type stdio with a url', { type: 'stdio', url: URL_OK }],
    ['type http with a command', { type: 'http', command: 'node' }],
    ['both command and url', { command: 'node', url: URL_OK }],
    ['env with a url', { url: URL_OK, env: { K: 'v' } }],
    ['headers with a command', { command: 'node', headers: { 'X-A': 'b' } }],
    ['neither command nor url', {}],
    ['a control character in a header value', { url: URL_OK, headers: { 'Content-Type': 'a\r\nX-Injected: yes' } }],
    ['a header value above U+00FF', { url: URL_OK, headers: { 'User-Agent': '测试' } }],
    [
      'a case-variant duplicate header',
      { url: URL_OK, headers: { Authorization: 'onecli-managed', authorization: 'Bearer onecli-managed' } },
    ],
  ])('rejects %s', (_label, fields) => {
    expect(() => intake({ name: 'srv', ...fields })).toThrow();
  });

  it.each(['bad name!', '__proto__', 'constructor', 'prototype', 'nanoclaw'])('rejects the server name %j', (name) => {
    expect(() => intake({ name, url: URL_OK })).toThrow();
  });

  it('accepts configuration headers and Latin-1 values', () => {
    expect(intake({ name: 'ok', url: URL_OK, headers: { 'Content-Type': 'application/json' } })).toBeDefined();
    expect(intake({ name: 'ua', url: URL_OK, headers: { 'User-Agent': 'café' } })).toBeDefined();
  });
});
