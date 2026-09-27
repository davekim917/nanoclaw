/**
 * Attention-source providers that read files a background task regenerates: a generated defect register, a
 * hand-written open-questions document, and default-branch CI from a release snapshot.
 * No provider here may make a network call or spawn a subprocess: each runs synchronously inside the thread-list
 * request that every open dashboard polls, so one remote call would block the host's event loop on every poll. The
 * freshness cost is bounded and visible through each artifact's own `asOf`.
 * These providers suppress nothing on claims, unlike `release-board`: a defect and its fixing PR are different
 * objects that both need a human, and a claim cannot supply a product decision. `claimCoversPr`'s number matching
 * must NOT be reused here, because issue and PR numbers are different namespaces. Ids are namespaced (`defect:`,
 * `question:`, `branch-ci:`) so cross-source dedupe never collides two objects that share a number.
 */
import crypto from 'crypto';

import { GROUPS_DIR } from '../../config.js';
import { log } from '../../log.js';
import { readContainedFile, resolveContainedRoot } from './attention-fs.js';
import type {
  AttentionSourceDecl,
  AttentionSourceEnv,
  ProvidedAttentionItem,
  ProviderRead,
} from '../../attention-sources.js';

const EMPTY: ProviderRead = { asOf: null, items: [] };

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function validIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The declared root plus the declared `file`, or `null` after logging; a missing `file` is a malformed declaration,
 * never a guessed filename.
 */
function readDeclaredFile(
  label: string,
  decl: AttentionSourceDecl,
  workgroupId: string,
  env: AttentionSourceEnv,
): { text: string; mtimeIso: string } | null {
  if (!decl.file) {
    log.warn(`${label}: declaration carries no \`file\`, emitting nothing`, { workgroupId, kind: decl.kind });
    return null;
  }
  const rootDir = resolveContainedRoot(label, env.groupsRoot ?? GROUPS_DIR, workgroupId, decl.root, env.dataRoot);
  if (rootDir === null) return null;
  return readContainedFile(label, rootDir, decl.file, workgroupId);
}

const DEFECT_LABEL = 'Defect register';

/**
 * The one bucket that needs a human, hardcoded because it is a property of what the buckets mean: `escalated` and
 * `actionable` are agent work, and emitting them would drown the human-owned minority.
 */
const HUMAN_BUCKET = 'product-decision';

/** `*Generated <ts> by `<script>`. Do not hand-edit — rerun it.*` */
const GENERATED_HEADER = /^\*Generated\s+(\S+)\s+by\b/m;

/**
 * The `m` flag lets GENERATED_HEADER match at any line start, so a file quoting the header in prose would claim fresh
 * generation; the generator writes it in the opening lines. A cue against innocent recurrence, not a defence against
 * a hostile writer.
 */
const GENERATED_HEADER_LINES = 10;

/** `## <bucket> (<n>)` — the count is the generator's, and is not read. */
const BUCKET_HEADING = /^##\s+(\S[^(]*?)\s*(?:\(\d+\))?\s*$/;

/** `- **[#<n>](<url>)** · p1 · filed 2026-08-08 · <title>` */
const DEFECT_LINE = /^-\s+\*\*\[#(\d+)\]\((\S+?)\)\*\*\s*·\s*(p\d+)\s*·\s*filed\s+(\d{4}-\d{2}-\d{2})\s*·\s*(.+?)\s*$/;

/** `https://<host>/<owner>/<repo>/issues/<n>` → `<owner>/<repo>`, else null. */
const ISSUE_URL_REPO = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/;

/**
 * Pure. `asOf` comes only from the file's own `Generated <ts>` header, and is null without one: the mtime of a
 * hand-edited generated file would be a false freshness claim. Items still emit.
 * One malformed line is skipped, never fatal: an empty feed reads as "nothing is blocked on a human".
 */
export function deriveDefectRegisterItems(
  text: string,
  binding: { workgroupId: string; channelKey: string },
): ProviderRead {
  const asOf = validIsoOrNull(GENERATED_HEADER.exec(text.split('\n', GENERATED_HEADER_LINES).join('\n'))?.[1]);

  const items: ProvidedAttentionItem[] = [];
  let bucket: string | null = null;
  let unparseable = 0;
  const headings: string[] = [];
  for (const raw of text.split('\n')) {
    const heading = BUCKET_HEADING.exec(raw);
    if (heading) {
      bucket = heading[1]!.trim();
      headings.push(bucket);
      continue;
    }
    if (bucket !== HUMAN_BUCKET) continue;
    const m = DEFECT_LINE.exec(raw);
    if (!m) {
      // Skips are counted and reported once so a degraded parse does not read like a clean one. Blank lines are
      // structure, not broken rows.
      if (raw.trim() !== '') unparseable++;
      continue;
    }

    const number = m[1]!;
    const url = m[2]!;
    const priority = m[3]!;
    const filed = m[4]!;
    const title = m[5]!;

    // Namespaced by the URL's repo so two registers in one workgroup cannot collide on a bare number.
    const repo = ISSUE_URL_REPO.exec(url)?.[1];
    items.push({
      id: `defect:${repo ? `${repo}#` : '#'}${number}`,
      channel_key: binding.channelKey,
      title,
      url,
      workgroupId: binding.workgroupId,
      claimState: 'parked',
      // `waiting on` is what routes the row to `needs_you` (`WAITING_ON_NOTE` in `threads.ts`).
      claimNote: `waiting on a human: ${bucket} · ${priority}`,
      claimOwner: null,
      participants: [],
      sessionCount: 0,
      // Date-only in the source, widened to the day's start to stay comparable ISO-8601 UTC.
      since: `${filed}T00:00:00Z`,
      nextAction: `Decide #${number}`,
    });
  }
  if (unparseable > 0) {
    log.warn(`${DEFECT_LABEL}: skipped unparseable rows in the ${HUMAN_BUCKET} bucket`, {
      workgroupId: binding.workgroupId,
      unparseable,
      emitted: items.length,
    });
  }
  // Everything above emits only under the HUMAN_BUCKET heading, so a renamed or re-levelled heading would parse
  // cleanly, emit nothing and warn about nothing, rendering as "nothing needs a human". The heading's absence is the
  // signal; a present heading with nothing under it is a real "nothing to decide".
  if (!headings.includes(HUMAN_BUCKET)) {
    log.warn(`${DEFECT_LABEL}: no \`${HUMAN_BUCKET}\` heading — nothing from this register can reach the queue`, {
      workgroupId: binding.workgroupId,
      headings,
    });
    items.push(defectRegisterShapeItem(headings, asOf, binding));
  }
  return { asOf, items };
}

/**
 * A defect register whose human bucket can no longer be found, reported as a parked `waiting on a human` work item so
 * it reaches `needs_you`. The note names the headings that were found.
 * The id depends on the condition alone, so it stays stable across polls and an assignment reservation keeps
 * matching. `since` is empty (never `now`) without a generated stamp, so it sorts as unmeasured.
 */
function defectRegisterShapeItem(
  headings: string[],
  asOf: string | null,
  binding: { workgroupId: string; channelKey: string },
): ProvidedAttentionItem {
  return {
    id: 'defect-register-shape',
    channel_key: binding.channelKey,
    title: `Defect register has no ${HUMAN_BUCKET} section`,
    // Never invented: the seam does not know where the generator lives.
    url: null,
    workgroupId: binding.workgroupId,
    claimState: 'parked',
    claimNote:
      `waiting on a human: the defect register was read fine but carries no \`${HUMAN_BUCKET}\` heading — ` +
      `${headings.length === 0 ? 'it has no `##` section headings at all' : `it has ${headings.map((h) => `\`${h}\``).join(', ')}`}. ` +
      `No defect from it is reaching the queue`,
    claimOwner: null,
    participants: [],
    sessionCount: 0,
    since: asOf ?? '',
    nextAction: `Check whether the defect register generator renamed or re-levelled its \`${HUMAN_BUCKET}\` heading`,
  };
}

export function readDefectRegisterSource(
  decl: AttentionSourceDecl,
  workgroupId: string,
  _now: number,
  env: AttentionSourceEnv = {},
): ProviderRead {
  const read = readDeclaredFile(DEFECT_LABEL, decl, workgroupId, env);
  if (read === null) return EMPTY;
  return deriveDefectRegisterItems(read.text, { workgroupId, channelKey: decl.channel_key });
}

const QUESTIONS_LABEL = 'Open questions';

/** `###` does not match, and neither does the `#` title. */
const H2 = /^##\s+(\S.*?)\s*$/;

/** How much of a section's opening paragraph rides along as the note. */
const EXCERPT_CHARS = 160;

/**
 * A readable prefix for an id, never the identity: many headings slugify to the empty string (see
 * {@link questionIds}).
 */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/** Content in, the same 8 hex out, forever. */
function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

/**
 * One item per `##` section. Structure only: the prose is rewritten over weeks, so parsing sentences out of it would
 * produce confidently wrong rows. The preamble is skipped.
 * `asOf` is the file's mtime, acceptable here (unlike the defect register) because a human writes this file. `since`
 * is the same mtime, an upper bound that understates the wait; unreadable leaves it empty so it sorts as unmeasured.
 */
export function deriveOpenQuestionItems(
  text: string,
  mtimeIso: string | null,
  binding: { workgroupId: string; channelKey: string },
): ProviderRead {
  const lines = text.split('\n');
  const sections: { title: string; excerpt: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const heading = H2.exec(lines[i]!);
    if (!heading) continue;
    const title = heading[1]!;

    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === '') j++;
    const paragraph: string[] = [];
    for (; j < lines.length && lines[j]!.trim() !== '' && !H2.test(lines[j]!); j++)
      paragraph.push(lines[j]!.trim().replace(/^[-*]\s+/, ''));

    sections.push({ title, excerpt: paragraph.join(' ').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim() });
  }

  const ids = questionIds(sections);
  const items: ProvidedAttentionItem[] = sections.map((section, index) => {
    const note =
      section.excerpt.length > EXCERPT_CHARS
        ? `${section.excerpt.slice(0, EXCERPT_CHARS).trimEnd()}…`
        : section.excerpt;
    return {
      id: `question:${ids[index]!}`,
      channel_key: binding.channelKey,
      title: section.title,
      // No per-section link exists. Never invented.
      url: null,
      workgroupId: binding.workgroupId,
      claimState: 'parked',
      claimNote: `waiting on a human: ${note || section.title}`,
      claimOwner: null,
      participants: [],
      sessionCount: 0,
      since: mtimeIso ?? '',
      nextAction: 'Answer this open question',
    };
  });
  // No sections is a real answer ("nothing is open"); `asOf` still stands.
  return { asOf: mtimeIso, items };
}

/**
 * One id per section, derived from what the section SAYS, never its position. `observatory_item_assignments`
 * (migration 058) keys on this id, and a changed id silently un-matches the assignment and re-enables a duplicate
 * dispatch; reordering, inserting or deleting sections must leave surviving ids alone.
 * Ordinary case: `<slug>-<digest>` of heading plus opening paragraph; the digest separates headings that slugify
 * alike or to nothing. A repeated heading with a different paragraph gets a different digest. Only sections identical
 * in heading and paragraph get an occurrence counter scoped to that group.
 * Rewriting a section's opening paragraph changes its id; that churn is accepted because the document grows by
 * appending below it.
 */
function questionIds(sections: { title: string; excerpt: string }[]): string[] {
  const total = new Map<string, number>();
  const key = (s: { title: string; excerpt: string }) => `${s.title}\u0000${s.excerpt}`;
  for (const s of sections) total.set(key(s), (total.get(key(s)) ?? 0) + 1);

  const nth = new Map<string, number>();
  return sections.map((s) => {
    const slug = slugify(s.title);
    const natural = slug ? `${slug}-${digest(key(s))}` : digest(key(s));
    if (total.get(key(s)) === 1) return natural;
    const n = (nth.get(key(s)) ?? 0) + 1;
    nth.set(key(s), n);
    return `${natural}-${n}`;
  });
}

export function readOpenQuestionsSource(
  decl: AttentionSourceDecl,
  workgroupId: string,
  _now: number,
  env: AttentionSourceEnv = {},
): ProviderRead {
  const read = readDeclaredFile(QUESTIONS_LABEL, decl, workgroupId, env);
  if (read === null) return EMPTY;
  // The mtime comes from the same open as the text, so the freshness claim is about the bytes just read.
  return deriveOpenQuestionItems(read.text, read.mtimeIso, {
    workgroupId,
    channelKey: decl.channel_key,
  });
}

const BRANCH_CI_LABEL = 'Branch CI';

const CI_STATES = new Set(['success', 'failure', 'cancelled', 'running', 'unknown']);

/**
 * A red default branch from the release snapshot (never asks the forge).
 * Only `failure` emits. `unknown` and `cancelled` are absence of a verdict, and a row claiming a red branch nobody
 * established is a false alarm. `since` equals the snapshot's `asOf`: the snapshot records the state, not when the
 * failure began.
 */
export function deriveBranchCiItems(
  snapshot: unknown,
  branch: string,
  binding: { workgroupId: string; channelKey: string },
): ProviderRead {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    log.warn(`${BRANCH_CI_LABEL}: snapshot is not an object, emitting nothing`, {
      workgroupId: binding.workgroupId,
      branch,
    });
    return EMPTY;
  }
  const asOf = validIsoOrNull((snapshot as Record<string, unknown>).asOf);
  if (asOf === null) {
    log.warn(`${BRANCH_CI_LABEL}: snapshot carries no usable asOf, emitting nothing`, {
      workgroupId: binding.workgroupId,
      branch,
    });
    return EMPTY;
  }

  // Derived from the declared branch so a second branch is a second declaration, not a constant in trunk.
  const raw = (snapshot as Record<string, unknown>)[`${branch}_ci`];
  if (raw === undefined) {
    // Common on an install whose watcher does not emit the field yet: not an error, but never silent.
    log.debug(`${BRANCH_CI_LABEL}: snapshot carries no CI state for this branch, emitting nothing`, {
      workgroupId: binding.workgroupId,
      branch,
    });
    return { asOf, items: [] };
  }
  if (typeof raw !== 'string' || !CI_STATES.has(raw)) {
    log.warn(`${BRANCH_CI_LABEL}: unrecognised CI state, emitting nothing`, {
      workgroupId: binding.workgroupId,
      branch,
    });
    return { asOf, items: [] };
  }
  if (raw !== 'failure') return { asOf, items: [] };

  return {
    asOf,
    items: [
      {
        id: `branch-ci:${branch}`,
        channel_key: binding.channelKey,
        title: `CI is failing on ${branch}`,
        // The snapshot carries no run URL. Never invented.
        url: null,
        workgroupId: binding.workgroupId,
        claimState: 'parked',
        claimNote: `waiting on a human: CI on ${branch} is failing`,
        claimOwner: null,
        participants: [],
        sessionCount: 0,
        since: asOf,
        nextAction: `Fix or revert what broke ${branch}`,
      },
    ],
  };
}

export function readBranchCiSource(
  decl: AttentionSourceDecl,
  workgroupId: string,
  _now: number,
  env: AttentionSourceEnv = {},
): ProviderRead {
  if (!decl.branch) {
    log.warn(`${BRANCH_CI_LABEL}: declaration carries no \`branch\`, emitting nothing`, { workgroupId });
    return EMPTY;
  }
  const read = readDeclaredFile(BRANCH_CI_LABEL, decl, workgroupId, env);
  if (read === null) return EMPTY;

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(read.text);
  } catch (err) {
    log.warn(`${BRANCH_CI_LABEL}: snapshot unreadable, emitting nothing`, { workgroupId, err });
    return EMPTY;
  }
  return deriveBranchCiItems(snapshot, decl.branch, { workgroupId, channelKey: decl.channel_key });
}
