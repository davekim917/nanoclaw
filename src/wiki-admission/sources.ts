import dns from 'node:dns';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

import { digest, type WikiPolicy } from './policy.js';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix);
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address)
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export interface PrimarySource {
  id: string;
  url: string;
  sha256: string;
  retrievedAt: string;
  body: string;
}
export function sourceUrl(locator: string, policy: WikiPolicy): URL {
  const u = new URL(locator);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    isIP(u.hostname.replace(/^\[|\]$/g, '')) ||
    !policy.sourcePrefixes.some((p) => u.href.startsWith(p))
  )
    throw new Error('no-source');
  return u;
}

/** Connect to the checked address, without a proxy, redirect, cookie jar or credentials. */
export function retrieveSource(locator: string, policy: WikiPolicy): Promise<PrimarySource> {
  const url = sourceUrl(locator, policy);
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        agent: false,
        family: 4,
        headers: { Accept: 'text/html,text/plain,application/json', 'Accept-Encoding': 'identity' },
        lookup: (hostname, _options, callback) => {
          dns.lookup(hostname, { all: true, family: 4 }, (error, addresses) => {
            if (error || !addresses.length || addresses.some((a) => !publicAddress(a.address))) {
              callback(error ?? new Error('no-source'), '', 4);
              return;
            }
            callback(null, addresses[0].address, addresses[0].family);
          });
        },
      },
      (response) => {
        response.on('error', reject);
        if (
          response.statusCode !== 200 ||
          !/^(text\/(html|plain|markdown)|application\/json)(;|$)/i.test(response.headers['content-type'] ?? '') ||
          (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
        ) {
          response.destroy(new Error('no-source'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 256 * 1024) {
            response.destroy(new Error('no-source'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            if (!body.trim() || !response.complete) throw new Error('no-source');
            const sha256 = digest(body);
            resolve({
              id: digest(url.href + '\0' + sha256),
              url: url.href,
              sha256,
              retrievedAt: new Date().toISOString(),
              body,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const deadline = setTimeout(() => request.destroy(new Error('no-source')), 15_000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
  });
}
