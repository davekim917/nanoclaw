import Database from 'better-sqlite3';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';

import { IsolatedPressureScanner } from './isolated-pressure.js';

function directoryNames(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const TERMINAL_ACKS = new Set(['completed', 'failed', 'script-skip:error']);

export function linuxMemAvailableBytes(meminfo: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  if (!match) return undefined;
  const kibibytes = Number(match[1]);
  return Number.isSafeInteger(kibibytes) ? kibibytes * 1024 : undefined;
}

/** Linux MemFree excludes reclaimable page cache and is not admission capacity. */
export function availableMemoryBytes(): number {
  if (process.platform === 'linux') {
    try {
      const available = linuxMemAvailableBytes(readFileSync('/proc/meminfo', 'utf8'));
      if (available !== undefined) return available;
    } catch {
      // Non-procfs Linux environments use the portable fallback.
    }
  }
  return freemem();
}

/** Read-only, fail-safe scan of the two DBs that already define session work. */
function sessionDirectories(sessionsRoot: string): string[] {
  return directoryNames(sessionsRoot).flatMap((agentGroupId) =>
    directoryNames(join(sessionsRoot, agentGroupId)).map((sessionId) => join(sessionsRoot, agentGroupId, sessionId)),
  );
}

function fileSignature(path: string): string | undefined {
  try {
    const entry = statSync(path);
    return `${entry.mtimeMs}:${entry.size}`;
  } catch {
    return undefined;
  }
}

function heartbeatMtime(dir: string): number {
  try {
    return statSync(join(dir, '.heartbeat')).mtimeMs;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

function sessionHasInteractivePressure(dir: string, now: Date): boolean {
  let inbound: Database.Database | undefined;
  let outbound: Database.Database | undefined;
  try {
    inbound = new Database(join(dir, 'inbound.db'), { readonly: true, fileMustExist: true });
    const rows = inbound
      .prepare(
        `
          SELECT id, status
            FROM messages_in
           WHERE kind IN ('chat', 'chat-sdk')
             AND status IN ('pending', 'processing')
             AND trigger = 1
             AND (process_after IS NULL OR datetime(process_after) <= datetime(?))
        `,
      )
      .all(now.toISOString()) as Array<{ id: string; status: string }>;
    if (rows.length === 0) return false;
    try {
      outbound = new Database(join(dir, 'outbound.db'), { readonly: true, fileMustExist: true });
    } catch {
      // Pending chat with no outbound DB has not been handled yet.
      return true;
    }
    const ack = outbound.prepare('SELECT status FROM processing_ack WHERE message_id = ?');
    for (const row of rows) {
      const found = ack.get(row.id) as { status: string } | undefined;
      if (!found || !TERMINAL_ACKS.has(found.status)) return true;
    }
  } catch {
    // Missing/partially-created session DBs do not themselves indicate
    // pressure; the host admission path remains the authoritative guard.
  } finally {
    outbound?.close();
    inbound?.close();
  }
  return false;
}

export function scanInteractivePressure(sessionsRoot: string, now = new Date()): boolean {
  return sessionDirectories(sessionsRoot).some((dir) => sessionHasInteractivePressure(dir, now));
}

interface SessionSignatures {
  inbound?: string;
  outbound?: string;
}

/**
 * Stateful pressure scanner. The first complete pass establishes a baseline;
 * later passes only open SQLite databases whose files changed. Before that
 * baseline is complete, recently-heartbeating sessions are inspected first so
 * an active interactive turn preempts the background lane without a 1,000-DB
 * cold scan.
 */
export class InteractivePressureScanner {
  private readonly signatures = new Map<string, SessionSignatures>();
  private readonly active = new Set<string>();
  private initialized = false;

  constructor(
    private readonly sessionsRoot: string,
    private readonly inspect: (dir: string, now: Date) => boolean = sessionHasInteractivePressure,
  ) {}

  scan(now = new Date()): boolean {
    // The common preemption path is one already-known active turn. Avoid
    // walking the entire session archive until that turn's DB state changes.
    for (const dir of [...this.active]) {
      const inbound = fileSignature(join(dir, 'inbound.db'));
      const outbound = fileSignature(join(dir, 'outbound.db'));
      const prior = this.signatures.get(dir);
      if (prior?.inbound === inbound && prior?.outbound === outbound) return true;
      const pressure = this.inspect(dir, now);
      this.signatures.set(dir, { inbound, outbound });
      if (pressure) return true;
      this.active.delete(dir);
    }

    const discovered = sessionDirectories(this.sessionsRoot);
    const directories = this.initialized
      ? discovered
      : discovered
          .map((dir) => ({ dir, heartbeat: heartbeatMtime(dir) }))
          .sort((left, right) => right.heartbeat - left.heartbeat)
          .map(({ dir }) => dir);
    const live = new Set(directories);

    for (const dir of directories) {
      const inbound = fileSignature(join(dir, 'inbound.db'));
      const prior = this.signatures.get(dir);
      if (prior?.inbound === inbound) continue;
      const pressure = this.inspect(dir, now);
      const outbound = pressure ? fileSignature(join(dir, 'outbound.db')) : undefined;
      this.signatures.set(dir, { inbound, outbound });
      if (pressure) {
        this.active.add(dir);
        return true;
      }
    }

    for (const dir of this.signatures.keys()) {
      if (live.has(dir)) continue;
      this.signatures.delete(dir);
      this.active.delete(dir);
    }
    this.initialized = true;
    return false;
  }
}

export type BackgroundResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'preempted' }
  | { status: 'deferred'; reason: 'memory' }
  | { status: 'failed'; error: Error };

export interface BackgroundGraphRunnerOptions {
  sessionsRoot: string;
  freeMemory?: () => number;
  minimumFreeBytes?: number;
  pollMs?: number;
  pressure?: () => boolean | Promise<boolean>;
}

export interface BackgroundJobOptions {
  /** Abort an admitted job if interactive pressure appears. Defaults to true. */
  preemptActive?: boolean;
}

/** Single global lane for Docker/Codex graph jobs, outside chat admission. */
export class BackgroundGraphRunner {
  private tail: Promise<void> = Promise.resolve();
  private readonly active = new Set<AbortController>();
  private stopped = false;
  private readonly freeMemory: () => number;
  private readonly pollMs: number;
  private readonly minimumFreeBytes: number;
  private readonly pressure: () => boolean | Promise<boolean>;
  private readonly isolatedPressure?: IsolatedPressureScanner;

  constructor(options: BackgroundGraphRunnerOptions) {
    this.freeMemory = options.freeMemory ?? availableMemoryBytes;
    this.pollMs = Math.min(2_000, Math.max(10, options.pollMs ?? 2_000));
    this.minimumFreeBytes = options.minimumFreeBytes ?? 6 * 1024 ** 3;
    if (options.pressure) this.pressure = options.pressure;
    else if (import.meta.url.endsWith('.ts')) {
      const pressureScanner = new InteractivePressureScanner(options.sessionsRoot);
      this.pressure = () => pressureScanner.scan();
    } else {
      this.isolatedPressure = new IsolatedPressureScanner(options.sessionsRoot);
      this.pressure = () => this.isolatedPressure!.scan();
    }
  }

  run<T>(job: (signal: AbortSignal) => Promise<T>, options: BackgroundJobOptions = {}): Promise<BackgroundResult<T>> {
    const result = this.tail.then(() => this.execute(job, options));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.active) controller.abort('Graphify daemon stopping');
    await this.tail;
    await this.isolatedPressure?.close();
  }

  private async execute<T>(
    job: (signal: AbortSignal) => Promise<T>,
    options: BackgroundJobOptions,
  ): Promise<BackgroundResult<T>> {
    if (this.stopped) return { status: 'preempted' };
    if (this.freeMemory() < this.minimumFreeBytes) return { status: 'deferred', reason: 'memory' };
    if (await this.pressure()) return { status: 'preempted' };
    const controller = new AbortController();
    this.active.add(controller);
    let preempted = false;
    let pressureScanRunning = false;
    const timer =
      options.preemptActive === false
        ? undefined
        : setInterval(() => {
            if (pressureScanRunning) return;
            pressureScanRunning = true;
            void Promise.resolve(this.pressure())
              .then((pressure) => {
                if (!pressure) return;
                preempted = true;
                controller.abort('interactive chat pressure');
              })
              .finally(() => {
                pressureScanRunning = false;
              });
          }, this.pollMs);
    timer?.unref();
    try {
      const value = await job(controller.signal);
      return preempted || controller.signal.aborted ? { status: 'preempted' } : { status: 'completed', value };
    } catch (error) {
      if (preempted || controller.signal.aborted) return { status: 'preempted' };
      return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      if (timer) clearInterval(timer);
      this.active.delete(controller);
    }
  }
}
