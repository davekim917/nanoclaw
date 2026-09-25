#!/usr/bin/env bun
/**
 * enqueue-send — idempotent, model-free chat send for the smoke campaign
 * controller (CONTROLLER-SPEC rev 3 s2, "Model-free sends"). The live
 * controller runs it from its task script as
 *
 *   bun /app/src/cli/enqueue-send.ts --id <key>#<attempt> --to <destination> \
 *     --text-file <path> --thread-key <runId> --run-id <runId> --fire <fire> \
 *     [--fingerprint <fp>] [--file <abs path>]... [--outbox-root <dir>]
 *
 * in the task's own session, the same transport `ncl` uses: the task-script
 * process starts the session mailbox itself. The
 * runner source is a boot snapshot (src/agent-runner-source.ts), so a change
 * here reaches containers only after a host restart.
 *
 * Same path as `send_message`/`send_file` (mcp-tools/core.ts): resolve a named
 * destination, stage attachments at <outbox>/<id>/<name>, write one
 * messages_out row the host drains with no agent turn. Four differences:
 *
 *  - `to` is required (task sessions must name it) and the
 *    thread key (the run id) is required, so every post of a run threads
 *    across fires (src/db/thread-key-anchors.ts).
 *  - The id is the caller's `<obligation key>#<attempt>`, not a random one,
 *    and the row is written with INSERT ... ON CONFLICT(id) DO
 *    NOTHING, then read back. An identical existing row is `replay` (exit 0);
 *    a different payload under the same id is an error and is never
 *    overwritten. A plain INSERT would throw on replay.
 *  - It does not go through the fork's per-turn chat budget
 *    (NanoclawAgentMailbox.writeMessageOut -> admitChatWrite), which is the MODEL's budget and
 *    silently returns -1 when refused. The controller has its own, enforced
 *    here in the same transaction as the insert: per run per fire, per run,
 *    per alarm fingerprint. A replay never consumes budget.
 *  - Attachment bytes are part of the payload. Each staged file's sha256 is
 *    written to session_state (`controller_send_files:<id>`) in the same
 *    transaction as the row, and outlives the host's cleanup of <outbox>/<id>/,
 *    so a replay compares bytes, not just names. A row whose digest record is
 *    missing or unreadable never verifies as a replay.
 *  - Output is one JSON line; exit codes are the contract (below).
 *
 * Exit: 0 enqueued|replay, 2 invalid input, 3 controller_send_budget,
 *       4 payload mismatch for an existing id, 1 anything else.
 */
import '../modules/index.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { getSessionRouting } from '../db/session-routing.js';
import { findByName } from '../destinations.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
import { writeControllerSendRow } from '../modules/mailbox/controller-send.js';
import { isAllowedFilePath, parseThreadKey } from '../mcp-tools/core.js';

// Controller-send budget. Measured over the 30 finished PR smoke campaigns of
// 2026-09-05..18 (gate agent session outbound.db, kind=chat rows naming the PR or
// run id, claim-5m to finish+2h): posts per campaign p50 3, max 12 (pr1896,
// including human-thread replies); most posts inside any 10-minute window
// (one */10 fire) 4, in 2 of 30 campaigns. So the per-run cap keeps the
// spec's 15 (above the measured max) and the per-fire cap is 4, not the spec's
// 3: 3 would have throttled 2 real bursts. Per-fingerprint stays the spec's 2.
export const CONTROLLER_SEND_BUDGET = { perFire: 4, perRun: 15, perFingerprint: 2 } as const;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}#[1-9][0-9]{0,2}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // send_file's cap
const DEFAULT_OUTBOX_ROOT = '/workspace/outbox';

export interface EnqueueSendInput {
  id: string;
  to: string;
  text: string;
  threadKey: string;
  runId: string;
  fire: string;
  fingerprint?: string | null;
  files?: string[];
  outboxRoot?: string;
}

export type EnqueueSendResult =
  | { ok: true; outcome: 'enqueued' | 'replay'; id: string; seq: number }
  | { ok: false; code: 'invalid' | 'budget' | 'mismatch' | 'error'; error: string; id?: string };

export class EnqueueSendError extends Error {
  constructor(
    readonly code: 'invalid' | 'budget' | 'mismatch' | 'error',
    message: string,
  ) {
    super(message);
  }
}

interface Routing {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
}

/**
 * The named-destination branch of core.ts resolveRouting:
 * a channel keeps the session's thread only when it is the session's own
 * chat; an agent destination never carries a thread. The parity test in
 * enqueue-send.test.ts holds this to send_message's actual row.
 */
export function resolveNamedRouting(to: string): Routing {
  const dest = findByName(to);
  if (!dest) throw new EnqueueSendError('invalid', `unknown destination "${to}"`);
  if (dest.type === 'channel') {
    const session = getSessionRouting();
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: session.platform_id === dest.platformId ? session.thread_id : null,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null };
}

interface StagedFile {
  name: string;
  bytes: Buffer;
  sha256: string;
}

type FileDigests = Array<{ name: string; sha256: string }>;

function readAttachment(filePath: string): StagedFile {
  if (!path.isAbsolute(filePath))
    throw new EnqueueSendError('invalid', `attachment path must be absolute: ${filePath}`);
  let real: string;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    throw new EnqueueSendError('invalid', `attachment not found: ${filePath}`);
  }
  // Same allowlist as send_file, checked on the real path so
  // a symlink under /workspace cannot carry a host file out.
  if (!isAllowedFilePath(real)) throw new EnqueueSendError('invalid', `attachment path not allowed: ${filePath}`);
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size === 0)
    throw new EnqueueSendError('invalid', `attachment is empty or not a file: ${filePath}`);
  if (stat.size > MAX_FILE_BYTES) throw new EnqueueSendError('invalid', `attachment too large: ${filePath}`);
  const bytes = fs.readFileSync(real);
  return { name: path.basename(real), bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function validate(input: EnqueueSendInput): void {
  if (!ID_PATTERN.test(input.id)) throw new EnqueueSendError('invalid', 'id must be <key>#<attempt> (attempt 1-999)');
  if (!input.to) throw new EnqueueSendError('invalid', 'to is required');
  if (!input.text && !(input.files && input.files.length))
    throw new EnqueueSendError('invalid', 'text or a file is required');
  if (!RUN_ID_PATTERN.test(input.runId)) throw new EnqueueSendError('invalid', 'runId is required');
  if (!input.fire) throw new EnqueueSendError('invalid', 'fire is required');
  if (input.fingerprint && !FINGERPRINT_PATTERN.test(input.fingerprint)) {
    throw new EnqueueSendError('invalid', 'fingerprint has invalid characters');
  }
  const key = parseThreadKey(input.threadKey);
  if ('error' in key) throw new EnqueueSendError('invalid', key.error);
  if (!key.threadKey) throw new EnqueueSendError('invalid', 'threadKey is required');
}

interface BudgetState {
  total: number;
  fire: string;
  fireCount: number;
  fingerprints: Record<string, number>;
}

// The session-DB reads and the insert transaction live in the mailbox module
// (modules/mailbox/controller-send.ts); this file keeps the budget POLICY
// below, the payload comparisons, and the CLI's error taxonomy.
function sameDigests(stored: FileDigests | null, wanted: FileDigests): boolean {
  if (wanted.length === 0) return stored === null;
  if (stored === null || stored.length !== wanted.length) return false;
  return stored.every((d, i) => d.name === wanted[i].name && d.sha256 === wanted[i].sha256);
}

export function budgetRefusal(state: BudgetState, fire: string, fingerprint: string | null | undefined): string | null {
  const fireCount = state.fire === fire ? state.fireCount : 0;
  if (fireCount >= CONTROLLER_SEND_BUDGET.perFire) return `per-fire budget ${CONTROLLER_SEND_BUDGET.perFire} reached`;
  if (state.total >= CONTROLLER_SEND_BUDGET.perRun) return `per-run budget ${CONTROLLER_SEND_BUDGET.perRun} reached`;
  if (fingerprint && (state.fingerprints[fingerprint] ?? 0) >= CONTROLLER_SEND_BUDGET.perFingerprint) {
    return `per-fingerprint budget ${CONTROLLER_SEND_BUDGET.perFingerprint} reached for ${fingerprint}`;
  }
  return null;
}

interface RowPayload {
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
  deliver_after: string | null;
  content: string;
}

function samePayload(a: RowPayload, b: RowPayload): boolean {
  return (
    a.kind === b.kind &&
    a.platform_id === b.platform_id &&
    a.channel_type === b.channel_type &&
    a.thread_id === b.thread_id &&
    a.in_reply_to === b.in_reply_to &&
    a.deliver_after === b.deliver_after &&
    a.content === b.content
  );
}

/**
 * Insert-or-verify, atomic with the budget. Requires a started mailbox (the
 * CLI) or initTestSessionDb() (tests).
 */
export function enqueueSend(input: EnqueueSendInput): EnqueueSendResult & { ok: true } {
  validate(input);
  const routing = resolveNamedRouting(input.to);
  const attachments = (input.files ?? []).map(readAttachment);
  const names = attachments.map((a) => a.name);
  const digests: FileDigests = attachments.map((a) => ({ name: a.name, sha256: a.sha256 }));
  if (new Set(names).size !== names.length) throw new EnqueueSendError('invalid', 'attachment names must be unique');
  const content = JSON.stringify(
    names.length
      ? { text: input.text, files: names, threadKey: input.threadKey }
      : { text: input.text, threadKey: input.threadKey },
  );
  const wanted: RowPayload = {
    kind: 'chat',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: routing.thread_id,
    in_reply_to: null,
    deliver_after: null,
    content,
  };

  const result = writeControllerSendRow({
    id: input.id,
    runId: input.runId,
    fire: input.fire,
    fingerprint: input.fingerprint,
    wanted,
    digests,
    stageAttachments: () => {
      if (!attachments.length) return;
      const dir = path.join(input.outboxRoot ?? DEFAULT_OUTBOX_ROOT, input.id);
      fs.mkdirSync(dir, { recursive: true });
      for (const a of attachments) fs.writeFileSync(path.join(dir, a.name), a.bytes);
    },
    samePayload,
    sameDigests,
    budgetRefusal,
    mismatchError: (message) => new EnqueueSendError('mismatch', message),
    budgetError: (message) => new EnqueueSendError('budget', message),
    unreadableBudgetError: (runId) =>
      new EnqueueSendError('budget', `controller send budget state for ${runId} is unreadable`),
  });
  return { ok: true, outcome: result.outcome, id: input.id, seq: result.seq };
}

// ---------------------------------------------------------------------------
// CLI

// A text file the caller names but that cannot be read is a deterministic
// input fault (exit 2), not a transient one: the controller retries `error`
// (exit 1) as an unknown outcome, and a retry cannot make the file appear.
function readTextFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new EnqueueSendError('invalid', `text file unreadable: ${file} (${(err as Error).message})`);
  }
}

export function parseEnqueueArgv(argv: string[]): EnqueueSendInput & { textFile?: string } {
  const out: Record<string, string> = {};
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith('--') || value === undefined) throw new EnqueueSendError('invalid', `bad argument: ${flag}`);
    i++;
    const name = flag.slice(2);
    if (name === 'file') files.push(value);
    else if (
      ['id', 'to', 'text', 'text-file', 'thread-key', 'run-id', 'fire', 'fingerprint', 'outbox-root'].includes(name)
    ) {
      if (name in out) throw new EnqueueSendError('invalid', `duplicate flag --${name}`);
      out[name] = value;
    } else throw new EnqueueSendError('invalid', `unknown flag --${name}`);
  }
  if ('text' in out && 'text-file' in out)
    throw new EnqueueSendError('invalid', 'pass --text or --text-file, not both');
  return {
    id: out.id ?? '',
    to: out.to ?? '',
    text: 'text-file' in out ? readTextFile(out['text-file']) : (out.text ?? ''),
    threadKey: out['thread-key'] ?? '',
    runId: out['run-id'] ?? '',
    fire: out.fire ?? '',
    fingerprint: out.fingerprint ?? null,
    files,
    outboxRoot: out['outbox-root'],
  };
}

const EXIT: Record<string, number> = { invalid: 2, budget: 3, mismatch: 4, error: 1 };

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let result: EnqueueSendResult;
  let input: EnqueueSendInput | null = null;
  try {
    input = parseEnqueueArgv(argv);
    const context = await readMailboxContext();
    const mailbox = getAgentMailbox();
    await mailbox.start(context);
    try {
      const done = input;
      result = await mailbox.run(() => enqueueSend(done));
    } finally {
      await mailbox.stop();
    }
  } catch (err) {
    const code = err instanceof EnqueueSendError ? err.code : 'error';
    result = { ok: false, code, error: err instanceof Error ? err.message : String(err), id: input?.id };
  }
  const line = result.ok
    ? result
    : { ...result, alarm: result.code === 'budget' ? 'controller_send_budget' : undefined };
  process.stdout.write(JSON.stringify(line) + '\n');
  return result.ok ? 0 : EXIT[result.code];
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stdout.write(JSON.stringify({ ok: false, code: 'error', error: String(err) }) + '\n');
      process.exit(1);
    },
  );
}
