import Database from 'better-sqlite3';
import { readdirSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';

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

/** Read-only, fail-safe scan of the two DBs that already define session work. */
export function scanInteractivePressure(sessionsRoot: string, now = new Date()): boolean {
  for (const agentGroupId of directoryNames(sessionsRoot)) {
    for (const sessionId of directoryNames(join(sessionsRoot, agentGroupId))) {
      const dir = join(sessionsRoot, agentGroupId, sessionId);
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
        if (rows.length === 0) continue;
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
    }
  }
  return false;
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
  pressure?: () => boolean;
}

/** Single global lane for Docker/Codex graph jobs, outside chat admission. */
export class BackgroundGraphRunner {
  private tail: Promise<void> = Promise.resolve();
  private readonly active = new Set<AbortController>();
  private stopped = false;
  private readonly freeMemory: () => number;
  private readonly pollMs: number;
  private readonly minimumFreeBytes: number;
  private readonly pressure: () => boolean;

  constructor(options: BackgroundGraphRunnerOptions) {
    this.freeMemory = options.freeMemory ?? freemem;
    this.pollMs = Math.min(2_000, Math.max(10, options.pollMs ?? 2_000));
    this.minimumFreeBytes = options.minimumFreeBytes ?? 6 * 1024 ** 3;
    this.pressure = options.pressure ?? (() => scanInteractivePressure(options.sessionsRoot));
  }

  run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<BackgroundResult<T>> {
    const result = this.tail.then(() => this.execute(job));
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
  }

  private async execute<T>(job: (signal: AbortSignal) => Promise<T>): Promise<BackgroundResult<T>> {
    if (this.stopped) return { status: 'preempted' };
    if (this.freeMemory() < this.minimumFreeBytes) return { status: 'deferred', reason: 'memory' };
    if (this.pressure()) return { status: 'preempted' };
    const controller = new AbortController();
    this.active.add(controller);
    let preempted = false;
    const timer = setInterval(() => {
      if (this.pressure()) {
        preempted = true;
        controller.abort('interactive chat pressure');
      }
    }, this.pollMs);
    timer.unref();
    try {
      const value = await job(controller.signal);
      return preempted || controller.signal.aborted ? { status: 'preempted' } : { status: 'completed', value };
    } catch (error) {
      if (preempted || controller.signal.aborted) return { status: 'preempted' };
      return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      clearInterval(timer);
      this.active.delete(controller);
    }
  }
}
