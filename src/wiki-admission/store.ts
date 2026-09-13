import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type CandidateState =
  | 'pending'
  | 'verifying'
  | 'accepted'
  | 'publishing'
  | 'published'
  | 'rejected'
  | 'stale'
  | 'uncertain';
export interface Candidate {
  id: string;
  writerSession: string;
  requestId: string;
  policyDigest: string;
  origin: string;
  base: string;
  head: string;
  tree: string;
  diffDigest: string;
  state: CandidateState;
  verifierSession: string | null;
  inputDigest: string | null;
  input: string | null;
  receipt: string | null;
  createdAt: string;
  attempts: number;
}

/** All files under root are host-only; no candidate path is accepted from an agent. */
export class CandidateStore {
  readonly db: Database.Database;
  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink())
      throw new Error('Unsafe candidate root');
    const file = path.join(root, 'state.db');
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Unsafe candidate database');
    this.db = new Database(file);
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY, writerSession TEXT NOT NULL, requestId TEXT NOT NULL, policyDigest TEXT NOT NULL,
      origin TEXT NOT NULL, base TEXT NOT NULL, head TEXT NOT NULL, tree TEXT NOT NULL, diffDigest TEXT NOT NULL,
      state TEXT NOT NULL, verifierSession TEXT, inputDigest TEXT, input TEXT, receipt TEXT,
      createdAt TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, UNIQUE(writerSession,requestId)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS recovery_cursor (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_row INTEGER NOT NULL
    ); INSERT OR IGNORE INTO recovery_cursor VALUES (1,0)`);
  }
  close(): void {
    this.db.close();
  }
  get(id: string): Candidate | undefined {
    return this.db.prepare('SELECT * FROM candidates WHERE id=?').get(id) as Candidate | undefined;
  }
  request(session: string, requestId: string): Candidate | undefined {
    return this.db.prepare('SELECT * FROM candidates WHERE writerSession=? AND requestId=?').get(session, requestId) as
      | Candidate
      | undefined;
  }
  insert(candidate: Candidate): void {
    this.db
      .prepare(
        `INSERT INTO candidates VALUES (@id,@writerSession,@requestId,@policyDigest,@origin,@base,@head,
      @tree,@diffDigest,@state,@verifierSession,@inputDigest,@input,@receipt,@createdAt,@attempts)`,
      )
      .run(candidate);
  }
  seal(
    id: string,
    values: Pick<Candidate, 'head' | 'tree' | 'diffDigest' | 'input' | 'inputDigest' | 'verifierSession'>,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE candidates SET head=@head,tree=@tree,diffDigest=@diffDigest,
      input=@input,inputDigest=@inputDigest,verifierSession=@verifierSession,state='verifying'
      WHERE id=@id AND state='pending'`,
        )
        .run({ id, ...values }).changes === 1
    );
  }
  transition(id: string, from: CandidateState[], to: CandidateState, changes: Partial<Candidate> = {}): boolean {
    const allowed = new Set(['verifierSession', 'inputDigest', 'input', 'receipt', 'attempts']);
    if (Object.keys(changes).some((key) => !allowed.has(key))) throw new Error('Immutable candidate identity');
    const keys = Object.keys(changes);
    const result = this.db
      .prepare(
        `UPDATE candidates SET state=?${keys.map((k) => `,${k}=?`).join('')}
      WHERE id=? AND state IN (${from.map(() => '?').join(',')})`,
      )
      .run(to, ...Object.values(changes), id, ...from);
    return result.changes === 1;
  }
  recoverable(): Candidate[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT rowid AS recoveryRow, * FROM candidates
        WHERE state IN ('pending','verifying','accepted','publishing','uncertain')
        ORDER BY CASE WHEN rowid > (SELECT last_row FROM recovery_cursor WHERE singleton=1)
          THEN 0 ELSE 1 END, rowid LIMIT 16`,
        )
        .all() as (Candidate & { recoveryRow: number })[];
      // Advance before IO so a crash or invalid candidate cannot monopolize the next batch.
      if (rows.length)
        this.db
          .prepare('UPDATE recovery_cursor SET last_row=? WHERE singleton=1')
          .run(rows[rows.length - 1].recoveryRow);
      return rows.map(({ recoveryRow: _row, ...candidate }) => candidate);
    })();
  }
}
