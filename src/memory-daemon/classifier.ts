import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import path from 'path';
import { DATA_DIR } from '../config.js';
import { openMnemonIngestDb } from '../db/migrations/019-mnemon-ingest-db.js';
import type { MemoryStore, FactInput } from '../modules/memory/store.js';
import { redactSecrets } from '../modules/memory/secret-redactor.js';
import { callClassifier, CLASSIFIER_VERSION, PROMPT_VERSION } from './classifier-client.js';
import { validateFactsAgainstSource } from './classifier-validator.js';
import { recordOrIncrementFailure, getDueRetries } from './dead-letters.js';
import type { HealthRecorder } from './health.js';

export interface SweepResult {
  groupsProcessed: number;
  pairsClassified: number;
  factsWritten: number;
  failures: number;
  poisoned: number;
}

// Minimum importance required for a classifier-emitted fact to be persisted.
// Facts below this score are dropped silently. Tuned 2026-05-04 from default-
// off (every fact stored) to 4 after an audit showed ~50% of stored facts
// were importance=3 noise. The classifier's 1-5 scale: 5=critical, 4=durable
// signal, 3=tactical context, 1-2=trivial. Bumping to 4 keeps decisions/key
// facts/insights, drops the context bag.
export const MIN_FACT_IMPORTANCE = 4;

const CLASSIFIER_SYSTEM_PROMPT = `You are a memory extraction assistant. Your job is to read a conversation turn (a user message and an optional assistant response) and extract atomic, reusable facts worth storing in a long-term memory system.

Output ONLY valid JSON matching this exact schema:
{
  "worth_storing": boolean,
  "facts": [
    {
      "content": string,
      "category": "preference" | "decision" | "insight" | "fact" | "context",
      "importance": number (1-5),
      "entities": string[],
      "source_role": "user" | "assistant" | "joint" | "external"
    }
  ]
}

Rules:
- Set worth_storing to false and return an empty facts array if the conversation is trivial, purely transactional, or contains no durable information.
- Extract atomic facts — one clear, self-contained statement per fact.
- Preferred categories: preference, decision, insight, fact, context.
- Importance: 5 = critical/high-signal, 1 = low-signal background detail.
- NEVER extract secrets, credentials, API keys, tokens, passwords, or transient state (e.g. error messages with stack traces, temporary values).
- Return empty facts array for chitchat, greetings, or short filler messages.

GROUNDING DISCIPLINE (critical — confabulation hazard):
- Do NOT introduce names, acronyms, aliases, expansions, dates, owners, statuses, or causal claims that are not LITERALLY present in the source text.
- Acronyms are especially dangerous: if the source says "WG", write "WG". Do NOT expand it to "(William Grant)" or any other parenthetical unless that exact parenthetical appears verbatim in the source.
- Do NOT add definitions, descriptions, or context that "would help" the reader unless that information is in the source.
- The fact's "content" field may compress phrasing or fix grammar, but it must not introduce a single word's worth of meaning that isn't in the source.
- Every entity in "entities[]" must be a string the source explicitly used.
- If a fact cannot be stated using only information present in the source, do not emit it.`;

interface ArchiveRow {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sent_at: string;
  channel_type: string;
}

interface Run {
  role: 'user' | 'assistant';
  messages: ArchiveRow[];
}

interface TurnPair {
  userRun: ArchiveRow[];
  assistantRun: ArchiveRow[] | null;
  isOrphan: boolean;
  pairKey: string;
}

let _db: Database.Database | null = null;
let _archiveDb: Database.Database | null = null;

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

/** For tests: inject a pre-opened archive DB instead of opening 'data/archive.db'. */
export function setArchiveDbForTest(db: Database.Database): void {
  _archiveDb = db;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function groupIntoRuns(rows: ArchiveRow[]): Run[] {
  const runs: Run[] = [];
  for (const row of rows) {
    const last = runs[runs.length - 1];
    if (last && last.role === row.role) {
      last.messages.push(row);
    } else {
      runs.push({ role: row.role as 'user' | 'assistant', messages: [row] });
    }
  }
  return runs;
}

function buildTurnPairs(runs: Run[], nowMs: number): TurnPair[] {
  const pairs: TurnPair[] = [];
  let i = 0;
  while (i < runs.length) {
    const userRun = runs[i];
    if (userRun.role !== 'user') {
      i++;
      continue;
    }

    const nextRun = runs[i + 1];
    if (nextRun && nextRun.role === 'assistant') {
      const lastAssistantMsg = nextRun.messages[nextRun.messages.length - 1];
      const lastAssistantMs = new Date(lastAssistantMsg.sent_at).getTime();
      const ageSec = (nowMs - lastAssistantMs) / 1000;

      if (ageSec >= 120) {
        pairs.push({
          userRun: userRun.messages,
          assistantRun: nextRun.messages,
          isOrphan: false,
          pairKey: userRun.messages[0].id,
        });
      }
      i += 2;
    } else {
      const lastUserMsg = userRun.messages[userRun.messages.length - 1];
      const lastUserMs = new Date(lastUserMsg.sent_at).getTime();
      const ageSec = (nowMs - lastUserMs) / 1000;

      if (ageSec >= 600) {
        pairs.push({
          userRun: userRun.messages,
          assistantRun: null,
          isOrphan: true,
          pairKey: userRun.messages[0].id,
        });
      }
      i++;
    }
  }
  return pairs;
}

function isPairAlreadyProcessed(
  db: Database.Database,
  agentGroupId: string,
  pairKey: string,
  isOrphan: boolean,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM processed_pairs
       WHERE agent_group_id = ? AND user_run_first_id = ?
         AND classifier_version = ? AND prompt_version = ? AND is_orphan = ?`,
    )
    .get(agentGroupId, pairKey, CLASSIFIER_VERSION, PROMPT_VERSION, isOrphan ? 1 : 0);
  return row != null;
}

function getWatermarks(
  db: Database.Database,
  agentGroupId: string,
): { scanCursor: string | null; successWatermark: string | null } {
  const row = db
    .prepare(`SELECT scan_cursor, last_classified_sent_at FROM watermarks WHERE agent_group_id = ?`)
    .get(agentGroupId) as { scan_cursor: string | null; last_classified_sent_at: string | null } | undefined;
  return {
    scanCursor: row?.scan_cursor ?? null,
    successWatermark: row?.last_classified_sent_at ?? null,
  };
}

function upsertWatermarks(
  db: Database.Database,
  agentGroupId: string,
  scanCursor: string,
  successWatermark: string | null,
): void {
  const existing = db
    .prepare(`SELECT scan_cursor, last_classified_sent_at FROM watermarks WHERE agent_group_id = ?`)
    .get(agentGroupId) as { scan_cursor: string; last_classified_sent_at: string | null } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO watermarks (agent_group_id, scan_cursor, last_classified_sent_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(agentGroupId, scanCursor, successWatermark, new Date().toISOString());
  } else {
    const newSuccess = successWatermark ?? existing.last_classified_sent_at;
    db.prepare(
      `UPDATE watermarks SET scan_cursor = ?, last_classified_sent_at = ?, updated_at = ?
       WHERE agent_group_id = ?`,
    ).run(scanCursor, newSuccess, new Date().toISOString(), agentGroupId);
  }
}

function buildPairText(pair: TurnPair): string {
  const userText = pair.userRun.map((m) => m.text).join('\n');
  const assistantText = pair.assistantRun ? pair.assistantRun.map((m) => m.text).join('\n') : '';
  return assistantText ? `[User]\n${userText}\n\n[Assistant]\n${assistantText}` : `[User]\n${userText}`;
}

async function classifyPair(
  db: Database.Database,
  agentGroupId: string,
  pair: TurnPair,
  store: MemoryStore,
  health: HealthRecorder,
): Promise<{ factsWritten: number; poisoned: boolean; failed: boolean }> {
  const pairText = buildPairText(pair);

  if (pairText.length < 20 || pairText.split(/\s+/).filter(Boolean).length <= 3) {
    const lastSentAt = pair.assistantRun
      ? pair.assistantRun[pair.assistantRun.length - 1].sent_at
      : pair.userRun[pair.userRun.length - 1].sent_at;
    upsertWatermarks(db, agentGroupId, lastSentAt, null);
    return { factsWritten: 0, poisoned: false, failed: false };
  }

  let output;
  try {
    output = await callClassifier(CLASSIFIER_SYSTEM_PROMPT, pairText);
  } catch (err) {
    health.recordClassifierFailure(agentGroupId, err instanceof Error ? err : new Error(String(err)));
    const result = recordOrIncrementFailure({
      itemType: 'turn-pair',
      itemKey: pair.pairKey,
      agentGroupId,
      error: String(err),
    });

    const lastSentAt = pair.assistantRun
      ? pair.assistantRun[pair.assistantRun.length - 1].sent_at
      : pair.userRun[pair.userRun.length - 1].sent_at;

    if (result.poisoned) {
      upsertWatermarks(db, agentGroupId, lastSentAt, null);
      return { factsWritten: 0, poisoned: true, failed: false };
    }
    return { factsWritten: 0, poisoned: false, failed: true };
  }

  // worth_storing=false: model decided nothing valuable — skip cleanly.
  if (!output.worth_storing) {
    const lastSentAt = pair.assistantRun
      ? pair.assistantRun[pair.assistantRun.length - 1].sent_at
      : pair.userRun[pair.userRun.length - 1].sent_at;
    upsertWatermarks(db, agentGroupId, lastSentAt, lastSentAt);
    return { factsWritten: 0, poisoned: false, failed: false };
  }
  // Confabulation defense: drop facts whose content contains a parenthetical
  // alias that the classifier invented (not present in the source chat-pair).
  // This is the surgical fix for the WG → "(Whisky Gauge)" / SF → "(Salesforce)"
  // pattern. Provider-agnostic — runs against whichever backend produced the
  // output. See classifier-validator.ts for the full rationale.
  const validation = validateFactsAgainstSource(output, pairText);
  if (validation.rejected.length > 0) {
    for (const r of validation.rejected) {
      console.warn('[classifier] dropped confabulated fact', {
        agentGroupId,
        pairKey: pair.pairKey,
        reason: r.reason,
        content: r.fact.content.slice(0, 200),
      });
    }
    output = { ...output, facts: validation.accepted };
  }

  // Model contradiction: worth_storing=true but no facts. Don't mark as
  // success-classified; route to dead_letters for one retry, then poison.
  // A clean skip would silently swallow a possible model glitch. Note: this
  // also fires when ALL facts were dropped by confabulation defense above —
  // a fully-poisoned extraction is treated the same as a model glitch.
  if (output.facts.length === 0) {
    console.warn('[classifier] model returned worth_storing=true with empty facts array', {
      agentGroupId,
      pairKey: pair.pairKey,
    });
    const failureResult = recordOrIncrementFailure({
      itemType: 'turn-pair',
      itemKey: pair.pairKey,
      agentGroupId,
      error: 'model returned worth_storing=true with empty facts',
    });
    if (failureResult.poisoned) {
      const lastSentAt = pair.assistantRun
        ? pair.assistantRun[pair.assistantRun.length - 1].sent_at
        : pair.userRun[pair.userRun.length - 1].sent_at;
      upsertWatermarks(db, agentGroupId, lastSentAt, null);
      return { factsWritten: 0, poisoned: true, failed: true };
    }
    return { factsWritten: 0, poisoned: false, failed: true };
  }

  let factsWritten = 0;
  let anyFactFailed = false;
  // Gate accounting (Codex Finding F1, 2026-05-04). The pair-level success
  // path advances scan_cursor and inserts processed_pairs even when factsWritten
  // is 0, which is correct for "classifier returned no facts" but historically
  // meant "every fact was dropped for low importance" was indistinguishable
  // from "classifier had nothing to say". Counting drops here gives operators
  // a denominator to spot the difference; pairs where 100% of emitted facts
  // were dropped for low importance get an extra sentinel counter so we can
  // see when threshold tuning would matter.
  let factsEmittedNonRedacted = 0;
  let factsDroppedForImportance = 0;

  for (let factIndex = 0; factIndex < output.facts.length; factIndex++) {
    const rawFact = output.facts[factIndex];
    const factInput: FactInput = {
      content: rawFact.content,
      category: rawFact.category,
      importance: rawFact.importance,
      entities: rawFact.entities,
      provenance: {
        sourceType: 'chat',
        sourceId: pair.pairKey,
        sourceRole: rawFact.source_role,
      },
    };

    // Redaction runs BEFORE the importance gate so secret-shaped content is
    // always counted in health.recordRedaction, even when the fact would have
    // been dropped for being low-signal. Audit signal > store-write savings.
    const redactionResult = redactSecrets(factInput);
    if (!redactionResult.shouldStore) {
      health.recordRedaction(agentGroupId, redactionResult.reason ?? 'unknown');
      continue;
    }

    factsEmittedNonRedacted++;

    // Importance gate — drop low-signal facts before they pollute the store.
    // Empirically (illysium store, 2026-05-04 sample of 50 recall results) ~50%
    // of stored facts came in at importance=3 — useful tactical context but not
    // durable enough to keep forever. importance=4-5 is decisions, key facts,
    // and high-signal insights. The classifier emits 1-5 per its prompt.
    //
    // Note: pair still gets inserted into processed_pairs and watermark advances
    // even if EVERY fact gets dropped here. That's a deliberate trade-off — the
    // alternative (re-classify every sweep) would burn the classifier API on
    // already-decided pairs. To replay dropped pairs, bump PROMPT_VERSION or
    // CLASSIFIER_VERSION in classifier-client.ts; the (group, pair_key, classifier_version,
    // prompt_version, is_orphan) PK on processed_pairs means new-version rows
    // coexist with old.
    if (rawFact.importance < MIN_FACT_IMPORTANCE) {
      factsDroppedForImportance++;
      health.recordLowImportanceDropped(agentGroupId);
      continue;
    }

    const idempotencyKey = sha256(`${pair.pairKey}|${factIndex}|${CLASSIFIER_VERSION}|${PROMPT_VERSION}`);
    try {
      const result = await store.remember(agentGroupId, factInput, { idempotencyKey });
      // MnemonStore.remember returns { action: 'skipped' } on CLI exit non-zero,
      // empty stdout, or parse failure (mnemon-impl.ts:199, 207). Treating these
      // as success would silently lose facts and clear the dead-letter row,
      // marking durable data loss as permanent. Only count actually-stored facts.
      if (result.action === 'added' || result.action === 'updated' || result.action === 'replaced') {
        factsWritten++;
        health.recordFactAccepted(agentGroupId);
      } else if (result.action === 'skipped' && !result.factId) {
        // Operational failure (CLI/parse error) masquerading as 'skipped'.
        // The redactor-blocked path returns 'skipped' too but with an explicit
        // factId-empty contract — disambiguating by factId alone isn't perfect,
        // but the classifier already ran redactSecrets above, so any 'skipped'
        // reaching here is operational. Route to dead_letters.
        anyFactFailed = true;
        health.recordClassifierFailure(
          agentGroupId,
          new Error(`store.remember returned skipped without factId for fact ${factIndex}`),
        );
        break;
      }
      // result.action === 'skipped' with non-empty factId would be a duplicate
      // dedup hit — count as silently-stored (idempotent retry).
    } catch (err) {
      anyFactFailed = true;
      health.recordClassifierFailure(agentGroupId, err instanceof Error ? err : new Error(String(err)));
      break;
    }
  }

  // All-low-importance sentinel: every non-redacted fact in this pair was
  // dropped for low importance (no facts written, no failures). Without this
  // signal, the operator can't distinguish "classifier said nothing useful"
  // from "every emitted fact was below threshold". Emit a metric + warn log
  // so operators can spot the rate and decide whether to lower MIN_FACT_IMPORTANCE
  // or bump PROMPT_VERSION/CLASSIFIER_VERSION to replay.
  if (
    !anyFactFailed &&
    factsEmittedNonRedacted > 0 &&
    factsDroppedForImportance === factsEmittedNonRedacted &&
    factsWritten === 0
  ) {
    health.recordPairAllLowImportance(agentGroupId);
    console.warn('[classifier] pair processed with 0 facts — all dropped for low importance', {
      agentGroupId,
      pairKey: pair.pairKey,
      factsEmittedNonRedacted,
      factsDroppedForImportance,
    });
  }

  if (anyFactFailed) {
    const result = recordOrIncrementFailure({
      itemType: 'turn-pair',
      itemKey: pair.pairKey,
      agentGroupId,
      error: 'fact write failed',
    });

    const lastSentAt = pair.assistantRun
      ? pair.assistantRun[pair.assistantRun.length - 1].sent_at
      : pair.userRun[pair.userRun.length - 1].sent_at;

    if (result.poisoned) {
      upsertWatermarks(db, agentGroupId, lastSentAt, null);
      return { factsWritten: 0, poisoned: true, failed: false };
    }
    return { factsWritten: 0, poisoned: false, failed: true };
  }

  const lastSentAt = pair.assistantRun
    ? pair.assistantRun[pair.assistantRun.length - 1].sent_at
    : pair.userRun[pair.userRun.length - 1].sent_at;

  const userRunLastId = pair.userRun[pair.userRun.length - 1].id;
  const assistantRunFirstId = pair.assistantRun ? pair.assistantRun[0].id : null;
  const assistantRunLastId = pair.assistantRun ? pair.assistantRun[pair.assistantRun.length - 1].id : null;

  // Wrap processed_pairs INSERT, dead_letters cleanup, and watermark advance
  // in a single transaction. Without this, a crash between the INSERT and
  // deleteAfterSuccess leaves an orphan dead_letters row that getDueRetries
  // keeps returning forever (correctly short-circuited by isPairAlreadyProcessed
  // on subsequent sweeps but accumulating noise in the queue).
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO processed_pairs
         (agent_group_id, user_run_first_id, classifier_version, prompt_version, is_orphan,
          user_run_last_id, assistant_run_first_id, assistant_run_last_id, classified_at, facts_written)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentGroupId,
      pair.pairKey,
      CLASSIFIER_VERSION,
      PROMPT_VERSION,
      pair.isOrphan ? 1 : 0,
      userRunLastId,
      assistantRunFirstId,
      assistantRunLastId,
      new Date().toISOString(),
      factsWritten,
    );
    db.prepare(`DELETE FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`).run(pair.pairKey, agentGroupId);
    upsertWatermarks(db, agentGroupId, lastSentAt, lastSentAt);
  })();
  health.recordTurnClassified(agentGroupId, factsWritten, 0);

  return { factsWritten, poisoned: false, failed: false };
}

async function processGroup(
  archiveDb: Database.Database,
  ingestDb: Database.Database,
  agentGroupId: string,
  store: MemoryStore,
  health: HealthRecorder,
): Promise<{ pairsClassified: number; factsWritten: number; failures: number; poisoned: number }> {
  const { scanCursor } = getWatermarks(ingestDb, agentGroupId);
  const nowMs = Date.now();

  const queryArgs: (string | null)[] = [agentGroupId];
  let sql = `
    SELECT id, role, text, sent_at, channel_type
    FROM messages_archive
    WHERE agent_group_id = ?
      AND channel_type != 'agent'
      AND role IN ('user', 'assistant')
  `;

  if (scanCursor) {
    sql += ` AND sent_at > ?`;
    queryArgs.push(scanCursor);
  }

  sql += ` ORDER BY sent_at ASC`;

  const rows = archiveDb.prepare(sql).all(...queryArgs) as ArchiveRow[];

  const runs = groupIntoRuns(rows);
  const pairs = buildTurnPairs(runs, nowMs);

  let pairsClassified = 0;
  let factsWritten = 0;
  let failures = 0;
  let poisonedCount = 0;

  // Hoist getDueRetries out of the per-pair loop. Inside the loop it ran O(N×M)
  // (N pairs × M dead_letter rows), which is quadratic under retry pressure.
  // Compute once per group sweep and look up via Set for O(1) per pair.
  const dueRetryItemKeys = new Set(getDueRetries(agentGroupId, new Date()).map((r) => r.itemKey));

  // Track sent_ats of pairs with UNRESOLVED dead_letters (non-poisoned and
  // either not yet due, OR newly failed in this sweep). Used at end of loop to
  // clamp scan_cursor — without this, scan_cursor advances past failed pairs
  // and the `sent_at > scan_cursor` filter on subsequent sweeps means the
  // dead_letter retry never refetches the pair, even when its next_retry_at
  // elapses. Codex finding #3 in post-fix QA.
  const unresolvedSentAts: string[] = [];

  for (const pair of pairs) {
    if (isPairAlreadyProcessed(ingestDb, agentGroupId, pair.pairKey, pair.isOrphan)) {
      const lastSentAt = pair.assistantRun
        ? pair.assistantRun[pair.assistantRun.length - 1].sent_at
        : pair.userRun[pair.userRun.length - 1].sent_at;
      upsertWatermarks(ingestDb, agentGroupId, lastSentAt, null);
      continue;
    }

    const hasDueRetry = dueRetryItemKeys.has(pair.pairKey);
    const existingRows = ingestDb
      .prepare(`SELECT * FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`)
      .all(pair.pairKey, agentGroupId) as Array<{ poisoned_at: string | null; next_retry_at: string | null }>;

    if (existingRows.length > 0) {
      const existing = existingRows[0];
      if (existing.poisoned_at) {
        const lastSentAt = pair.assistantRun
          ? pair.assistantRun[pair.assistantRun.length - 1].sent_at
          : pair.userRun[pair.userRun.length - 1].sent_at;
        upsertWatermarks(ingestDb, agentGroupId, lastSentAt, null);
        poisonedCount++;
        continue;
      }
      if (!hasDueRetry) {
        // Unresolved dead_letter, retry not yet due — track to prevent
        // scan_cursor from advancing past this pair (which would prevent
        // subsequent sweeps from refetching it once retry becomes due).
        unresolvedSentAts.push(pair.userRun[0].sent_at);
        continue;
      }
    }

    const result = await classifyPair(ingestDb, agentGroupId, pair, store, health);
    if (result.poisoned) {
      poisonedCount++;
    } else if (result.failed) {
      failures++;
      unresolvedSentAts.push(pair.userRun[0].sent_at);
    } else {
      pairsClassified++;
      factsWritten += result.factsWritten;
    }
  }

  // Clamp scan_cursor: it must not advance past the earliest unresolved failure
  // in this sweep. Use the prior-millisecond as the cap so the failed pair gets
  // refetched on the next sweep (sent_at > clamped is true for it).
  if (unresolvedSentAts.length > 0) {
    const earliest = unresolvedSentAts.reduce((a, b) => (a < b ? a : b));
    const current = getWatermarks(ingestDb, agentGroupId).scanCursor;
    if (!current || current >= earliest) {
      const cap = priorMillisecondIso(earliest);
      // scanCursor=cap, successWatermark=null preserves the existing success watermark.
      upsertWatermarks(ingestDb, agentGroupId, cap, null);
    }
  }

  return { pairsClassified, factsWritten, failures, poisoned: poisonedCount };
}

function priorMillisecondIso(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return iso;
  return new Date(t - 1).toISOString();
}

export async function runChatStreamSweep(
  groups: ReadonlyArray<{ agentGroupId: string; folder: string }>,
  store: MemoryStore,
  health: HealthRecorder,
): Promise<SweepResult> {
  const ownArchiveDb = !_archiveDb;
  const archiveDb = _archiveDb ?? new Database(path.join(DATA_DIR, 'archive.db'), { readonly: true });
  const ingestDb = getIngestDb();

  let groupsProcessed = 0;
  let totalPairsClassified = 0;
  let totalFactsWritten = 0;
  let totalFailures = 0;
  let totalPoisoned = 0;

  try {
    for (const group of groups) {
      const result = await processGroup(archiveDb, ingestDb, group.agentGroupId, store, health);
      groupsProcessed++;
      totalPairsClassified += result.pairsClassified;
      totalFactsWritten += result.factsWritten;
      totalFailures += result.failures;
      totalPoisoned += result.poisoned;
    }
  } finally {
    if (ownArchiveDb) archiveDb.close();
  }

  return {
    groupsProcessed,
    pairsClassified: totalPairsClassified,
    factsWritten: totalFactsWritten,
    failures: totalFailures,
    poisoned: totalPoisoned,
  };
}
