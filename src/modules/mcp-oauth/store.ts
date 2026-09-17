/**
 * Host-side OAuth bundle store — the ONE place refresh tokens and client
 * secrets live.
 *
 * WHY NOT ONECLI. The stated model for this install is "secrets live in the
 * OneCLI vault" (CLAUDE.md, Secrets / Credentials / OneCLI), and that is still
 * true for the value a CONTAINER consumes: the access token goes into a OneCLI
 * header-injection secret and is never handed to the agent directly. But the
 * refresher has to READ its refresh token back on every cycle, and
 * `onecli@1.4.1`'s gateway API is write-only for secret values — verified
 * 2026-09-17 against the live gateway: `POST /api/secrets` → 201,
 * `PATCH /api/secrets/{id}` → 200, `DELETE /api/secrets/{id}` → 204,
 * `GET /api/secrets?limit=…` returns metadata with no value field, and
 * `GET /api/secrets/{id}`, `…/value`, `…/reveal`, `?reveal=true` and
 * `?include=value` all 404 or return the same value-free listing. A refresh
 * token parked in OneCLI could be written and never read, which is the same as
 * not having one.
 *
 * SO IT LIVES HERE, and the precedent is exact: the GitHub App PRIVATE KEY
 * already sits on this host's filesystem at `GITHUB_APP_PRIVATE_KEY_PATH`, read
 * by the host to mint short-lived installation tokens
 * (`src/github-app-token.ts:227`). This store is that same shape — a long-lived
 * minting credential the HOST holds, producing a short-lived credential the
 * container gets. The invariant that matters is unchanged: no container ever
 * sees either file. `DATA_DIR` itself is never bind-mounted; only named
 * subpaths under it are (`src/container-runner.ts:4443,4456,4485,4875,4972`),
 * and `mcp-oauth/` is not one of them.
 *
 * Mode 0700 on the directory and 0600 on each file, written through a
 * same-directory temp file and `rename` so a crash mid-write cannot leave a
 * truncated bundle where a valid one was.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';

export interface McpOAuthBundle {
  /** Integration name — the row key in `mcp_oauth_integrations`. */
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
  /**
   * Kept so a re-`login` can revoke, and so `ncl integrations remove` can tell
   * "there was a live grant" from "nothing was ever exchanged". Never logged.
   */
  accessToken?: string;
  scopes?: string;
  updatedAt: string;
}

export function mcpOAuthStoreDir(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'mcp-oauth');
}

/**
 * Integration names are the file name, so they are constrained at the CLI
 * (`assertIntegrationName`) rather than escaped here — a name that reached
 * this function unchecked would be a path-traversal bug, not a formatting one,
 * so it throws instead of sanitizing.
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
  // mkdirSync's `mode` is ignored for a directory that already exists, and the
  // umask can have narrowed it further on create. An explicit chmod makes the
  // 0700 true in both cases.
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
      // Best effort — the rename failure is the error worth reporting.
    }
    throw err;
  }
  // `writeFileSync`'s mode applies only when the temp file is CREATED; after a
  // rename over an existing target the mode travels with the new inode, so this
  // is belt-and-braces for a file whose predecessor was created differently.
  fs.chmodSync(target, 0o600);
}

/** Returns true when a bundle was removed; false when there was none. */
export function deleteMcpOAuthBundle(name: string, dataDir: string = DATA_DIR): boolean {
  try {
    fs.unlinkSync(bundlePath(name, dataDir));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
