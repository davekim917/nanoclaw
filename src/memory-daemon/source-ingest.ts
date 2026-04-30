import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { openMnemonIngestDb } from '../db/migrations/019-mnemon-ingest-db.js';
import { GROUPS_DIR } from '../config.js';
import type { MemoryStore, FactInput } from '../modules/memory/store.js';
import { redactSecrets } from '../modules/memory/secret-redactor.js';
import { callClassifier, EXTRACTOR_VERSION, PROMPT_VERSION } from './anthropic-client.js';
import { recordOrIncrementFailure } from './dead-letters.js';
import type { HealthRecorder } from './health.js';

export interface IngestSweepResult {
  watchersOpened: number;
  watchersClosed: number;
  filesIngested: number;
  factsWritten: number;
  failures: number;
}

const EXTRACTOR_SYSTEM_PROMPT = `You are a memory extraction assistant. Your job is to read a source document and extract atomic, reusable facts worth storing in a long-term memory system.

Output ONLY valid JSON matching this exact schema:
{
  "worth_storing": boolean,
  "facts": [
    {
      "content": string,
      "category": "preference" | "decision" | "insight" | "fact" | "context",
      "importance": number (1-5),
      "entities": string[],
      "source_role": "external"
    }
  ]
}

Rules:
- Set worth_storing to false and return an empty facts array if the document contains no durable information.
- Extract atomic facts — one clear, self-contained statement per fact.
- Preferred categories: preference, decision, insight, fact, context.
- Importance: 5 = critical/high-signal, 1 = low-signal background detail.
- NEVER extract secrets, credentials, API keys, tokens, passwords, or transient state.
- source_role must always be "external" for ingested source files.`;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function canonicalize(content: string): string {
  return content.trim().replace(/\r\n/g, '\n');
}

function dateFolder(): string {
  return new Date().toISOString().slice(0, 10);
}

let _db: Database.Database | null = null;

function getIngestDb(): Database.Database {
  if (!_db) {
    _db = openMnemonIngestDb();
  }
  return _db;
}

/** For tests: inject a pre-opened ingest DB. */
export function setIngestDb(db: Database.Database): void {
  _db = db;
}

export class SourceIngester {
  private watchers = new Map<string, fs.FSWatcher>();
  private store: MemoryStore | null = null;
  private health: HealthRecorder | null = null;

  /**
   * Inject the production runtime dependencies. Required before the inotify
   * watcher fires can extract facts — without these, the watcher's
   * processInboxFile call hits the legacy Database-only branch (test seam)
   * and silently no-ops.
   */
  setRuntime(store: MemoryStore, health: HealthRecorder): void {
    this.store = store;
    this.health = health;
  }

  reconcileWatchers(groups: ReadonlyArray<{ agentGroupId: string; folder: string; enabled: boolean }>): {
    opened: number;
    closed: number;
  } {
    let opened = 0;
    let closed = 0;

    const enabledIds = new Set(groups.filter((g) => g.enabled).map((g) => g.agentGroupId));

    for (const [agentGroupId, watcher] of this.watchers) {
      if (!enabledIds.has(agentGroupId)) {
        watcher.close();
        this.watchers.delete(agentGroupId);
        closed++;
      }
    }

    for (const group of groups) {
      if (!group.enabled) continue;
      if (this.watchers.has(group.agentGroupId)) continue;

      const inboxPath = path.join(GROUPS_DIR, group.folder, 'sources', 'inbox');
      try {
        fs.mkdirSync(inboxPath, { recursive: true });
      } catch {
        // best-effort
      }

      const watcher = fs.watch(inboxPath, { persistent: false });
      // Only fire on CLOSE_WRITE (write + close) and MOVED_TO events.
      // Node's fs.watch on Linux uses inotify; 'rename' event maps to IN_MOVED_TO.
      // 'change' event maps to IN_CLOSE_WRITE. We protect against partial writes
      // by checking file existence before processing (atomic-write race protection).
      watcher.on('change', (eventType: string, filename: string | Buffer | null) => {
        if (eventType !== 'rename' && eventType !== 'change') return;
        if (!filename) return;
        const filePath = path.join(inboxPath, filename.toString());
        // Reject symlinks and any path that escapes the inbox root (cross-tenant
        // attack: container could plant a symlink to another group's file or
        // any host-readable path).
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(filePath);
        } catch {
          return;
        }
        if (stat.isSymbolicLink() || !stat.isFile()) return;
        let realPath: string;
        let inboxRealPath: string;
        try {
          realPath = fs.realpathSync(filePath);
          inboxRealPath = fs.realpathSync(inboxPath);
        } catch {
          return;
        }
        if (!realPath.startsWith(inboxRealPath + path.sep)) return;
        // Defer to allow the write to fully flush.
        setImmediate(() => {
          // The watcher fast-path needs the production MemoryStore + HealthRecorder
          // (not the Database-only test seam). If setRuntime wasn't called, fall
          // back silently — the 60s sweep in index.ts catches the file and
          // processes it via the runtime path.
          if (!this.store) return;
          void this.processInboxFile(group.agentGroupId, group.folder, realPath, this.store, this.health ?? undefined);
        });
      });

      this.watchers.set(group.agentGroupId, watcher);
      opened++;
    }

    return { opened, closed };
  }

  async processInboxFile(
    agentGroupId: string,
    folder: string,
    filePath: string,
    store: MemoryStore | Database.Database,
    health?: HealthRecorder,
  ): Promise<{ factsWritten: number; failed: boolean }>;

  async processInboxFile(
    agentGroupId: string,
    folder: string,
    filePath: string,
    storeOrDb: MemoryStore | Database.Database,
    health?: HealthRecorder,
  ): Promise<{ factsWritten: number; failed: boolean }> {
    // Re-validate symlink/path-traversal protection at read time, then read
    // through a file descriptor opened with O_NOFOLLOW to close the TOCTOU
    // window. The watcher ran lstat+realpath before queuing, but setImmediate
    // creates a window where a container with write access to its inbox could
    // swap the regular file for a symlink. Reading by path after re-validation
    // (Codex finding #5 round 1) still has a residual race; openSync with
    // O_NOFOLLOW + fstat eliminates it (Codex finding #2 round 2).
    const inboxPath = path.join(GROUPS_DIR, folder, 'sources', 'inbox');
    let content: string;
    try {
      // Resolve the inbox root for the prefix check below. openSync with
      // O_NOFOLLOW will refuse to open the file if the final path component
      // is a symlink — but earlier components could still be symlinks, so
      // realpath the inbox to compare against the fd's resolved path.
      const inboxRealPath = fs.realpathSync(inboxPath);

      // O_NOFOLLOW = 0o400000 on Linux. Importing fs/promises constants is
      // cleaner but constants.O_NOFOLLOW is fs.constants.O_NOFOLLOW.
      const O_NOFOLLOW = fs.constants.O_NOFOLLOW;
      const O_RDONLY = fs.constants.O_RDONLY;
      const fd = fs.openSync(filePath, O_RDONLY | O_NOFOLLOW);
      try {
        const fstat = fs.fstatSync(fd);
        if (!fstat.isFile()) {
          return { factsWritten: 0, failed: false };
        }
        // Resolve the fd back to a real path on disk and verify it's still
        // under the inbox. Linux exposes /proc/self/fd/<fd> as a symlink
        // pointing at the actual file.
        const fdRealPath = fs.readlinkSync(`/proc/self/fd/${fd}`);
        if (!fdRealPath.startsWith(inboxRealPath + path.sep)) {
          return { factsWritten: 0, failed: false };
        }
        // Use filePath = fdRealPath downstream so processed_pairs / processed/
        // moves use the canonical path.
        filePath = fdRealPath;

        const buf = Buffer.alloc(fstat.size);
        let bytesRead = 0;
        while (bytesRead < fstat.size) {
          const r = fs.readSync(fd, buf, bytesRead, fstat.size - bytesRead, null);
          if (r === 0) break;
          bytesRead += r;
        }
        content = buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { factsWritten: 0, failed: true };
    }

    const canonical = canonicalize(content);
    const contentHash = sha256(canonical);

    const db = getIngestDb();

    const existing = db
      .prepare(
        `SELECT 1 FROM processed_sources
         WHERE agent_group_id = ? AND content_sha256 = ? AND extractor_version = ? AND prompt_version = ?`,
      )
      .get(agentGroupId, contentHash, EXTRACTOR_VERSION, PROMPT_VERSION);

    if (existing) {
      // Clear any orphan dead_letters row keyed on this resolved path. A
      // prior failed attempt could have created a dead_letter that lasted
      // beyond the eventual content-hash success (different agent/path race
      // with same content). Once we move the file to processed/, the retry
      // loop's fs.existsSync check will short-circuit and the row would
      // otherwise zombie forever. Scoped by agent_group_id + item_key.
      db.prepare(`DELETE FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`).run(filePath, agentGroupId);

      const processedDir = path.join(GROUPS_DIR, folder, 'sources', 'processed', dateFolder());
      fs.mkdirSync(processedDir, { recursive: true });
      const dest = path.join(processedDir, path.basename(filePath));
      try {
        fs.renameSync(filePath, dest);
      } catch {
        // best-effort move
      }
      return { factsWritten: 0, failed: false };
    }

    // storeOrDb can be a MemoryStore (production path) or Database (legacy test injection via setIngestDb).
    // In production, storeOrDb is always a MemoryStore.
    if (storeOrDb instanceof Database) {
      return { factsWritten: 0, failed: false };
    }
    const store = storeOrDb as MemoryStore;

    let output;
    try {
      output = await callClassifier(EXTRACTOR_SYSTEM_PROMPT, canonical);
    } catch (err) {
      if (health) {
        health.recordClassifierFailure(agentGroupId, err instanceof Error ? err : new Error(String(err)));
      }
      recordOrIncrementFailure({
        itemType: 'source-file',
        itemKey: filePath,
        agentGroupId,
        error: String(err),
      });
      return { factsWritten: 0, failed: true };
    }

    if (!output.worth_storing || output.facts.length === 0) {
      db.transaction(() => {
        db.prepare(
          `INSERT OR IGNORE INTO processed_sources
             (agent_group_id, content_sha256, extractor_version, prompt_version, source_path, ingested_at, facts_written)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(agentGroupId, contentHash, EXTRACTOR_VERSION, PROMPT_VERSION, filePath, new Date().toISOString(), 0);
        db.prepare(`DELETE FROM dead_letters WHERE item_key = ?`).run(filePath);
      })();

      const processedDir = path.join(GROUPS_DIR, folder, 'sources', 'processed', dateFolder());
      fs.mkdirSync(processedDir, { recursive: true });
      const dest = path.join(processedDir, path.basename(filePath));
      try {
        fs.renameSync(filePath, dest);
      } catch {
        // best-effort
      }
      return { factsWritten: 0, failed: false };
    }

    let factsWritten = 0;
    let anyFailed = false;

    for (let factIndex = 0; factIndex < output.facts.length; factIndex++) {
      const rawFact = output.facts[factIndex];
      const factInput: FactInput = {
        content: rawFact.content,
        category: rawFact.category,
        importance: rawFact.importance,
        entities: rawFact.entities,
        provenance: {
          sourceType: 'tool',
          sourceId: filePath,
          sourceRole: 'external',
        },
      };

      const redactionResult = redactSecrets(factInput);
      if (!redactionResult.shouldStore) {
        if (health) {
          health.recordRedaction(agentGroupId, redactionResult.reason ?? 'unknown');
        }
        continue;
      }

      const idempotencyKey = sha256(`${filePath}|${contentHash}|${factIndex}|${EXTRACTOR_VERSION}|${PROMPT_VERSION}`);
      try {
        const result = await store.remember(agentGroupId, factInput, { idempotencyKey });
        // Mirror the classifier fix (Codex post-fix #1): MnemonStore.remember
        // returns { action: 'skipped', factId: '' } on CLI failure, empty
        // stdout, or parse failure. Counting these as success would silently
        // drop facts and mark the source as processed — permanent data loss
        // without a dead-letter retry. Only count actually-stored facts.
        if (result.action === 'added' || result.action === 'updated' || result.action === 'replaced') {
          factsWritten++;
        } else if (result.action === 'skipped' && !result.factId) {
          // Operational failure masquerading as 'skipped'. The redactor-blocked
          // path is already handled above; any 'skipped' reaching here is a
          // mnemon write failure and should route the source file to dead_letters.
          anyFailed = true;
          if (health) {
            health.recordClassifierFailure(
              agentGroupId,
              new Error(`store.remember returned skipped without factId for source-file fact ${factIndex}`),
            );
          }
          break;
        }
        // result.action === 'skipped' with non-empty factId is a duplicate
        // dedup hit — count as silently-stored (idempotent retry).
      } catch (err) {
        anyFailed = true;
        if (health) {
          health.recordClassifierFailure(agentGroupId, err instanceof Error ? err : new Error(String(err)));
        }
        break;
      }
    }

    if (anyFailed) {
      recordOrIncrementFailure({
        itemType: 'source-file',
        itemKey: filePath,
        agentGroupId,
        error: 'fact write failed',
      });
      return { factsWritten: 0, failed: true };
    }

    db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO processed_sources
           (agent_group_id, content_sha256, extractor_version, prompt_version, source_path, ingested_at, facts_written)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        agentGroupId,
        contentHash,
        EXTRACTOR_VERSION,
        PROMPT_VERSION,
        filePath,
        new Date().toISOString(),
        factsWritten,
      );
      db.prepare(`DELETE FROM dead_letters WHERE item_key = ?`).run(filePath);
    })();

    if (health) {
      health.recordSourceIngest(agentGroupId, factsWritten, contentHash);
    }

    const processedDir = path.join(GROUPS_DIR, folder, 'sources', 'processed', dateFolder());
    fs.mkdirSync(processedDir, { recursive: true });
    const dest = path.join(processedDir, path.basename(filePath));
    try {
      fs.renameSync(filePath, dest);
    } catch {
      // best-effort
    }

    return { factsWritten, failed: false };
  }

  async shutdown(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}
