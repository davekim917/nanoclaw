/**
 * Three attention-source providers that read files a background task already
 * regenerates: a generated defect register, a hand-written open-questions
 * document, and the CI state on a default branch as recorded in a release
 * snapshot.
 *
 * ## They read FILES, and that is a hard constraint, not a shortcut
 *
 * **No provider here may make a network call or spawn a subprocess.** Every
 * provider runs synchronously inside the thread-list request, which SWR polls
 * continuously from every open dashboard. One `fetch` to GitHub — or one
 * `execFileSync('gh', …)` — would block the host's single event loop for as
 * long as the remote takes to answer, on every poll, for every viewer.
 *
 * That is the whole reason these read generated artifacts instead of querying
 * the APIs behind them. The freshness cost is then bounded by the generating
 * task's cadence and is VISIBLE, because each provider reports the artifact's
 * own `asOf`. Do not "improve" one of these by having it fetch live data.
 *
 * ## No install identifiers live here
 *
 * The workgroup, the directory, the filename, the branch label and the channel
 * all arrive in the {@link AttentionSourceDecl} the install wrote onto its
 * `workgroups.attention_sources` row (migration 057). See
 * `src/attention-sources.ts` for the seam.
 *
 * ## Dedupe: these providers suppress nothing, and that is deliberate
 *
 * The `release-board` provider suppresses a PR that an agent has already
 * claimed, because there the claim's owner IS the one taking the ship action —
 * two rows would be the same person's same job. None of that holds here:
 *
 *  - A **defect** and a **PR that fixes it** are different objects at different
 *    stages, and both should show. The defect asks a human for a ruling; the PR
 *    asks a human for a ship.
 *  - The `product-decision` bucket in particular waits on a HUMAN saying what
 *    correct looks like. An agent holding a claim on it cannot supply that, so
 *    a claim is not evidence the item is handled.
 *  - `claimCoversPr`'s number matching must NOT be reused here. GitHub ISSUE
 *    numbers and PR numbers are different namespaces to this codebase (a claim
 *    slug says `gh-<n>` without saying which), so matching one against the
 *    other would silently delete real blocked work — the exact over-matching
 *    bug already found and fixed once on the release-board side.
 *
 * Each provider's ids are namespaced (`defect:`, `question:`, `branch-ci:`) so
 * the seam's cross-source dedupe can never collide two DIFFERENT objects that
 * merely share a number.
 */
import { GROUPS_DIR } from '../../config.js';
import { log } from '../../log.js';
import { containedMtimeIso, readContainedFile, resolveContainedRoot } from './attention-fs.js';
import type {
  AttentionSourceDecl,
  AttentionSourceEnv,
  ProvidedAttentionItem,
  ProviderRead,
} from '../../attention-sources.js';

const EMPTY: ProviderRead = { asOf: null, items: [] };

/** ISO-8601 UTC with a `Z`, the only shape this codebase writes (CLAUDE.md). */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function validIsoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The declared root plus the declared `file`, or `null` after logging.
 *
 * Both providers that read a single file need the same two checks — a root
 * that resolves inside the workgroup, and a `file` the declaration actually
 * carries. A missing `file` is a malformed declaration for those kinds, so it
 * emits nothing and warns rather than guessing a filename.
 */
function readDeclaredFile(
  label: string,
  decl: AttentionSourceDecl,
  workgroupId: string,
  env: AttentionSourceEnv,
): { text: string; rootDir: string; file: string } | null {
  if (!decl.file) {
    log.warn(`${label}: declaration carries no \`file\`, emitting nothing`, { workgroupId, kind: decl.kind });
    return null;
  }
  const rootDir = resolveContainedRoot(label, env.groupsRoot ?? GROUPS_DIR, workgroupId, decl.root);
  if (rootDir === null) return null;
  const text = readContainedFile(label, rootDir, decl.file, workgroupId);
  return text === null ? null : { text, rootDir, file: decl.file };
}

/* ─── defect-register ──────────────────────────────────────────────────────── */

const DEFECT_LABEL = 'Defect register';

/**
 * The one bucket that needs a human, hardcoded rather than declared.
 *
 * The register's own preamble states the split: `escalated` needs "a diagnosis
 * pass, not another try" and `actionable` is "the real build queue" — both are
 * AGENT work. Only `product-decision` means "no fix gets written until someone
 * says what correct looks like", which is a human and nothing else.
 *
 * Emitting every bucket would put every open finding in a queue whose entire
 * job is saying what is blocked ON THE OPERATOR; the agent-owned majority would
 * drown the human-owned minority. This is a property of what the buckets MEAN,
 * not of one install's taste, so it is not a declaration field.
 */
const HUMAN_BUCKET = 'product-decision';

/** `*Generated <ts> by `<script>`. Do not hand-edit — rerun it.*` */
const GENERATED_HEADER = /^\*Generated\s+(\S+)\s+by\b/m;

/** `## <bucket> (<n>)` — the count is the generator's, and is not read. */
const BUCKET_HEADING = /^##\s+(\S[^(]*?)\s*(?:\(\d+\))?\s*$/;

/** `- **[#571](<url>)** · p1 · filed 2026-08-08 · <title>` */
const DEFECT_LINE = /^-\s+\*\*\[#(\d+)\]\((\S+?)\)\*\*\s*·\s*(p\d+)\s*·\s*filed\s+(\d{4}-\d{2}-\d{2})\s*·\s*(.+?)\s*$/;

/** `https://<host>/<owner>/<repo>/issues/<n>` → `<owner>/<repo>`, else null. */
const ISSUE_URL_REPO = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/;

/**
 * Turn a generated defect register into attention items. Pure — text in, items
 * out — so every rule below is testable without a register on disk.
 *
 * `asOf` comes from the file's own `Generated <ts>` header and from nowhere
 * else. When that header is missing or unparseable, `asOf` is **null**: the
 * file's mtime would then be reporting when somebody HAND-EDITED a file whose
 * own first line says not to, which is precisely the case where a freshness
 * claim would be false. Items still emit — the content is real work — they
 * just carry no freshness claim, which the UI already renders distinctly.
 *
 * One malformed line is skipped, never fatal: a generator change that breaks
 * one row must not blank a feed, because an empty feed reads as "nothing is
 * blocked on a human".
 */
export function deriveDefectRegisterItems(
  text: string,
  binding: { workgroupId: string; channelKey: string },
): ProviderRead {
  const asOf = validIsoOrNull(GENERATED_HEADER.exec(text)?.[1]);

  const items: ProvidedAttentionItem[] = [];
  let bucket: string | null = null;
  for (const raw of text.split('\n')) {
    const heading = BUCKET_HEADING.exec(raw);
    if (heading) {
      bucket = heading[1]!.trim();
      continue;
    }
    if (bucket !== HUMAN_BUCKET) continue;
    const m = DEFECT_LINE.exec(raw);
    if (!m) continue;

    const number = m[1]!;
    const url = m[2]!;
    const priority = m[3]!;
    const filed = m[4]!;
    const title = m[5]!;

    // Namespaced by the repo the URL names, so two registers in one workgroup
    // cannot collide on a bare number. A URL that is not issue-shaped still
    // yields an item — the number is the identity — it just carries no repo.
    const repo = ISSUE_URL_REPO.exec(url)?.[1];
    items.push({
      id: `defect:${repo ? `${repo}#` : '#'}${number}`,
      channel_key: binding.channelKey,
      title,
      url,
      workgroupId: binding.workgroupId,
      claimState: 'parked',
      // Composed only from what the line itself carries. `waiting on` is what
      // routes the row to `needs_you` (`WAITING_ON_NOTE` in `threads.ts`), and
      // there is no named owner to put after it — the bucket's whole meaning is
      // that nobody has been asked yet.
      claimNote: `waiting on a human: ${bucket} · ${priority}`,
      claimOwner: null,
      participants: [],
      sessionCount: 0,
      // The filed date IS when this started waiting. Date-only in the source,
      // widened to the day's start so it stays a comparable ISO-8601 UTC value.
      since: `${filed}T00:00:00Z`,
      nextAction: `Decide #${number}`,
    });
  }
  return { asOf, items };
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

/* ─── open-questions ───────────────────────────────────────────────────────── */

const QUESTIONS_LABEL = 'Open questions';

/** `## <heading>` — `###` does not match, and neither does the `#` title. */
const H2 = /^##\s+(\S.*?)\s*$/;

/** How much of a section's opening paragraph rides along as the note. */
const EXCERPT_CHARS = 160;

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/**
 * Turn a free-prose questions document into one item per `##` section.
 *
 * **Structure only.** This file is genuinely free prose — a single item runs
 * 40+ lines of narrative argument, with updates, answers and counter-arguments
 * appended inline over weeks. Parsing sentences, questions or addressees out of
 * it would shatter the first time an agent rewords something, and would produce
 * confidently wrong rows rather than an obvious break. The `##` headings are
 * the only stable structure the document has, so they are the only thing read.
 *
 * The preamble before the first `##` is skipped: it explains the file, it is
 * not an item.
 *
 * `asOf` is the file's MTIME, passed in by the caller. That is acceptable here
 * and is not for the defect register, and the difference is which claim mtime
 * supports: this file is written BY A HUMAN, so "when it was last written" IS
 * its freshness. A generated file's mtime says only when the generator last
 * ran — or worse, when somebody hand-edited a file that says not to — so there
 * it would vouch for content it knows nothing about.
 *
 * `since` is the same mtime, for the same reason plus one: no section carries
 * its own date, and deriving one from the prose is exactly the parse this
 * function refuses to do. The mtime is the NEWEST moment any of this file was
 * written, so it is an upper bound — the row understates how long the item has
 * waited rather than inflating it. An unreadable mtime leaves `since` empty,
 * which the console reads as unmeasured and sorts last (§12), never as zero.
 */
export function deriveOpenQuestionItems(
  text: string,
  mtimeIso: string | null,
  binding: { workgroupId: string; channelKey: string },
): ProviderRead {
  const lines = text.split('\n');
  const items: ProvidedAttentionItem[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const heading = H2.exec(lines[i]!);
    if (!heading) continue;
    const title = heading[1]!;

    // The opening paragraph: skip blank lines after the heading, then take
    // lines until the next blank line or the next section.
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === '') j++;
    const paragraph: string[] = [];
    for (; j < lines.length && lines[j]!.trim() !== '' && !H2.test(lines[j]!); j++)
      paragraph.push(lines[j]!.trim().replace(/^[-*]\s+/, ''));

    const excerpt = paragraph.join(' ').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
    const note = excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS).trimEnd()}…` : excerpt;

    // Keyed on the HEADING, not on position: an assignment record (migration
    // 058) is stored against the natural id, and an index-keyed id would churn
    // every time somebody reorders the document. A repeated heading is a defect
    // in the document, but dropping the second one would be a silent loss, so
    // it disambiguates in document order instead.
    const base = slugify(title) || `section-${items.length + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);

    items.push({
      id: `question:${base}${n > 1 ? `-${n}` : ''}`,
      channel_key: binding.channelKey,
      title,
      // No per-section link exists in the document. Never invented.
      url: null,
      workgroupId: binding.workgroupId,
      claimState: 'parked',
      claimNote: `waiting on a human: ${note || title}`,
      claimOwner: null,
      participants: [],
      sessionCount: 0,
      since: mtimeIso ?? '',
      nextAction: 'Answer this open question',
    });
  }
  // No section headings at all is a real answer ("nothing is open"), not a
  // failure — but a readable file always has an mtime, so `asOf` still stands.
  return { asOf: mtimeIso, items };
}

export function readOpenQuestionsSource(
  decl: AttentionSourceDecl,
  workgroupId: string,
  _now: number,
  env: AttentionSourceEnv = {},
): ProviderRead {
  const read = readDeclaredFile(QUESTIONS_LABEL, decl, workgroupId, env);
  if (read === null) return EMPTY;
  return deriveOpenQuestionItems(read.text, containedMtimeIso(read.rootDir, read.file), {
    workgroupId,
    channelKey: decl.channel_key,
  });
}

/* ─── branch-ci ────────────────────────────────────────────────────────────── */

const BRANCH_CI_LABEL = 'Branch CI';

/** Every value the snapshot's `<branch>_ci` field is allowed to carry. */
const CI_STATES = new Set(['success', 'failure', 'cancelled', 'running', 'unknown']);

/**
 * A red default branch, as recorded on a release snapshot.
 *
 * The snapshot is regenerated on a background cadence by the same watcher that
 * writes the release board; this provider never asks the forge itself (see this
 * file's header).
 *
 * ## Only `failure` emits
 *
 * `success` and `running` are self-evident. `unknown` must not emit: an absent
 * signal is not a red branch, and rendering one would be the same lie as an
 * empty feed reading as "nothing is blocked".
 *
 * **`cancelled` does not emit either, and that is a decision.** A cancelled run
 * was stopped before it reached a verdict — a superseding push, a manual
 * cancel, a runner eviction — so it is absence WITH A REASON, the same class as
 * `unknown` rather than the same class as `failure`. Only `failure` is a
 * positive statement that the branch is broken. The next scheduled run resolves
 * a cancellation either way inside the snapshot's own cadence, whereas a row
 * claiming the branch is red when nobody established that is a false alarm the
 * operator has to disprove by hand.
 *
 * `asOf` is the snapshot's own `asOf`, and so is `since`: the snapshot records
 * the STATE, never the transition, so when the failure began is not a fact this
 * file contains. Reporting the observation time understates the age rather than
 * inventing a start.
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

  // Derived from the declared branch rather than hardcoded, so a second branch
  // is a second declaration and not a second constant in trunk.
  const raw = (snapshot as Record<string, unknown>)[`${branch}_ci`];
  if (raw === undefined) {
    // The common case on an install whose watcher does not emit the field yet.
    // Not an error — but never silent, per the seam's rules.
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
