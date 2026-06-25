/**
 * design-artifact-loop — disk-backed, atomic round/cap state machine.
 *
 * Why disk, not module memory (Reviewer A F1): on Codex the app-server (and its
 * child nanoclaw MCP process) is spawned/torn down per query, so in-memory state
 * would reset mid-loop. State is rehydrated from disk on every call.
 *
 * Why /workspace/agent (Reviewer A F2): /workspace/outbox is host-owned, deleted
 * after delivery, and not a send_file source. /workspace/agent is persistent and
 * send_file-able.
 *
 * Why atomic + lock (Codex cycle-4 must-fix): write-temp-then-rename (atomic on the
 * same fs) under an advisory lockfile so overlapping design_review calls on the same
 * id cannot corrupt trace.json.
 */

import fs from 'fs';
import path from 'path';
import type { Finding, Severity } from './linter.js';

export const DEFAULT_BASE_DIR = '/workspace/agent/design-artifact-loop';
export const CAP = 3;

export type FindingState = 'new' | 'unresolved' | 'resolved';
export type RunStatus = 'continue' | 'blocked' | 'shipped-with-disclosures';

export interface TrackedFinding extends Finding {
  state: FindingState;
}
export interface Round {
  round: number;
  findings: TrackedFinding[];
  /** True iff a non-stale L1 critic pass for THIS artifact version was folded into this round. */
  criticReviewed?: boolean;
}
export interface TraceState {
  id: string;
  rounds: Round[];
  finalStatus: RunStatus | null;
  selectedCandidate: number | null;
}

function traceDir(id: string, baseDir = DEFAULT_BASE_DIR): string {
  return path.join(baseDir, id);
}
function tracePath(id: string, baseDir = DEFAULT_BASE_DIR): string {
  return path.join(traceDir(id, baseDir), 'trace.json');
}

/** Rehydrate state from disk; a fresh id starts at round 0 with no findings. */
export function readState(id: string, baseDir = DEFAULT_BASE_DIR): TraceState {
  const p = tracePath(id, baseDir);
  if (!fs.existsSync(p)) {
    return { id, rounds: [], finalStatus: null, selectedCandidate: null };
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as TraceState;
}

/** Atomic write (temp → fsync → rename). Caller MUST hold the lock. */
function atomicWrite(state: TraceState, baseDir: string): void {
  const dir = traceDir(state.id, baseDir);
  const target = path.join(dir, 'trace.json');
  const tmp = path.join(dir, `trace.json.tmp.${process.pid}.${++lockSeq}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target); // atomic on the same filesystem
}

/** Atomic write under the advisory lock (standalone helper; tests use this). */
export function writeState(state: TraceState, baseDir = DEFAULT_BASE_DIR): void {
  const dir = traceDir(state.id, baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'trace.lock');
  const owner = nextOwner();
  acquireLock(lock, owner);
  try {
    atomicWrite(state, baseDir);
  } finally {
    releaseLock(lock, owner);
  }
}

/**
 * Transactional round record (Codex E#7): the ENTIRE read → merge → decide → write
 * happens under ONE lock acquisition, so concurrent design_review calls on the same id
 * cannot both read round N and clobber each other (which would silently lose findings).
 */
export function recordRound(
  id: string,
  roundFindings: Finding[],
  baseDir = DEFAULT_BASE_DIR,
  criticReviewed = false,
): { state: TraceState; status: RunStatus; mustFixOpen: TrackedFinding[] } {
  const dir = traceDir(id, baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'trace.lock');
  const owner = nextOwner();
  acquireLock(lock, owner);
  try {
    const prior = readState(id, baseDir);
    const next = mergeRound(prior, roundFindings, criticReviewed);
    const status = decideStatus(next);
    next.finalStatus = status === 'continue' ? null : status;
    if (next.finalStatus) next.selectedCandidate = next.rounds.length;
    atomicWrite(next, baseDir);
    return { state: next, status, mustFixOpen: openFindings(next).filter((f) => f.severity === 'high') };
  } finally {
    releaseLock(lock, owner);
  }
}

let lockSeq = 0;
function nextOwner(): string {
  return `${process.pid}-${Date.now()}-${++lockSeq}`;
}

/**
 * Advisory lock with owner token. Primary path: exclusive create (`wx`). For a lock
 * orphaned by a crashed process (age > STALE_MS), steal it via last-writer-wins +
 * read-back verification (Codex E#8 — avoids the blind-unlink TOCTTOU where two
 * reclaimers both proceed): both writers overwrite with their own token, then each
 * reads back; only the writer whose token survived proceeds, the other retries.
 */
const STALE_MS = 10_000;
function acquireLock(lock: string, owner: string, retries = 100, delayMs = 15): void {
  for (let i = 0; i < retries; i++) {
    try {
      fs.writeFileSync(lock, owner, { flag: 'wx' }); // atomic exclusive create
      return;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) {
          fs.writeFileSync(lock, owner);          // steal attempt (non-exclusive)
          spin(5);                                 // let a racing stealer also write
          if (fs.readFileSync(lock, 'utf8') === owner) return; // we won the steal
        }
      } catch { /* lock vanished between calls — loop and retry create */ }
      spin(delayMs);
    }
  }
  throw new Error(`design_review: could not acquire ${lock}`);
}

/** Release only if we still own it (never unlink a lock a stealer took over). */
function releaseLock(lock: string, owner: string): void {
  try {
    if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock);
  } catch { /* already gone */ }
}

// Bun has no synchronous sleep primitive in this context; a brief spin is acceptable
// because real contention is near-zero (one agent, sequential calls) — Codex E#9 (busy-
// wait) is a deferred SHOULD-FIX, not a correctness issue at this concurrency level.
function spin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin */ }
}

/**
 * Carry-forward merge: diff this round's findings against the previous round by
 * stable id. Present-before-and-now = unresolved; present-before-not-now = resolved;
 * new id = new. (R9 carry-forward — Reviewer findings must not be silently dropped.)
 */
export function mergeRound(state: TraceState, roundFindings: Finding[], criticReviewed = false): TraceState {
  const prev = state.rounds[state.rounds.length - 1];
  const prevIds = new Set((prev?.findings ?? []).map((f) => f.id));
  const nowIds = new Set(roundFindings.map((f) => f.id));

  const tracked: TrackedFinding[] = roundFindings.map((f) => ({
    ...f,
    state: prevIds.has(f.id) ? 'unresolved' : 'new',
  }));
  // Carry forward previously-seen findings that are now gone, marked resolved.
  for (const pf of prev?.findings ?? []) {
    if (!nowIds.has(pf.id)) tracked.push({ ...pf, state: 'resolved' });
  }

  const round = (prev?.round ?? 0) + 1;
  return { ...state, rounds: [...state.rounds, { round, findings: tracked, criticReviewed }] };
}

/** Open (unresolved/new, non-resolved) findings in the latest round. */
export function openFindings(state: TraceState): TrackedFinding[] {
  const last = state.rounds[state.rounds.length - 1];
  return (last?.findings ?? []).filter((f) => f.state !== 'resolved');
}

/**
 * R9 gate. Below cap with open findings → continue. At cap → block on open high, else disclose.
 *
 * A clean round does NOT auto-ship: the independent L1 vision critic is mandatory and must
 * have reviewed THIS artifact version (Codex P1 — a clean deterministic lint says nothing
 * about branded-generic / visual-only slop, which only the critic catches). So a clean
 * round with no recorded critic pass returns `continue` to force one — except at the cap,
 * where the loop must terminate.
 */
export function decideStatus(state: TraceState): RunStatus {
  const last = state.rounds[state.rounds.length - 1];
  const round = last?.round ?? 0;
  const open = openFindings(state);
  const hasHigh = open.some((f) => f.severity === 'high');
  if (open.length === 0) {
    // clean → ship only once the critic has reviewed this version (or the cap forces it)
    return last?.criticReviewed || round >= CAP ? 'shipped-with-disclosures' : 'continue';
  }
  if (round < CAP) return 'continue';
  return hasHigh ? 'blocked' : 'shipped-with-disclosures';
}

export type { Severity };
