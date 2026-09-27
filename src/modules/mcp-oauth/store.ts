/**
 * Host-side OAuth bundle store — the ONE place refresh tokens and client
 * secrets live.
 *
 * Not OneCLI: the refresher must READ its refresh token back every cycle, and
 * the OneCLI gateway API is write-only for secret values (onecli@1.4.1). Same
 * shape as the GitHub App private key: a long-lived minting credential held by
 * the HOST. No container sees these files — `mcp-oauth/` is not among the
 * `DATA_DIR` subpaths that are mounted.
 *
 * The ACCESS token is never stored here, only in OneCLI, so this directory
 * yields the means to ask for a token, never a working one. Mode 0700/0600,
 * written via same-directory temp file + `rename` so a crash cannot truncate a bundle.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';

export interface McpOAuthBundle {
  /** The row key in `mcp_oauth_integrations`. */
  name: string;
  clientId: string;
  /** Absent for a public client (`token_endpoint_auth_method: none`). */
  clientSecret?: string;
  /** Present only between `login` and `complete`. */
  pending?: {
    state: string;
    codeVerifier: string;
    startedAt: string;
  };
  refreshToken?: string;
  /** Set when the AS rejected this registration; the next `login` must register a new client. */
  clientRejectedAt?: string;
  scopes?: string;
  updatedAt: string;
}

function mcpOAuthStoreDir(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'mcp-oauth');
}

/**
 * Names are constrained at the CLI rather than escaped here: an unchecked name
 * would be a path-traversal bug, so this throws instead of sanitizing.
 */
function bundlePath(name: string, dataDir: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.includes('..')) {
    throw new Error(`Refusing to use "${name}" as an OAuth bundle file name`);
  }
  return path.join(mcpOAuthStoreDir(dataDir), `${name}.json`);
}

export function readMcpOAuthBundle(name: string, dataDir: string = DATA_DIR): McpOAuthBundle | undefined {
  const p = bundlePath(name, dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(raw) as McpOAuthBundle;
}

export function writeMcpOAuthBundle(bundle: McpOAuthBundle, dataDir: string = DATA_DIR): void {
  const dir = mcpOAuthStoreDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `mode` is ignored for an existing directory and narrowed by umask on create.
  fs.chmodSync(dir, 0o700);

  const target = bundlePath(bundle.name, dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...bundle, updatedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort: the rename failure is the error worth reporting.
    }
    throw err;
  }
  // The temp file's mode applies only when it is created; belt-and-braces.
  fs.chmodSync(target, 0o600);
}

export function deleteMcpOAuthBundle(name: string, dataDir: string = DATA_DIR): boolean {
  try {
    fs.unlinkSync(bundlePath(name, dataDir));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
