import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { getDb } from '../../db/connection.js';
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
import { MemoryCuratorBackend, MEMORY_CURATOR_EFFORT, type CuratorBackendResult } from './curator-backend.js';
import {
  buildCuratorPrompt,
  CURATOR_CAPTURE_REASON_CODES,
  CURATOR_MAX_MEMORY_TEXT_CHARS,
  GENERATED_MEMORY_MAX_BYTES,
  GENERATED_MEMORY_WARN_BYTES,
  parseGeneratedMemoryFacts,
  validateCuratorDecision,
  type CuratorDecision,
} from './curator-contract.js';
import { readGeneratedMemory, writeGeneratedMemory, type CuratorWriteResult } from './curator-write.js';

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
  completeMaintenance: (job: MemoryMaintenanceJob, nowMs: number) => boolean;
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
    completeMaintenance: (job, nowMs) => completeMemoryMaintenance(job, { nowMs }),
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
    `Every memory candidate text must be at most ${CURATOR_MAX_MEMORY_TEXT_CHARS} characters while remaining self-contained. Do not omit a durable fact merely to satisfy this correction.`,
  ],
  [
    'curator replacement needs a capture reason code',
    `A replacement must use one of these reason codes: ${CURATOR_CAPTURE_REASON_CODES.join(', ')}. Keep the same memories and supersedesMemoryIds; only relabel the reason so it describes the new fact. Do not drop a supersession or a durable fact to satisfy this correction.`,
  ],
]);

function repairInstructionFor(error: unknown): string | null {
  return error instanceof Error ? (REPAIRABLE_VIOLATIONS.get(error.message) ?? null) : null;
}

export class MemoryCuratorWorker {
  constructor(private readonly deps: MemoryCuratorWorkerDependencies = actualDependencies()) {}

  async runOne(nowMs = Date.now(), signal?: AbortSignal): Promise<MemoryCuratorRunReport | null> {
    const owner = `memory-curator-${this.deps.uuid()}`;
    const maintenance = await this.runMaintenance(owner, nowMs);
    if (maintenance !== undefined) return maintenance;
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
      log.warn('memory-curator: episode failed', {
        workgroupId: episode.workgroupId,
        episodeKey: episode.episodeKey,
        errorClass,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      if (callId) this.deps.finishCall(callId, outcome);
    }
  }

  private async runMaintenance(owner: string, nowMs: number): Promise<MemoryCuratorRunReport | null | undefined> {
    const job = this.deps.claimMaintenance(owner, nowMs);
    if (!job) return undefined;
    const started = Date.now();
    try {
      const generated = this.deps.readGenerated(job.workgroupId);
      if (!this.deps.completeMaintenance(job, nowMs)) throw new Error('memory maintenance lost its lease');
      return {
        workgroupId: job.workgroupId,
        episodeKey: 'maintenance',
        action: 'maintenance_noop',
        messageCount: 0,
        transcriptChars: generated.content.length,
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
