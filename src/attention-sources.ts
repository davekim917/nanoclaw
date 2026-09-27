/**
 * Attention sources: trunk's seam for work blocked on a human with no session (DESIGN.md §5 `unassigned`).
 * Trunk ships the reader; an install declares the binding as JSON on `workgroups.attention_sources`, e.g.
 * `[{ "kind": "release-board", "root": "releases", "channel_key": "slack:C0EXAMPLE1" }]`. No install identifier
 * may appear here: trunk is public and `scripts/check-public-boundary.ts` rejects them.
 *
 * An empty feed reads as "nothing is blocked on a human", so no config error may reduce the feed to silence:
 * an absent declaration emits nothing; a malformed one disables only itself and emits a `misconfigured:` item;
 * a bad `refresh_hours` keeps the rows with no staleness claim; an unknown `kind` is skipped (version skew).
 * Staleness is per source, stamped on its rows, and never suppresses them; a source past its cadence also emits
 * one `stale:` item from the seam, since a dead provider cannot report its own silence (§12).
 */
import path from 'path';

import { withCentralSync, withRawDb } from './db/central-lease.js';
import { log } from './log.js';
import { readReleaseBoardSource } from './dashboard/api/board-attention.js';
import {
  readBranchCiSource,
  readDefectRegisterSource,
  readOpenQuestionsSource,
} from './dashboard/api/desk-attention.js';

/**
 * Every {@link AttentionItem.id} starts with this. It is a dedupe key, never a thread id: run through
 * `threadChannelKey` an item id would mint one fake sidebar channel per item.
 */
export const ATTENTION_ITEM_PREFIX = 'board:';

export function isAttentionItemId(id: string): boolean {
  return id.startsWith(ATTENTION_ITEM_PREFIX);
}

/**
 * The provider's natural id with the stamp removed; anything that persists an item (migration 058) stores this
 * form. Idempotent.
 */
export function stripAttentionItemPrefix(id: string): string {
  return isAttentionItemId(id) ? id.slice(ATTENTION_ITEM_PREFIX.length) : id;
}

export interface AttentionSourceDecl {
  /** Unknown kinds are skipped, never fatal. */
  kind: string;
  /** Relative to `groups/<workgroupId>/`, `..`-free by validation: the workgroup folder is the data-pool boundary. */
  root: string;
  /** `<platform>:<channel>`, the shape `threadChannelKey` resolves to; one key for the whole source. */
  channel_key: string;
  /** One file under {@link root}, relative to it and `..`-free. A provider that requires it validates presence. */
  file?: string;
  /** Kept to a git ref's shape so it cannot smuggle a path segment into a key or a title. */
  branch?: string;
  /**
   * Expected regeneration interval in hours, positive and finite. Absent means NO staleness claim (neither
   * fresh nor stale): an undeclared cadence must never read as a checked one (DESIGN.md §12).
   */
  refresh_hours?: number;
}

/**
 * One ownerless work item. Field names mirror `deriveThreadState`'s inputs; producers state facts and must not
 * set a `state` of their own.
 */
export interface AttentionItem {
  /** Dedupe key only. A provider returns its natural id; {@link readAttentionItems} stamps the prefix. */
  id: string;
  channel_key: string;
  title: string;
  /** Where a human goes to act, or null. Never invented. */
  url: string | null;
  workgroupId: string;
  claimState: 'parked' | null;
  claimNote: string | null;
  claimOwner: string | null;
  participants: [];
  sessionCount: 0;
  /** ISO-8601 UTC. */
  since: string;
  nextAction: string;
  /** Stamped by {@link readAttentionItems} from the declaration and the provider's `asOf`, never by a provider. */
  sourceKind: string;
  sourceAsOf: string | null;
  /**
   * Has this row's source missed its declared cadence? `null` means no claim was made (no `refresh_hours`, or
   * an unreadable `asOf`) and must never collapse into `false`.
   */
  sourceStale: boolean | null;
}

export type ProvidedAttentionItem = Omit<AttentionItem, 'sourceKind' | 'sourceAsOf' | 'sourceStale'>;

export interface ProviderRead {
  /** ISO-8601 UTC, or null when nothing could be read: "no board" differs from "board says nothing is blocked". */
  asOf: string | null;
  items: ProvidedAttentionItem[];
}

/** Items only: there is deliberately no feed-level `asOf`; freshness belongs to each source's rows. */
export interface AttentionRead {
  items: AttentionItem[];
}

/** Test seams; all default to the live roots. */
export interface AttentionSourceEnv {
  groupsRoot?: string;
  claimsRoot?: string;
  dataRoot?: string;
}

type AttentionProvider = (
  decl: AttentionSourceDecl,
  workgroupId: string,
  now: number,
  env: AttentionSourceEnv,
) => ProviderRead;

const PROVIDERS: Record<string, AttentionProvider> = {
  'release-board': readReleaseBoardSource,
  'defect-register': readDefectRegisterSource,
  'open-questions': readOpenQuestionsSource,
  'branch-ci': readBranchCiSource,
};

const EMPTY: AttentionRead = { items: [] };

function isSafeRelativeRoot(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`) && !path.isAbsolute(normalized);
}

const CHANNEL_KEY_SHAPE = /^[a-z0-9-]+:.+$/i;

const BRANCH_SHAPE = /^[\w./-]+$/;

/**
 * One declaration that could not be used. Derived from the declaration alone (no clock, no read) so the item
 * minted from it keeps a stable identity; identity fields are captured whichever check failed.
 */
interface AttentionSourceDefect {
  /** Position in the declared array, `-1` when the column itself is unreadable; identity only as a last resort. */
  index: number;
  /** `null` when the field did not parse as a string. */
  kind: string | null;
  root: string | null;
  file: string | null;
  channelKey: string | null;
  field: string;
  problem: string;
  /**
   * Whether the source cannot be read. Only a bad `refresh_hours` leaves it readable: gating real rows on a
   * cadence typo would delete work to punish a label.
   */
  disablesSource: boolean;
}

/** Usable declarations plus a defect for each unusable one; always both. */
export interface AttentionSourceParse {
  decls: AttentionSourceDecl[];
  defects: AttentionSourceDefect[];
}

/**
 * Validate one workgroup's raw column value. No config error may reduce the feed to silence: failure is per
 * declaration, never per workgroup, and a bad value is reported as a defect (its own work item) rather than
 * degraded to "no claim", which would be indistinguishable from an operator declaring none.
 */
export function parseAttentionSources(raw: string | null | undefined): AttentionSourceParse {
  if (raw === null || raw === undefined || raw.trim() === '') return { decls: [], defects: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { decls: [], defects: [columnDefect('the value is not valid JSON')] };
  }
  if (!Array.isArray(parsed)) {
    return { decls: [], defects: [columnDefect('the value must be a JSON array of declarations')] };
  }

  const decls: AttentionSourceDecl[] = [];
  const defects: AttentionSourceDefect[] = [];
  parsed.forEach((entry, index) => {
    const { decl, defect } = parseOneDecl(entry, index);
    if (decl) decls.push(decl);
    if (defect) defects.push(defect);
  });
  return { decls, defects };
}

function columnDefect(problem: string): AttentionSourceDefect {
  return {
    index: -1,
    kind: null,
    root: null,
    file: null,
    channelKey: null,
    field: 'attention_sources',
    problem,
    disablesSource: true,
  };
}

/** One entry, validated. At most one defect per declaration: the first unusable field. */
function parseOneDecl(
  entry: unknown,
  index: number,
): { decl: AttentionSourceDecl | null; defect: AttentionSourceDefect | null } {
  const rec =
    typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
  // Captured before any check so a defect can still name its source.
  const kind = typeof rec?.kind === 'string' && rec.kind.trim() !== '' ? rec.kind : null;
  const root = typeof rec?.root === 'string' ? rec.root : null;
  const file = typeof rec?.file === 'string' ? rec.file : null;
  const channelKey =
    typeof rec?.channel_key === 'string' && CHANNEL_KEY_SHAPE.test(rec.channel_key) ? rec.channel_key : null;
  const bad = (
    field: string,
    problem: string,
    disablesSource: boolean,
  ): { decl: null; defect: AttentionSourceDefect } => ({
    decl: null,
    defect: { index, kind, root, file, channelKey, field, problem, disablesSource },
  });

  // Everything below is source-fatal; the defect keeps it audible.
  if (rec === null) return bad('declaration', 'a declaration must be a JSON object', true);
  if (kind === null) return bad('kind', '`kind` must be a non-empty string naming a source kind', true);
  if (root === null || !isSafeRelativeRoot(root)) {
    return bad('root', '`root` must be a relative path inside the workgroup folder, with no `..`', true);
  }
  // A key with no platform segment would land items in a bucket no sidebar entry matches.
  if (channelKey === null) return bad('channel_key', '`channel_key` must look like `<platform>:<channel>`', true);
  if (rec.file !== undefined && (file === null || !isSafeRelativeRoot(file))) {
    return bad('file', '`file` must be a relative path under `root`, with no `..`', true);
  }
  if (rec.branch !== undefined && (typeof rec.branch !== 'string' || !BRANCH_SHAPE.test(rec.branch))) {
    return bad('branch', '`branch` must be a git ref name', true);
  }

  const decl: AttentionSourceDecl = {
    kind,
    root,
    channel_key: channelKey,
    ...(rec.file === undefined ? {} : { file: file! }),
    ...(rec.branch === undefined ? {} : { branch: rec.branch as string }),
  };

  // `refresh_hours` is the one non-fatal field: a bad value keeps the declaration with no staleness claim and
  // reports a defect. Zero, negative, NaN and Infinity are rejected.
  const refreshHours = rec.refresh_hours;
  if (refreshHours === undefined) return { decl, defect: null };
  if (typeof refreshHours !== 'number' || !Number.isFinite(refreshHours) || refreshHours <= 0) {
    return {
      decl,
      defect: {
        index,
        kind,
        root,
        file,
        channelKey,
        field: 'refresh_hours',
        problem: '`refresh_hours` must be a positive, finite number of hours',
        disablesSource: false,
      },
    };
  }
  decl.refresh_hours = refreshHours;
  return { decl, defect: null };
}

/** A DB read that throws returns the empty parse (infrastructure, not config) and warns. */
async function readAttentionSourceDecls(workgroupId: string): Promise<AttentionSourceParse> {
  let row: { attention_sources: string | null } | undefined;
  try {
    row = await withCentralSync(
      () =>
        withRawDb(
          (db) =>
            db.prepare(`SELECT attention_sources FROM workgroups WHERE id = ?`).get(workgroupId) as
              | { attention_sources: string | null }
              | undefined,
        ),
      'attention source decls',
    );
  } catch (err) {
    log.warn('Attention sources: workgroup lookup failed, emitting nothing', { workgroupId, err });
    return { decls: [], defects: [] };
  }
  return parseAttentionSources(row?.attention_sources);
}

/**
 * Must stay far below the 4-6 hour claim TTL and the source's ~30-minute cadence: a memo old enough to miss a
 * claim being taken shows one PR twice, as a claimed thread and as an ownerless board row.
 */
export const ATTENTION_MEMO_TTL_MS = 60_000;

const memo = new Map<string, { at: number; read: AttentionRead }>();

/** Vitest keeps module state across files in a worker; tests must reset it. */
export function clearAttentionMemo(): void {
  memo.clear();
}

/** Every declared source's items for one workgroup, merged. Memoized; see {@link ATTENTION_MEMO_TTL_MS}. */
export async function readAttentionItems(
  workgroupId: string,
  now: number,
  env: AttentionSourceEnv = {},
): Promise<AttentionRead> {
  const key = `${workgroupId}\0${env.groupsRoot ?? ''}\0${env.claimsRoot ?? ''}`;
  const cached = memo.get(key);
  if (cached && now - cached.at < ATTENTION_MEMO_TTL_MS && now >= cached.at) return cached.read;

  const read = await computeAttentionItems(workgroupId, now, env);
  memo.set(key, { at: now, read });
  return read;
}

async function computeAttentionItems(
  workgroupId: string,
  now: number,
  env: AttentionSourceEnv,
): Promise<AttentionRead> {
  const { decls, defects } = await readAttentionSourceDecls(workgroupId);
  if (decls.length === 0 && defects.length === 0) {
    log.debug('Attention sources: none declared', { workgroupId });
    return EMPTY;
  }

  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  const emit = (
    item: ProvidedAttentionItem,
    sourceKind: string,
    sourceAsOf: string | null,
    stale: boolean | null,
  ): void => {
    const id = `${ATTENTION_ITEM_PREFIX}${item.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    items.push({ ...item, id, sourceKind, sourceAsOf, sourceStale: stale });
  };

  // Config errors lead, minted here because a provider that could not be constructed cannot report. They carry
  // no `asOf` or staleness claim.
  for (const defect of defects) {
    log.warn('Attention sources: malformed declaration, reporting it as a work item', { workgroupId, ...defect });
    emit(misconfiguredSourceItem(defect, workgroupId), defect.kind ?? MISCONFIGURED_SOURCE_KIND, null, null);
  }

  for (const decl of decls) {
    const provider = PROVIDERS[decl.kind];
    if (!provider) {
      log.warn('Attention sources: unknown kind, ignoring this source', { workgroupId, kind: decl.kind });
      continue;
    }
    let read: ProviderRead;
    try {
      read = provider(decl, workgroupId, now, env);
    } catch (err) {
      log.warn('Attention sources: provider threw, emitting nothing for this source', {
        workgroupId,
        kind: decl.kind,
        err,
      });
      continue;
    }
    // One staleness verdict per source, from its own `asOf`; nothing downstream recomputes or aggregates it.
    const stale = sourceStaleness(read.asOf, decl.refresh_hours, now);

    // Deduped on the stamped id (two sources can name one PR; duplicate React keys). First source in declaration
    // order wins.
    const push = (item: ProvidedAttentionItem): void => emit(item, decl.kind, read.asOf, stale);

    for (const item of read.items) push(item);
    // Exactly one per stale source, even when it emitted no rows: that is when a dead generator is least visible.
    if (stale === true) push(staleSourceItem(decl, read.asOf!, now, workgroupId));
  }
  return { items };
}

const HOUR_MS = 3_600_000;

/**
 * Has one source missed its declared cadence? `null` when no honest claim exists: no `refresh_hours`, or an
 * unreadable or unparseable `asOf`. An unknown age is not an old one, and never `false`.
 */
export function sourceStaleness(
  sourceAsOf: string | null,
  refreshHours: number | undefined,
  now: number,
): boolean | null {
  if (refreshHours === undefined || sourceAsOf === null) return null;
  const at = Date.parse(sourceAsOf);
  if (!Number.isFinite(at)) return null;
  return now - at > refreshHours * HOUR_MS;
}

/**
 * A stale source as a work item. Emitted only by the seam, since a provider cannot report its own silence. The
 * id derives only from the declaration so it keeps one identity across polls and assignment reservations.
 */
function staleSourceItem(
  decl: AttentionSourceDecl,
  sourceAsOf: string,
  now: number,
  workgroupId: string,
): ProvidedAttentionItem {
  const label = describeSource(decl);
  const overdue = formatHours((now - Date.parse(sourceAsOf)) / HOUR_MS);
  const expected = formatHours(decl.refresh_hours!);
  return {
    // Every distinguishing field, so two sources of one kind cannot collapse into one notice.
    id: `stale:${[decl.kind, decl.root, decl.file, decl.branch].filter(Boolean).join(':')}`,
    channel_key: decl.channel_key,
    title: `${label} has stopped regenerating`,
    // Never invented (§12).
    url: null,
    workgroupId,
    claimState: 'parked',
    // `waiting on` verbatim routes this into `needs_you` (`WAITING_ON_NOTE` in `threads.ts`).
    claimNote: `waiting on a human: ${label} last regenerated ${overdue} ago, expected every ${expected}`,
    claimOwner: null,
    participants: [],
    sessionCount: 0,
    // Not `now`: `cappedByAge` keeps the oldest rows, so the read time would drop a long-dead generator first.
    since: sourceAsOf,
    nextAction: `Find out why the ${label} source stopped regenerating`,
  };
}

function describeSource(decl: AttentionSourceDecl): string {
  return decl.file ? `${decl.kind} (${decl.file})` : decl.kind;
}

/** `sourceKind` is non-null on the wire; inventing a provider name would be worse than admitting none was named. */
const MISCONFIGURED_SOURCE_KIND = 'attention-source';

/**
 * Must equal `UNKNOWN_CHANNEL_KEY` in `src/dashboard/api/threads.ts`, which imports this module (so it cannot
 * be imported here). Pinned equal by `src/attention-sources.test.ts`.
 */
const UNROUTED_CHANNEL_KEY = 'unknown';

/**
 * A sentinel, not a measurement: there is no "when it broke" time. `now` would re-date the row every poll and
 * make it the first one `cappedByAge` drops; the epoch is implausible on its face and sorts oldest.
 */
const MISCONFIGURED_SINCE = '1970-01-01T00:00:00.000Z';

/**
 * A declaration that could not be used, as a work item; the seam is the only actor able to report it. The id
 * derives only from the declaration so it keeps one identity across polls and assignment reservations.
 */
function misconfiguredSourceItem(defect: AttentionSourceDefect, workgroupId: string): ProvidedAttentionItem {
  const label = describeDefect(defect);
  const cost = defect.disablesSource
    ? 'that source is emitting no items at all'
    : 'its items are still listed, but carry no staleness marker';
  return {
    // Every distinguishing field plus the field at fault; position only when the declaration named nothing.
    id: `misconfigured:${
      [defect.kind, defect.root, defect.file].filter(Boolean).join(':') ||
      (defect.index < 0 ? 'declaration' : `#${defect.index}`)
    }:${defect.field}`,
    // Its siblings' room when named, so the notice sits where the missing work would have.
    channel_key: defect.channelKey ?? UNROUTED_CHANNEL_KEY,
    title: `${label} is misconfigured`,
    // Never invented (§12).
    url: null,
    workgroupId,
    claimState: 'parked',
    // `waiting on` verbatim routes this into `needs_you` (`WAITING_ON_NOTE` in `threads.ts`).
    claimNote:
      `waiting on a human: workgroup ${workgroupId} declares ${label} with an unusable \`${defect.field}\` — ` +
      `${defect.problem}. Right now ${cost}, and staleness is not being checked for it`,
    claimOwner: null,
    participants: [],
    sessionCount: 0,
    since: MISCONFIGURED_SINCE,
    nextAction: `Fix \`${defect.field}\` in workgroup ${workgroupId}'s attention_sources declaration`,
  };
}

function describeDefect(defect: AttentionSourceDefect): string {
  if (defect.kind === null) {
    return defect.index < 0 ? 'its attention_sources value' : `attention source declaration #${defect.index}`;
  }
  return defect.file ? `attention source ${defect.kind} (${defect.file})` : `attention source ${defect.kind}`;
}

function formatHours(hours: number): string {
  const total = Math.max(0, Math.round(hours));
  const days = Math.floor(total / 24);
  const rest = total % 24;
  if (days === 0) return `${total}h`;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

/**
 * The workgroups a set of agent groups belongs to: the only bridge from the console's agent-group scope ceiling
 * to workgroup-declared sources, and a pure narrowing.
 */
export async function workgroupIdsForAgentGroups(agentGroupIds: string[]): Promise<string[]> {
  if (agentGroupIds.length === 0) return [];
  try {
    const rows = await withCentralSync(
      () =>
        withRawDb(
          (db) =>
            db
              .prepare(
                `SELECT DISTINCT workgroup_id FROM agent_groups
            WHERE workgroup_id IS NOT NULL AND id IN (${agentGroupIds.map(() => '?').join(', ')})`,
              )
              .all(...agentGroupIds) as { workgroup_id: string }[],
        ),
      'attention workgroups for agent groups',
    );
    return rows.map((r) => r.workgroup_id);
  } catch (err) {
    log.warn('Attention sources: workgroup lookup for agent groups failed', { err });
    return [];
  }
}

export async function workgroupIdsWithAttentionSources(): Promise<string[]> {
  try {
    const rows = await withCentralSync(
      () =>
        withRawDb(
          (db) => db.prepare(`SELECT id FROM workgroups WHERE attention_sources IS NOT NULL`).all() as { id: string }[],
        ),
      'attention workgroups with sources',
    );
    return rows.map((r) => r.id);
  } catch (err) {
    log.warn('Attention sources: workgroup scan failed', { err });
    return [];
  }
}
