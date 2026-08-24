import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { getDb } from '../../db/connection.js';
import {
  consolidatedFactIds,
  markFactsConsolidated,
  pruneConsolidatedFacts,
} from '../../db/memory-consolidated-facts.js';
import { listClaudeStructuredCredentialSlots, type ClaudeCredentialSlot } from '../../llm.js';
import { log } from '../../log.js';
import {
  claimMemoryCurationEpisode,
  claimMemoryMaintenance,
  completeMemoryMaintenance,
  completeMemoryCurationEpisode,
  failMemoryMaintenance,
  failMemoryCurationEpisode,
  finishMemoryCurationCall,
  markMemoryCurationCredentialAvailable,
  markMemoryCurationCredentialUnavailable,
  memoryCurationAdmission,
  readMemoryCurationEpisodeMessages,
  recordAcceptedGeneratedMemory,
  recordMemoryCurationCall,
  selectMemoryCurationCredential,
  type MemoryCurationArchiveRow,
  type MemoryCurationCredentialSelection,
  type MemoryCurationEpisode,
  type MemoryMaintenanceJob,
} from '../../message-archive.js';
import { tokenizeForRecall } from './pre-turn-context.js';
import { workgroupMemoryDir } from '../workgroup/shared-dirs.js';
import {
  MemoryCuratorBackend,
  MEMORY_CURATOR_EFFORT,
  type ConsolidationBackendResult,
  type CuratorBackendResult,
} from './curator-backend.js';
import {
  buildConsolidationPrompt,
  buildCuratorPrompt,
  CONSOLIDATION_HEADER_PATTERN,
  CONSOLIDATION_INPUT_FILE_MAX_BYTES,
  CONSOLIDATION_INPUT_TOTAL_MAX_BYTES,
  CONSOLIDATION_MAX_FACTS,
  CURATOR_CAPTURE_REASON_CODES,
  CURATOR_MAX_MEMORY_TEXT_CHARS,
  generatedMemorySha,
  GENERATED_MEMORY_MAX_BYTES,
  GENERATED_MEMORY_WARN_BYTES,
  parseGeneratedMemoryFacts,
  TOPIC_DIRECTORIES,
  TOPIC_FILE_PATH_PATTERN,
  validateConsolidationFiles,
  validateCuratorDecision,
  type ConsolidationFileCandidate,
  type ConsolidationFileRejection,
  type ConsolidationTailFact,
  type ConsolidationTopicFile,
  type CuratorDecision,
} from './curator-contract.js';
import {
  readGeneratedMemory,
  readMemoryTopicFile,
  writeGeneratedMemory,
  writeMemoryTopicFile,
  type CuratorWriteResult,
} from './curator-write.js';

const MAX_RAW_MESSAGES = 80;
const MAX_EPISODE_MESSAGES = 80;
const MAX_EPISODE_CHARS = 24_000;
const EPISODE_TRUNCATION_MARKER = '\n[truncated:episode]';
const MAX_GENERATED_PROMPT_CHARS = 32_000;
const MAX_MANUAL_FILES = 256;
const MAX_MANUAL_SCAN_BYTES = 1_048_576;
const MAX_MANUAL_FILE_BYTES = 65_536;
const MAX_MANUAL_EXCERPTS = 3;
const MAX_MANUAL_EXCERPT_CHARS = 1200;

export interface MemoryCuratorRunReport {
  workgroupId: string;
  episodeKey: string;
  action: CuratorDecision['action'] | 'maintenance_noop' | 'maintenance_written';
  /**
   * Why the curator decided what it decided — present for model-backed episodes, absent
   * for maintenance, which makes no model decision.
   *
   * The curator already computes a reason for every decision including each noop, and
   * this was previously dropped. It is surfaced because the noop codes are the only
   * machine-readable record of what memory is being REFUSED: `code_derived` in
   * particular is the footprint of the "recoverable from code/Graphify" prohibition, so
   * without this the suppression can only be estimated by classifying the store after
   * the fact. runMemoryCurationInBackground spreads this report into one log.info, so
   * adding the field is what makes the refusal countable.
   */
  reasonCode?: CuratorDecision['reasonCode'];
  /** Topic files written by a consolidation pass. 0 is a valid, distinct
   *  outcome from the empty-tail maintenance_noop (P2.4 item 7). */
  fileCount?: number;
  /** Topic files the model proposed but validateConsolidationFiles dropped
   *  (bad path, oversized once serialized, or beyond the max-file count).
   *  The tail is still marked consolidated and the pass still succeeds —
   *  see runMaintenanceJob. */
  rejectedCount?: number;
  messageCount: number;
  transcriptChars: number;
  model?: string;
  effort?: string;
  credentialSlot?: string;
  usage?: CuratorBackendResult['usage'];
  elapsedMs: number;
}

export interface MemoryCuratorWorkerDependencies {
  admission: (nowMs: number) => {
    allowed: boolean;
    hourly: number;
    daily: number;
    hourlyLimit: number;
    dailyLimit: number;
  };
  credentials: () => ClaudeCredentialSlot[];
  selectCredential: (slots: ClaudeCredentialSlot[], nowMs: number) => MemoryCurationCredentialSelection;
  markCredentialUnavailable: (
    slot: ClaudeCredentialSlot,
    errorClass: 'quota' | 'auth',
    nowMs: number,
    retryAfterMs: number | null,
  ) => string;
  markCredentialAvailable: (slot: ClaudeCredentialSlot, nowMs: number) => void;
  claim: (owner: string, nowMs: number) => MemoryCurationEpisode | null;
  claimMaintenance: (owner: string, nowMs: number) => MemoryMaintenanceJob | null;
  members: (workgroupId: string) => string[];
  messages: (episode: MemoryCurationEpisode, members: string[]) => MemoryCurationArchiveRow[];
  complete: (episode: MemoryCurationEpisode, nowMs: number) => boolean;
  fail: (episode: MemoryCurationEpisode, errorClass: string, nowMs: number) => boolean;
  completeMaintenance: (job: MemoryMaintenanceJob, nowMs: number, reassertPending: boolean) => boolean;
  failMaintenance: (job: MemoryMaintenanceJob, nowMs: number) => boolean;
  recordCall: (id: string, workgroupId: string, credentialSlot: ClaudeCredentialSlot, nowMs: number) => boolean;
  finishCall: (id: string, outcome: string) => void;
  readGenerated: (workgroupId: string) => { content: string; sha256: string | null };
  writeGenerated: (
    workgroupId: string,
    content: string,
    expectedSha256: string | null,
    nowMs: number,
  ) => Promise<CuratorWriteResult>;
  recordAccepted: (workgroupId: string, contentBytes: number, nowMs: number) => void;
  manualMemory: (workgroupId: string, query: string) => Array<{ path: string; text: string }>;
  curate: (
    system: string,
    user: string,
    credentialSlot: ClaudeCredentialSlot,
    signal?: AbortSignal,
  ) => Promise<CuratorBackendResult>;
  /** Every ledger fact not yet in memory_consolidated_facts, ledger order,
   *  capped to CONSOLIDATION_MAX_FACTS. `hasMore` is whether the UNCAPPED
   *  unconsolidated set is larger than the capped tail returned. */
  consolidationTail: (workgroupId: string) => { facts: ConsolidationTailFact[]; hasMore: boolean };
  /** Real topic files under people/domain/systems, capped per-file and in
   *  total (P2.4 item 6); over-cap paths come back separately as locked. */
  scanTopicFiles: (workgroupId: string) => { files: ConsolidationTopicFile[]; excludedPaths: string[] };
  markConsolidated: (workgroupId: string, factIds: string[]) => void;
  writeTopicFile: (
    workgroupId: string,
    relativePath: string,
    content: string,
    expectedSha256: string | null,
    factsCount: number,
  ) => Promise<CuratorWriteResult>;
  consolidate: (
    system: string,
    user: string,
    credentialSlot: ClaudeCredentialSlot,
    signal?: AbortSignal,
  ) => Promise<ConsolidationBackendResult>;
  uuid: () => string;
}

function actualDependencies(): MemoryCuratorWorkerDependencies {
  const backend = new MemoryCuratorBackend();
  return {
    admission: (nowMs) => memoryCurationAdmission({ nowMs }),
    credentials: () => listClaudeStructuredCredentialSlots(),
    selectCredential: (slots, nowMs) => selectMemoryCurationCredential(slots, { nowMs }),
    markCredentialUnavailable: (slot, errorClass, nowMs, retryAfterMs) =>
      markMemoryCurationCredentialUnavailable(slot, errorClass, { nowMs, retryAfterMs }),
    markCredentialAvailable: (slot, nowMs) => markMemoryCurationCredentialAvailable(slot, { nowMs }),
    claim: (owner, nowMs) => claimMemoryCurationEpisode(owner, { nowMs }),
    claimMaintenance: (owner, nowMs) => claimMemoryMaintenance(owner, { nowMs }),
    members: getWorkgroupMemberIds,
    messages: (episode, members) => readMemoryCurationEpisodeMessages(episode, members, MAX_RAW_MESSAGES),
    complete: (episode, nowMs) => completeMemoryCurationEpisode(episode, { nowMs }),
    fail: (episode, errorClass, nowMs) => failMemoryCurationEpisode(episode, errorClass, { nowMs }),
    completeMaintenance: (job, nowMs, reassertPending) => completeMemoryMaintenance(job, { nowMs, reassertPending }),
    failMaintenance: (job, nowMs) => failMemoryMaintenance(job, { nowMs }),
    recordCall: (id, workgroupId, credentialSlot, nowMs) =>
      recordMemoryCurationCall(id, workgroupId, { nowMs, credentialSlot }),
    finishCall: finishMemoryCurationCall,
    readGenerated: readGeneratedMemory,
    writeGenerated: (workgroupId, content, expectedSha256, nowMs) =>
      writeGeneratedMemory(workgroupId, content, expectedSha256, { nowMs }),
    recordAccepted: (workgroupId, contentBytes, nowMs) =>
      recordAcceptedGeneratedMemory(workgroupId, contentBytes, { nowMs }),
    manualMemory: readRelevantManualMemory,
    curate: (system, user, credentialSlot, signal) => backend.curate(system, user, credentialSlot, signal),
    consolidationTail: (workgroupId) => {
      const ledgerFacts = parseGeneratedMemoryFacts(readGeneratedMemory(workgroupId).content);
      // Prune BEFORE computing the tail (P2.4 item 1 correction, F3): a
      // superseded fact's row must die with it, or an A→B→A revert — B
      // superseding A, then a later fact re-stating A's exact text — gets a
      // fresh content-hash id that's correctly tail-eligible, but the STALE
      // row for the old id sits forever, and the table stops tracking ledger
      // size. Pruning first means a fact that comes back this same pass is
      // immediately eligible, not next pass.
      pruneConsolidatedFacts(workgroupId, new Set(ledgerFacts.map((fact) => fact.id)));
      return computeConsolidationTail(ledgerFacts, consolidatedFactIds(workgroupId), CONSOLIDATION_MAX_FACTS);
    },
    scanTopicFiles,
    markConsolidated: markFactsConsolidated,
    writeTopicFile: writeMemoryTopicFile,
    consolidate: (system, user, credentialSlot, signal) => backend.consolidate(system, user, credentialSlot, signal),
    uuid: randomUUID,
  };
}

export function isMemoryCuratorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env.NANOCLAW_MEMORY_CURATOR_ENABLED ?? '');
}

export function getWorkgroupMemberIds(workgroupId: string): string[] {
  return (
    getDb().prepare('SELECT id FROM agent_groups WHERE workgroup_id = ? ORDER BY id').all(workgroupId) as Array<{
      id: string;
    }>
  ).map((row) => row.id);
}

function normalizeDuplicateKey(message: MemoryCurationArchiveRow): string {
  return `${message.role}\0${message.sentAt}\0${message.text.replace(/\s+/g, ' ').trim()}`;
}

/**
 * True for a message the agent never replied to (role isn't 'assistant' —
 * always true for a solo message in this flow, since an agent reply would
 * be a second archived row) whose sender is a Slack bot user. Slack's own ID
 * namespace prefixes bot users with `B` (vs `U` for humans) — see
 * https://api.slack.com/changelog/2016-08-11-user-id-format-changes — so
 * this is a platform convention, not an invented heuristic. `channelType`
 * carries a per-workspace/per-sibling-bot suffix (`slack-acme-codex`,
 * etc — see `isSlackChannelType` in router.ts), so match on prefix, not
 * equality. `senderId` is stored as `${channelType}:${platformUserId}`
 * (confirmed against data/archive.db), so the bot-id check runs on the
 * segment after the last colon, not the whole field. Scoped to Slack only:
 * other channels don't share the prefix and are left untouched.
 */
export function isUnansweredSoloBotMessage(message: MemoryCurationArchiveRow): boolean {
  if (message.role === 'assistant') return false;
  if (message.channelType !== 'slack' && !message.channelType.startsWith('slack-')) return false;
  const senderId = message.senderId ?? '';
  const platformUserId = senderId.slice(senderId.lastIndexOf(':') + 1);
  return /^B[A-Z0-9]+$/.test(platformUserId);
}

export function boundEpisodeMessages(raw: MemoryCurationArchiveRow[]): {
  messages: MemoryCurationArchiveRow[];
  handledThroughRowid: number;
  transcriptChars: number;
} {
  const messages: MemoryCurationArchiveRow[] = [];
  const seen = new Set<string>();
  let transcriptChars = 0;
  let handledThroughRowid = raw[0]?.rowid ?? 0;
  for (const item of raw) {
    if (messages.length >= MAX_EPISODE_MESSAGES || transcriptChars >= MAX_EPISODE_CHARS) break;
    handledThroughRowid = item.rowid;
    const key = normalizeDuplicateKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const remaining = MAX_EPISODE_CHARS - transcriptChars;
    const text =
      item.text.length <= remaining
        ? item.text
        : remaining > EPISODE_TRUNCATION_MARKER.length
          ? `${item.text.slice(0, remaining - EPISODE_TRUNCATION_MARKER.length)}${EPISODE_TRUNCATION_MARKER}`
          : item.text.slice(0, remaining);
    messages.push({ ...item, text });
    transcriptChars += text.length;
  }
  return { messages, handledThroughRowid, transcriptChars };
}

/**
 * The order-independent tail (docs/specs/workgroup-cerebro/plan.md §P2.4
 * item 1): every ledger fact whose id is absent from `consolidated`, in
 * ledger order, capped to `limit`. Pure — no timestamp comparison, so a
 * late-arriving or equal-`captured=` episode is never skipped.
 */
export function computeConsolidationTail(
  ledgerFacts: readonly { id: string; text: string; capturedAt: string }[],
  consolidated: ReadonlySet<string>,
  limit: number,
): { facts: ConsolidationTailFact[]; hasMore: boolean } {
  const unconsolidated = ledgerFacts.filter((fact) => !consolidated.has(fact.id));
  return {
    facts: unconsolidated
      .slice(0, limit)
      .map((fact) => ({ id: fact.id, text: fact.text, capturedAt: fact.capturedAt })),
    hasMore: unconsolidated.length > limit,
  };
}

/**
 * Real topic files under people/domain/systems (flat, one level — matches
 * TOPIC_FILE_PATH_PATTERN). Applies the per-file and total input caps (P2.4
 * item 6): an over-cap file is excluded and reported back as locked, so the
 * caller can refuse any model-proposed write to it — the model never
 * blind-overwrites content it did not see.
 */
export function scanTopicFiles(workgroupId: string): {
  files: ConsolidationTopicFile[];
  excludedPaths: string[];
} {
  const root = workgroupMemoryDir(workgroupId);
  const files: ConsolidationTopicFile[] = [];
  const excludedPaths: string[] = [];
  let totalBytes = 0;
  for (const dir of TOPIC_DIRECTORIES) {
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(path.join(root, dir), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const relative = `${dir}/${entry.name}`;
      if (!TOPIC_FILE_PATH_PATTERN.test(relative)) continue;
      let size: number;
      try {
        size = fs.lstatSync(path.join(root, relative)).size;
      } catch {
        continue;
      }
      if (size > CONSOLIDATION_INPUT_FILE_MAX_BYTES || totalBytes + size > CONSOLIDATION_INPUT_TOTAL_MAX_BYTES) {
        excludedPaths.push(relative);
        continue;
      }
      // Pass the input cap straight to the read (not the default 8 MiB
      // generated-memory ceiling) so a file that grows between the lstat
      // above and this open cannot be slurped whole — readMemoryTopicFile
      // throws rather than reading past maxBytes.
      let current: { content: string; sha256: string | null };
      try {
        current = readMemoryTopicFile(workgroupId, relative, CONSOLIDATION_INPUT_FILE_MAX_BYTES);
      } catch {
        excludedPaths.push(relative); // grew past the cap between lstat and open
        continue;
      }
      if (current.sha256 === null) continue; // vanished between listing and read
      // Re-check the ACTUAL bytes read against both caps: the lstat size and
      // the open-time bound can't see the running total from files already
      // accumulated earlier in this same scan.
      const contentBytes = Buffer.byteLength(current.content, 'utf8');
      if (
        contentBytes > CONSOLIDATION_INPUT_FILE_MAX_BYTES ||
        totalBytes + contentBytes > CONSOLIDATION_INPUT_TOTAL_MAX_BYTES
      ) {
        excludedPaths.push(relative);
        continue;
      }
      totalBytes += contentBytes;
      files.push({
        path: relative,
        content: current.content,
        owned: CONSOLIDATION_HEADER_PATTERN.test(current.content.split('\n', 1)[0] ?? ''),
      });
    }
  }
  return { files, excludedPaths };
}

export function selectGeneratedMemoryForPrompt(content: string, query: string): string {
  if (content.length <= MAX_GENERATED_PROMPT_CHARS) return content;
  const queryTokens = new Set(tokenizeForRecall(query));
  const candidates = content
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith('- '))
    .map(({ line, index }) => {
      const tokens = new Set(tokenizeForRecall(line.slice(0, line.indexOf('<!--'))));
      let score = 0;
      for (const token of queryTokens) if (tokens.has(token)) score++;
      return { line, index, score };
    })
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const heading = '# Generated workgroup memory\n\n';
  let chars = heading.length + 1;
  const selected: Array<{ line: string; index: number }> = [];
  for (const candidate of candidates) {
    if (chars + candidate.line.length + 1 > MAX_GENERATED_PROMPT_CHARS) continue;
    selected.push(candidate);
    chars += candidate.line.length + 1;
  }
  selected.sort((a, b) => a.index - b.index);
  return `${heading}${selected.map(({ line }) => line).join('\n')}\n`;
}

function safeReadManualFile(filePath: string, canonicalRoot: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) return null;
    const resolved = fs.realpathSync(filePath);
    const relative = path.relative(canonicalRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const resolvedStat = fs.statSync(resolved);
    if (!resolvedStat.isFile() || resolvedStat.dev !== opened.dev || resolvedStat.ino !== opened.ino) return null;
    const bytes = Math.min(opened.size, maxBytes, MAX_MANUAL_FILE_BYTES);
    const buffer = Buffer.alloc(bytes);
    const read = bytes > 0 ? fs.readSync(fd, buffer, 0, bytes, 0) : 0;
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function readRelevantManualMemory(workgroupId: string, query: string): Array<{ path: string; text: string }> {
  const root = workgroupMemoryDir(workgroupId);
  if (!fs.existsSync(root)) return [];
  const rootStat = fs.lstatSync(root);
  const workgroupRoot = path.dirname(root);
  const workgroupStat = fs.lstatSync(workgroupRoot);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    workgroupStat.isSymbolicLink() ||
    !workgroupStat.isDirectory()
  ) {
    return [];
  }
  const canonicalWorkgroupRoot = fs.realpathSync(workgroupRoot);
  const canonicalRoot = fs.realpathSync(root);
  if (path.dirname(canonicalRoot) !== canonicalWorkgroupRoot) return [];
  const queryTokens = new Set(tokenizeForRecall(query));
  if (queryTokens.size === 0) return [];
  const pending = [''];
  const candidates: Array<{ path: string; text: string; score: number }> = [];
  let visited = 0;
  let scanned = 0;
  while (pending.length > 0 && visited < MAX_MANUAL_FILES && scanned < MAX_MANUAL_SCAN_BYTES) {
    const relativeDir = pending.shift()!;
    const absoluteDir = path.join(canonicalRoot, relativeDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited++ >= MAX_MANUAL_FILES || scanned >= MAX_MANUAL_SCAN_BYTES) break;
      const relative = path.posix.join(relativeDir.split(path.sep).join('/'), entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (relative === 'generated' || relative.startsWith('.')) continue;
        pending.push(relative);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      if (relative === 'system/definition.md') continue;
      const text = safeReadManualFile(
        path.join(canonicalRoot, relative),
        canonicalRoot,
        MAX_MANUAL_SCAN_BYTES - scanned,
      );
      if (text === null) continue;
      scanned += Buffer.byteLength(text);
      const tokens = new Set(tokenizeForRecall(text));
      let score = 0;
      for (const token of queryTokens) if (tokens.has(token)) score++;
      if (score > 0) {
        candidates.push({
          path: relative,
          text: text.slice(0, MAX_MANUAL_EXCERPT_CHARS),
          score,
        });
      }
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_MANUAL_EXCERPTS)
    .map(({ path: relativePath, text }) => ({ path: relativePath, text }));
}

function classifyError(error: unknown): string {
  const status = (error as { status?: number }).status;
  if (status === 429) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (typeof status === 'number' && status >= 500) return 'provider_5xx';
  if ((error as Error)?.name === 'AbortError') return 'timeout';
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b/.test(message)) return 'quota';
  if (/\b(?:401|403)\b/.test(message)) return 'auth';
  if (/\b5\d\d\b/.test(message)) return 'provider_5xx';
  if (/conflict/i.test(message)) return 'write_conflict';
  if (/secret|evidence|memory id|generated memory|curator|JSON|model mismatch|refused/i.test(message)) {
    return 'validation';
  }
  return 'unexpected';
}

function retryAfterMs(error: unknown): number | null {
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

interface SuccessfulModelAttempt<T> {
  result: T;
  callId: string;
}

const REPAIRABLE_VIOLATIONS = new Map<string, string>([
  [
    'curator memory text exceeds the maximum',
    // "Shorten it but lose nothing" is not always satisfiable in one fact, and
    // the retry after this one starts from a clean prompt with no memory of the
    // failure — so a candidate that cannot be compressed loops until it hits the
    // 24h backoff, which is how the old 1,000-char limit produced hundreds of
    // failures at a dozen attempts each. Splitting is the way out, and the
    // schema already allows up to CURATOR_MAX_NEW_MEMORIES candidates.
    `Every memory candidate text must be at most ${CURATOR_MAX_MEMORY_TEXT_CHARS} characters while remaining self-contained. First tighten the wording. Split only when the candidate is genuinely more than one fact, so each part stands alone with its own evidence ids and is still true read on its own — never chop a single fact whose parts only make sense together. Do not compress past the point of being understandable, and do not omit a durable fact merely to satisfy this correction.`,
  ],
  [
    'curator replacement needs a capture reason code',
    `A replacement must use one of these reason codes: ${CURATOR_CAPTURE_REASON_CODES.join(', ')}. Keep the same memories and supersedesMemoryIds; only relabel the reason so it describes the new fact. Do not drop a supersession or a durable fact to satisfy this correction.`,
  ],
  [
    'curator returned an unknown evidence id',
    // Measured on production failures: 86% of platform timestamps are archived
    // under 2+ agent groups, so the id-prefix rescue that saves a bare
    // timestamp usually cannot find a unique match and this throws instead.
    // The prompt already shows the correct full id — this is model fidelity,
    // not a data defect — so the fix is telling the model to stop shortening it.
    'Every evidenceIds entry must be copied verbatim from the id field of a message in the episode, including its :<agent_group_id> suffix — never shorten an id to just its timestamp. Keep the same memories and evidence; only fix ids that were truncated or altered. Do not drop a fact or its evidence to satisfy this correction.',
  ],
]);

function repairInstructionFor(error: unknown): string | null {
  return error instanceof Error ? (REPAIRABLE_VIOLATIONS.get(error.message) ?? null) : null;
}

export class MemoryCuratorWorker {
  constructor(private readonly deps: MemoryCuratorWorkerDependencies = actualDependencies()) {}

  async runOne(nowMs = Date.now(), signal?: AbortSignal): Promise<MemoryCuratorRunReport | null> {
    const owner = `memory-curator-${this.deps.uuid()}`;
    // Admission and credential selection gate maintenance the same way they
    // gate episodes (P2-AC13) — a maintenance job's model call is otherwise
    // unaccounted and unabortable, which is exactly the gap P2.4 item 9
    // closes. A tail that turns out empty still makes zero model calls
    // either way, same as an episode whose claimed messages turn out empty.
    const admission = this.deps.admission(nowMs);
    if (!admission.allowed) {
      logAdmissionExhausted(nowMs, admission);
      return null;
    }
    const credentials = this.deps.credentials();
    const availability = this.deps.selectCredential(credentials, nowMs);
    if (!availability.slot) {
      logCredentialUnavailable(nowMs, {
        retryAt: availability.retryAt,
        unavailableSlots: availability.unavailableSlots,
        configuredSlots: credentials,
      });
      return null;
    }
    const maintenanceJob = this.deps.claimMaintenance(owner, nowMs);
    if (maintenanceJob) return this.runMaintenanceJob(maintenanceJob, nowMs, credentials, signal);
    const episode = this.deps.claim(owner, nowMs);
    if (!episode) return null;
    const started = Date.now();
    let callId: string | null = null;
    let outcome = 'failed';
    try {
      const members = this.deps.members(episode.workgroupId);
      const raw = this.deps.messages(episode, members);
      if (raw.length === 0) {
        if (!this.deps.complete(episode, nowMs)) throw new Error('memory curator lost its empty episode lease');
        return {
          workgroupId: episode.workgroupId,
          episodeKey: episode.episodeKey,
          action: 'noop',
          messageCount: 0,
          transcriptChars: 0,
          elapsedMs: Date.now() - started,
        };
      }
      const bounded = boundEpisodeMessages(raw);
      const handledEpisode = { ...episode, claimedThroughRowid: bounded.handledThroughRowid };
      // Cheap pre-model gate: a one-message episode that is a Slack bot
      // notification (Snowflake alerts, Linear notifications, etc.) posted
      // into a `mention`-mode channel the agent never replied to has nothing
      // to curate — every such episode observed in the fleet logs decides
      // noop anyway. Skip the Sonnet call entirely rather than pay for a
      // decision that's already known. Real conversations (>1 message, or a
      // human sender) are untouched — this never fires for them.
      if (bounded.messages.length === 1 && isUnansweredSoloBotMessage(bounded.messages[0]!)) {
        if (!this.deps.complete(handledEpisode, nowMs)) throw new Error('memory curator lost its episode lease');
        return {
          workgroupId: episode.workgroupId,
          episodeKey: episode.episodeKey,
          action: 'noop',
          reasonCode: 'insufficient_evidence',
          messageCount: bounded.messages.length,
          transcriptChars: bounded.transcriptChars,
          elapsedMs: Date.now() - started,
        };
      }
      const generated = this.deps.readGenerated(episode.workgroupId);
      const query = bounded.messages.map((message) => message.text).join('\n');
      const generatedPrompt = selectGeneratedMemoryForPrompt(generated.content, query);
      const manual = this.deps.manualMemory(episode.workgroupId, query);
      const prompt = buildCuratorPrompt({
        workgroupId: episode.workgroupId,
        messages: bounded.messages,
        generatedMemory: generatedPrompt,
        relevantManualMemory: manual,
        boundary: this.deps.uuid().replaceAll('-', ''),
      });
      let attempt = await this.runModelWithFailover('memory-curator', episode.workgroupId, credentials, nowMs, (slot) =>
        this.deps.curate(prompt.system, prompt.user, slot, signal),
      );
      callId = attempt.callId;
      let backend = attempt.result;
      const priorEvidence = parseGeneratedMemoryFacts(generated.content).flatMap((fact) => fact.evidenceIds);
      const allowedEvidenceIds = new Set([...priorEvidence, ...bounded.messages.map((message) => message.id)]);
      const validationContext = {
        currentContent: generated.content,
        allowedEvidenceIds,
        currentEpisodeEvidence: new Map(bounded.messages.map((message) => [message.id, message.sentAt])),
      };
      let decision: CuratorDecision;
      try {
        decision = validateCuratorDecision(backend.decision, validationContext);
      } catch (error) {
        const repairInstruction = repairInstructionFor(error);
        if (repairInstruction === null) throw error;
        this.deps.finishCall(callId, 'validation_retry');
        callId = null;
        const repairSystem = [
          prompt.system,
          `Your previous structured response was rejected: ${(error as Error).message}.`,
          `Retry once. ${repairInstruction}`,
        ].join('\n');
        attempt = await this.runModelWithFailover(
          'memory-curator-repair',
          episode.workgroupId,
          credentials,
          nowMs,
          (slot) => this.deps.curate(repairSystem, prompt.user, slot, signal),
        );
        callId = attempt.callId;
        backend = attempt.result;
        decision = validateCuratorDecision(backend.decision, validationContext);
      }
      if (decision.action === 'replace_generated_memory') {
        const write = await this.deps.writeGenerated(episode.workgroupId, decision.content, generated.sha256, nowMs);
        if (write.status !== 'success') throw new Error(`memory write ${write.status}: ${write.error ?? 'unknown'}`);
        const acceptedBytes = Buffer.byteLength(decision.content, 'utf8');
        this.deps.recordAccepted(episode.workgroupId, acceptedBytes, nowMs);
        // Facts are never evicted, so the store only grows. Say so early and
        // loudly: at the old cap this filled silently and every later capture
        // failed validation forever with nothing surfaced above debug logs.
        if (acceptedBytes > GENERATED_MEMORY_WARN_BYTES) {
          log.warn('memory-curator: generated memory approaching its ceiling', {
            workgroupId: episode.workgroupId,
            bytes: acceptedBytes,
            maxBytes: GENERATED_MEMORY_MAX_BYTES,
            percentOfMax: Math.round((acceptedBytes / GENERATED_MEMORY_MAX_BYTES) * 100),
          });
        }
      }
      if (!this.deps.complete(handledEpisode, nowMs)) throw new Error('memory curator lost its episode lease');
      outcome = decision.action === 'noop' ? 'noop' : 'memory_written';
      return {
        workgroupId: episode.workgroupId,
        episodeKey: episode.episodeKey,
        action: decision.action,
        reasonCode: decision.reasonCode,
        messageCount: bounded.messages.length,
        transcriptChars: bounded.transcriptChars,
        model: backend.model,
        effort: MEMORY_CURATOR_EFFORT,
        credentialSlot: backend.credentialSlot,
        usage: backend.usage,
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      const errorClass = classifyError(error);
      this.deps.fail(episode, errorClass, nowMs);
      const detail = error as {
        candidateChars?: number;
        limitChars?: number;
        offendingEvidenceId?: string;
        submittedEvidenceIds?: string[];
      };
      log.warn('memory-curator: episode failed', {
        workgroupId: episode.workgroupId,
        episodeKey: episode.episodeKey,
        errorClass,
        error: error instanceof Error ? error.message : String(error),
        // Only present on a length rejection. Without it a length failure is
        // unattributable: there is no way to tell "missed by 20 characters" from
        // "tried to write a transcript", and those want opposite responses.
        ...(typeof detail.candidateChars === 'number'
          ? { candidateChars: detail.candidateChars, limitChars: detail.limitChars }
          : {}),
        // Only present on an unknown-evidence-id rejection. Without it the
        // rejection is unattributable — no way to tell which id the model sent,
        // or whether it was the bare-timestamp truncation the prefix rescue
        // exists for.
        ...(typeof detail.offendingEvidenceId === 'string'
          ? { offendingEvidenceId: detail.offendingEvidenceId, submittedEvidenceIds: detail.submittedEvidenceIds }
          : {}),
      });
      return null;
    } finally {
      if (callId) this.deps.finishCall(callId, outcome);
    }
  }

  /**
   * P2.4 items 1, 7, 8, 9: the consolidation pass. Runs through the same
   * admission/credential/failover/abort machinery episodes use — the caller
   * (runOne) has already gated admission and credential selection before
   * claiming this job. An empty tail is a real maintenance_noop with zero
   * model calls; a non-empty tail always calls the model, even when it ends
   * up proposing zero files (P2-AC7 — those are distinct outcomes).
   */
  private async runMaintenanceJob(
    job: MemoryMaintenanceJob,
    nowMs: number,
    credentials: ClaudeCredentialSlot[],
    signal?: AbortSignal,
  ): Promise<MemoryCuratorRunReport | null> {
    const started = Date.now();
    let callId: string | null = null;
    let outcome = 'failed';
    try {
      const tail = this.deps.consolidationTail(job.workgroupId);
      if (tail.facts.length === 0) {
        if (!this.deps.completeMaintenance(job, nowMs, false)) throw new Error('memory maintenance lost its lease');
        return {
          workgroupId: job.workgroupId,
          episodeKey: 'maintenance',
          action: 'maintenance_noop',
          messageCount: 0,
          transcriptChars: 0,
          elapsedMs: Date.now() - started,
        };
      }
      const scan = this.deps.scanTopicFiles(job.workgroupId);
      if (scan.excludedPaths.length > 0) {
        log.warn('memory-curator: over-cap topic files excluded and locked for this pass', {
          workgroupId: job.workgroupId,
          excludedPaths: scan.excludedPaths,
        });
      }
      const prompt = buildConsolidationPrompt({
        workgroupId: job.workgroupId,
        tail: tail.facts,
        topicFiles: scan.files,
        boundary: this.deps.uuid().replaceAll('-', ''),
      });
      const attempt = await this.runModelWithFailover(
        'memory-consolidator',
        job.workgroupId,
        credentials,
        nowMs,
        (slot) => this.deps.consolidate(prompt.system, prompt.user, slot, signal),
      );
      callId = attempt.callId;
      // The failover loop only checks the signal WHILE a model call is in
      // flight (a rejecting consolidate() call); nothing downstream of a
      // successful return re-checks it. Re-check at each further step that
      // does real work, so an abort after the model responds still stops
      // writes rather than completing them anyway.
      signal?.throwIfAborted();
      // Batch-level validation (path, per-file size on header+content, max
      // file count) BEFORE any write. Per-file violations are PARTITIONED,
      // not thrown: a deterministic per-entity rejection here would otherwise
      // re-present the identical tail to the same model forever (the model
      // has no memory of the rejection on the next pass), permanently
      // deadlocking consolidation for every fact behind the bad one. Only
      // `accepted` files are written; `rejected` ones are logged and the tail
      // is still marked consolidated below, same as the model choosing not
      // to touch them.
      const { accepted: validated, rejected: contentRejections } = validateConsolidationFiles(
        attempt.result.decision,
        tail.facts.length,
      );
      // Locked = over-cap (never read) UNION presented-but-not-owned (read as
      // context only). The latter matters even if the file vanishes from
      // disk mid-pass: the model was TOLD it was human-authored and must
      // still be refused, not silently allowed once there's nothing left on
      // disk to fail an ownership-header check against.
      const lockedPaths = new Set([
        ...scan.excludedPaths,
        ...scan.files.filter((file) => !file.owned).map((file) => file.path),
      ]);
      const ownedByPath = new Map(scan.files.filter((file) => file.owned).map((file) => [file.path, file]));
      // A locked-path write is a per-file rejection, exactly like a bad path
      // or an oversized file — not a thrown protocol violation. The locked
      // set is deterministic per pass (over-cap files and human-authored
      // files never change mid-pass), so retrying the whole pass on this
      // throw could never succeed: it just re-presents the identical tail to
      // the same model, which proposes the same locked path again, forever
      // (production poison loop, 6h backoff each cycle). Dropping the file
      // and letting the rest of the batch land is what makes progress.
      const accepted: ConsolidationFileCandidate[] = [];
      const lockedRejections: ConsolidationFileRejection[] = [];
      for (const file of validated) {
        if (lockedPaths.has(file.path)) {
          lockedRejections.push({ path: file.path, reason: 'locked-path' });
          continue;
        }
        accepted.push(file);
      }
      const rejected = [...contentRejections, ...lockedRejections];
      if (rejected.length > 0) {
        // Named per-path, with reason and byte size where relevant, so an
        // operator can see WHICH entity is being persistently dropped rather
        // than just a count.
        log.warn('memory-curator: consolidation dropped invalid topic files this pass', {
          workgroupId: job.workgroupId,
          rejected,
        });
      }
      for (const file of accepted) {
        signal?.throwIfAborted();
        // A brand-new path has no prior content → create-only (null). An
        // owned existing path's expected hash is the content this pass
        // actually read, so a sibling write mid-pass surfaces as a conflict
        // rather than silently overwriting it.
        const priorContent = ownedByPath.get(file.path)?.content;
        const expectedSha256 = priorContent === undefined ? null : generatedMemorySha(priorContent);
        const write = await this.deps.writeTopicFile(
          job.workgroupId,
          file.path,
          file.content,
          expectedSha256,
          tail.facts.length,
        );
        if (write.status !== 'success') {
          throw new Error(`memory topic write ${write.status}: ${write.error ?? 'unknown'}`);
        }
      }
      // completeMaintenance is the owner-conditioned atomic check (its SQL
      // is `WHERE workgroup_id = ? AND lease_owner = ?`), so it MUST run
      // before markConsolidated: if the lease was lost mid-pass — another
      // worker reclaimed after ours expired — completeMaintenance returns
      // false and this throws without ever marking anything consolidated.
      // Ids can never be marked against a lease this worker no longer owns.
      // (failMaintenance in the catch below is then a harmless no-op — its
      // SQL is equally owner-conditioned, so it can't touch a lease someone
      // else now holds.)
      //
      // Crash window: if the process dies between completeMaintenance
      // succeeding and markConsolidated running below, the facts are WRITTEN
      // but never MARKED. That is the safe direction — at-least-once, not
      // at-most-once: the same facts are simply re-presented as the tail on
      // the next trigger, the model reads topic files that already reflect
      // them (the writes were CAS'd against their own current content, so
      // nothing double-applies), and a correct model converges to
      // `files: []` — which itself marks the tail on that next pass.
      signal?.throwIfAborted();
      if (!this.deps.completeMaintenance(job, nowMs, tail.hasMore)) {
        throw new Error('memory maintenance lost its lease');
      }
      this.deps.markConsolidated(
        job.workgroupId,
        tail.facts.map((fact) => fact.id),
      );
      outcome = 'maintenance_written';
      if (accepted.length === 0) {
        // Distinct from the empty-tail noop above: real facts were
        // consolidated. Either the model judged no topic file needed a
        // change (rejected.length === 0), or everything it proposed was
        // invalid (rejected.length > 0, logged above) — either way this is
        // the same "tail marked, nothing written" shape as the model
        // returning `files: []`.
        log.info('memory-curator: consolidation pass wrote zero files for a non-empty tail', {
          workgroupId: job.workgroupId,
          factCount: tail.facts.length,
          rejectedCount: rejected.length,
        });
      }
      return {
        workgroupId: job.workgroupId,
        episodeKey: 'maintenance',
        action: 'maintenance_written',
        fileCount: accepted.length,
        rejectedCount: rejected.length,
        messageCount: 0,
        transcriptChars: 0,
        model: attempt.result.model,
        effort: MEMORY_CURATOR_EFFORT,
        credentialSlot: attempt.result.credentialSlot,
        usage: attempt.result.usage,
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      this.deps.failMaintenance(job, nowMs);
      log.warn('memory-curator: maintenance failed', {
        workgroupId: job.workgroupId,
        errorClass: classifyError(error),
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      if (callId) this.deps.finishCall(callId, outcome);
    }
  }

  private async runModelWithFailover<T>(
    callPrefix: string,
    workgroupId: string,
    credentials: ClaudeCredentialSlot[],
    nowMs: number,
    execute: (slot: ClaudeCredentialSlot) => Promise<T>,
  ): Promise<SuccessfulModelAttempt<T>> {
    const remaining = new Set(credentials);
    let lastCredentialError: unknown = null;
    while (remaining.size > 0) {
      const admission = this.deps.admission(nowMs);
      if (!admission.allowed) {
        throw new Error(
          `memory curator model-call admission exhausted (${admission.hourly}/${admission.hourlyLimit} hourly, ` +
            `${admission.daily}/${admission.dailyLimit} daily)`,
        );
      }
      const selection = this.deps.selectCredential([...remaining], nowMs);
      if (!selection.slot) break;
      const slot = selection.slot as ClaudeCredentialSlot;
      remaining.delete(slot);
      const callId = `${callPrefix}-${this.deps.uuid()}`;
      if (!this.deps.recordCall(callId, workgroupId, slot, nowMs)) {
        throw new Error('memory curator could not record model-call admission');
      }
      try {
        const result = await execute(slot);
        this.deps.markCredentialAvailable(slot, nowMs);
        return { result, callId };
      } catch (error) {
        const errorClass = classifyError(error);
        this.deps.finishCall(callId, errorClass);
        if (errorClass !== 'quota' && errorClass !== 'auth') throw error;
        lastCredentialError = error;
        const unavailableUntil = this.deps.markCredentialUnavailable(slot, errorClass, nowMs, retryAfterMs(error));
        log.warn('memory-curator: credential unavailable; trying sibling credential', {
          credentialSlot: slot,
          errorClass,
          unavailableUntil,
          remainingCredentials: remaining.size,
        });
      }
    }
    if (lastCredentialError) throw lastCredentialError;
    throw new Error('memory curator has no currently available Anthropic credential');
  }
}

let activePump: Promise<MemoryCuratorRunReport | null> | null = null;
let activeController: AbortController | null = null;
let lastCredentialUnavailableWarningMs = 0;
let lastAdmissionWarningMs = 0;

function logAdmissionExhausted(
  nowMs: number,
  admission: {
    hourly: number;
    daily: number;
    hourlyLimit: number;
    dailyLimit: number;
  },
): void {
  if (nowMs - lastAdmissionWarningMs < 15 * 60_000) return;
  lastAdmissionWarningMs = nowMs;
  log.warn('memory-curator: admission limit delaying durable queue', admission);
}

function logCredentialUnavailable(
  nowMs: number,
  details: {
    retryAt: string | null;
    unavailableSlots: string[];
    configuredSlots: string[];
  },
): void {
  if (nowMs - lastCredentialUnavailableWarningMs < 15 * 60_000) return;
  lastCredentialUnavailableWarningMs = nowMs;
  log.warn('memory-curator: all credentials unavailable; durable queue retained', details);
}

export function runMemoryCurationInBackground(): Promise<MemoryCuratorRunReport | null> {
  if (!isMemoryCuratorEnabled()) return Promise.resolve(null);
  if (activePump) return activePump;
  activeController = new AbortController();
  activePump = new MemoryCuratorWorker()
    .runOne(Date.now(), activeController.signal)
    .then((report) => {
      if (report) log.info('memory-curator: episode complete', { ...report });
      return report;
    })
    .finally(() => {
      activePump = null;
      activeController = null;
    });
  return activePump;
}

export function stopMemoryCurationInBackground(): void {
  activeController?.abort();
}

export function _resetMemoryCuratorPumpForTest(): void {
  activeController?.abort();
  activePump = null;
  activeController = null;
  lastCredentialUnavailableWarningMs = 0;
  lastAdmissionWarningMs = 0;
}
