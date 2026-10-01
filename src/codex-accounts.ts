/**
 * The Codex OAuth accounts a group can run on (its primary host home, then its declared fallbacks) and which of
 * them a container recently found at their quota wall, so the next spawn starts on an account that still has room
 * instead of paying a second app-server start to rediscover the wall.
 *
 * The marks are in memory on purpose: each is a one-hour hint, a wrong or lost one costs a single in-container
 * rotation, and a host restart forgetting it is the same as the hint expiring.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from './log.js';

/** `~/.codex-<folder>/` with a real `auth.json` (a separate account via `CODEX_HOME=… codex login`) wins over `~/.codex/`. */
export function resolveCodexAuthDir(folder: string, homedir: string = os.homedir()): string {
  const scoped = path.join(homedir, `.codex-${folder}`);
  if (fs.existsSync(path.join(scoped, 'auth.json'))) return scoped;
  return path.join(homedir, '.codex');
}

/** Index 0 maps to `.codex-fallback-1`, index 1 to `.codex-fallback-2`, etc. */
export interface CodexAuthFallback {
  hostPath: string;
  containerPath: string;
}

/**
 * Entries without an `auth.json`, equal to the primary, or already seen are skipped. The mount block and
 * `codexAccountRing` both call this, so a fallback's container path names the same host account in each.
 */
export function resolveCodexAuthFallbacks(
  declarations: string[] | undefined,
  primaryHostPath: string,
  homedir: string = os.homedir(),
): CodexAuthFallback[] {
  if (!Array.isArray(declarations) || declarations.length === 0) return [];
  const out: CodexAuthFallback[] = [];
  const seen = new Set<string>([primaryHostPath]);
  for (const decl of declarations) {
    if (typeof decl !== 'string' || !decl.trim()) continue;
    const expanded = decl.startsWith('~/') ? path.join(homedir, decl.slice(2)) : decl;
    if (seen.has(expanded)) continue;
    if (!fs.existsSync(path.join(expanded, 'auth.json'))) {
      log.warn('codexAuthFallbacks: entry skipped (no auth.json)', { hostPath: expanded });
      continue;
    }
    seen.add(expanded);
    out.push({ hostPath: expanded, containerPath: `/home/node/.codex-fallback-${out.length + 1}` });
  }
  return out;
}

export interface CodexAccount {
  /** Host Codex home holding the account's `auth.json`; the key, since groups share accounts by host path. */
  hostHome: string;
  containerPath: string;
}

/**
 * An account's quota can be reset early, and only a running app-server can read it, so the mark expires and
 * containers start on the account again until one of them reports it spent.
 */
export const CODEX_ACCOUNT_RETRY_MS = 60 * 60_000;

const exhaustedUntil = new Map<string, number>();

export function markCodexAccountExhausted(hostHome: string, nowMs: number = Date.now()): void {
  exhaustedUntil.set(hostHome, nowMs + CODEX_ACCOUNT_RETRY_MS);
}

export function isCodexAccountExhausted(hostHome: string, nowMs: number = Date.now()): boolean {
  const until = exhaustedUntil.get(hostHome);
  if (until === undefined) return false;
  if (until > nowMs) return true;
  exhaustedUntil.delete(hostHome);
  return false;
}

/**
 * The container path to start on when it is not the primary (`ring[0]`); null keeps the primary. With every
 * account marked the primary is kept too: the runner's own rotation then decides, as it did before the hint.
 */
export function pickCodexStartHome(ring: readonly CodexAccount[], nowMs: number = Date.now()): string | null {
  const first = ring.findIndex((account) => !isCodexAccountExhausted(account.hostHome, nowMs));
  return first > 0 ? ring[first].containerPath : null;
}

/** Primary first, then the declared fallbacks: the order the runner rotates in. */
export function codexAccountRing(
  folder: string,
  declarations: string[] | undefined,
  homedir: string = os.homedir(),
): CodexAccount[] {
  const primaryHostPath = resolveCodexAuthDir(folder, homedir);
  return [
    { hostHome: primaryHostPath, containerPath: '/home/node/.codex' },
    ...resolveCodexAuthFallbacks(declarations, primaryHostPath, homedir).map((fallback) => ({
      hostHome: fallback.hostPath,
      containerPath: fallback.containerPath,
    })),
  ];
}

/** The fallback a Codex container should start on while its earlier accounts are marked at quota; null otherwise. */
export function codexStartHome(
  provider: string,
  folder: string,
  declarations: string[] | undefined,
  homedir: string = os.homedir(),
): string | null {
  if (provider !== 'codex') return null;
  return pickCodexStartHome(codexAccountRing(folder, declarations, homedir));
}
