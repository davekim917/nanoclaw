#!/usr/bin/env node
/**
 * Finding-CLASS churn classifier and reframe gate for the PR review loop.
 *
 * The file-level churn detector (`codex-review.sh churn`) answers "which file
 * keeps coming back". That is the wrong unit when one invariant is missing
 * from a seam: the reviewer finds it at a new call site each round, so the
 * findings hop between files while being the same defect. On PR #291 that ran
 * for 14 rounds — "revalidate after the await", "recheck ownership before
 * archiving", "reject archived sessions in the wake recheck" — eight files,
 * one invariant, and the fix that ended it moved the check into the two write
 * primitives every caller routes through.
 *
 * So this classifies by CLASS instead:
 *
 *   class key = <invariant signature> @ <seam>
 *
 *   invariant signature — the dominant invariant family cited by the finding
 *     (race, ownership, ordering, staleness, lifetime, idempotence,
 *     durability, nullability, bounds), scored over the title (weighted) and
 *     the body. A finding citing none falls back to its title normalized to
 *     its first clause with code identifiers stripped, so the same complaint
 *     at `writeSessionMessage` and at `wakeContainer` still lands in one class.
 *   seam — the module the flagged call sites import in common, read out of
 *     their import statements in the worktree. That is where the shared
 *     callee lives, and it is what the fix has to touch.
 *
 * Grouping is deliberately COARSE. The failure this exists to stop is
 * under-merging: fourteen "different" findings that were one design defect.
 *
 * Commands
 *   review-churn.mjs classify [--json]   payload on stdin  → class table
 *   review-churn.mjs gate     [--json]   payload on stdin  → gate decision,
 *                                        exit 3 = REFRAME REQUIRED
 *
 * Payload (stdin, JSON):
 *   {
 *     "findings": [ { threadId, commentId, reviewId, path, line, body,
 *                     createdAt, isResolved, isOutdated } ],
 *     "repoRoot": "/abs/path",          // for reading sources and git
 *     "sources":  { "src/a.ts": "…" },  // optional; tests pass these so the
 *                                       // classifier never touches the disk
 *     "commits":  [ { sha, date, message, files: [] } ],  // optional; else git
 *     "worktree": [ "src/a.ts" ]        // optional; else git status
 *   }
 *
 * No dependencies, plain ESM: this file is copied into the container skill
 * mirror and runs under node or bun with nothing installed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── invariant vocabulary ────────────────────────────────────────────────────
//
// Families are ordered by priority: when two families score equally the
// earlier one wins, so a class name is stable across rounds instead of
// flipping with the reviewer's wording.
const FAMILIES = [
  [
    'race',
    /\b(?:race|races|racy|toctou|time[-\s]of[-\s]check|check[-\s]then[-\s]act|interleav\w*|concurrent\w*|atomic\w*|revalidat\w*|recheck\w*|re-check\w*|after the await|before awaiting|awaited)\b/gi,
  ],
  [
    'ownership',
    /\b(?:ownership|owner|owned|claims?|claimed|takeover|steals?|stolen|tenant|isolation|authoriz\w*|permission)\b/gi,
  ],
  [
    'ordering',
    /\b(?:ordering|out-of-order|reorder\w*|sequence|happens-before|before invoking|before opening|precedes?|ordered)\b/gi,
  ],
  ['staleness', /\b(?:stale|staleness|outdated|refetch\w*|re-read|reread|cached|snapshots?|frozen)\b/gi],
  ['lifetime', /\b(?:lifetime|lifecycle|freed|disposed|closed|leaks?|leaked|dangling|orphan\w*|after exit)\b/gi],
  ['idempotence', /\b(?:idempoten\w*|duplicates?|duplicated|dedupe\w*|replay\w*|exactly-once|at-least-once|twice)\b/gi],
  [
    'durability',
    /\b(?:rollback|roll back|rolled back|transactions?|transactional|persist\w*|overwrit\w*|clobber\w*|lost update)\b/gi,
  ],
  ['nullability', /\b(?:null|undefined|missing|absent|empty|nonexistent)\b/gi],
  ['bounds', /\b(?:unbounded|overflow|off-by-one|out of range|truncat\w*)\b/gi],
];

const TITLE_WEIGHT = 3;

const STOPWORDS = new Set(
  (
    'a an and are as at be before after by can could do does for from has have in into is it its may must not of on' +
    ' or should that the their then there these this to until when where which while with without would your'
  ).split(/\s+/),
);

// Import specifiers that are never the seam: builtins, the test runner, and
// type-only packages carry no shared write/wake/read primitive.
//
// The `node:` prefix stays an unconditional reject and is NOT delegated to the
// list below: prefix-only builtins (`node:test`, `node:sqlite`, `node:sea`) are
// absent from every runtime's builtin list, and their bare forms — `test`,
// `sqlite` — are ordinary npm package names that must stay eligible.
const SEAM_SPEC_DENY = /^(?:node:|vitest$|bun:|@types\/)/;

// The bare names, as a FROZEN list of Node core specifiers rather than the
// executing runtime's `builtinModules`. The two are not the same set: Bun
// reports its compatibility packages — `undici`, `ws`, `bun` — as builtins, and
// `undici` is a real dependency imported across this repo. Deriving the deny
// set from the runtime therefore made the host and the container disagree about
// the same payload: a three-round class seamed on `undici` refused a push on
// the host and passed inside a container. A gate that answers differently
// depending on who runs it is not a gate.
//
// Node core changes about once a year; a wrong answer here costs a seam
// candidate, not correctness of the round count.
const NODE_BUILTINS = new Set([
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

/**
 * `relative` says the import was written as a path (`./x.js`) and has already
 * been resolved to one, so it is in-repo and always eligible. Everything else
 * is a package specifier, where two rules apply:
 *
 *   - a leading underscore means a Node internal (`_http_agent`,
 *     `_stream_readable`, `_tls_wrap`), because npm forbids package names that
 *     start with `_`. That is a rule rather than more names: enumerating the
 *     `_http_*`, `_stream_*` and `_tls_*` families invites the next omission,
 *     and every one of them would seam a class on something no diff can touch.
 *   - the frozen core list covers the ordinary bare builtins.
 */
function seamCandidate(spec, relative) {
  if (SEAM_SPEC_DENY.test(spec)) return false;
  if (relative) return true;
  if (spec.startsWith('_')) return false;
  return !NODE_BUILTINS.has(spec);
}

// ── finding parsing ─────────────────────────────────────────────────────────

/** Severity as a number (P1 → 1). Null when the badge is absent. */
export function severityOf(body) {
  const m = /badge\/P([0-9])/.exec(body ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * The finding's title: first line, with the severity badge markup and the
 * bold wrapper stripped. Mirrors what `codex-review.sh open` prints, so a
 * class in this table is greppable against that one.
 */
export function titleOf(body) {
  const first = (body ?? '').split('\n')[0] ?? '';
  return first
    .replace(/^[\s\S]*<\/sub>\s*<\/sub>/, '')
    .replace(/^[\s*]+/, '')
    .replace(/[\s*]+$/, '')
    .trim();
}

/**
 * The title reduced to its first clause with every code identifier removed —
 * the fallback class key. Identifiers are what make one invariant look like N
 * findings ("… in `wakeContainer`" vs "… in `writeSessionMessage`"), so they
 * are stripped BEFORE lowercasing, while the casing still marks them.
 */
export function normalizeTitle(title) {
  let t = (title ?? '').split(/\s+[—–]\s+|\s+-\s+|[:;(,]/)[0] ?? '';
  t = t.replace(/`[^`]*`/g, ' ');
  t = t.replace(/[\w./-]+\.(?:ts|tsx|js|mjs|cjs|jsx|sh|md|json|sql|py|db)\b/g, ' ');
  t = t.replace(/\b\w+\(\)/g, ' ');
  t = t.replace(/\b[a-z]+[A-Z]\w*\b/g, ' ');
  t = t.replace(/\b[A-Z][a-z]+[A-Z]\w*\b/g, ' ');
  t = t.replace(/\b\w+_\w+\b/g, ' ');
  const words = (t.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].sort().slice(0, 8).join('-');
}

/** Every invariant family the finding cites, strongest first. */
export function invariantFamilies(finding) {
  const title = titleOf(finding.body);
  const body = finding.body ?? '';
  const order = new Map(FAMILIES.map(([n], i) => [n, i]));
  const scored = [];
  for (const [name, re] of FAMILIES) {
    const inTitle = (title.match(re) ?? []).length;
    const inBody = (body.match(re) ?? []).length;
    const score = inTitle * TITLE_WEIGHT + inBody;
    if (score > 0) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score || order.get(a.name) - order.get(b.name));
  return scored.map((s) => s.name);
}

/** The class signature: dominant family, or the normalized title when none. */
export function signatureOf(finding) {
  const families = invariantFamilies(finding);
  if (families.length > 0) return `inv:${families[0]}`;
  return `title:${normalizeTitle(titleOf(finding.body))}`;
}

// ── seam detection ──────────────────────────────────────────────────────────

/**
 * Import specifiers and their bound names, as written. Deliberately regex, not
 * a parser: this runs with no dependencies inside a container, and an import
 * statement is the one construct regex reads reliably. `[^;'"]*?` spans
 * newlines so multi-line `import { a, b } from '…'` blocks are read whole.
 */
export function importsOf(rawSource) {
  const source = stripSource(rawSource);
  const out = [];
  const push = (spec, clause) => {
    if (!spec) return;
    const names = (clause ?? '')
      .replace(/[{}]/g, ' ')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      // Both sides of an alias: `import { evaluateGate as gate }` binds `gate`,
      // and a finding will say `gate`, but the module exports `evaluateGate`.
      // Substantiation asks whether the findings name something this module
      // provides, so both spellings have to count.
      .flatMap((part) => {
        const m = /^(?:\*\s+as\s+|type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
        if (!m) return [];
        return m[2] ? [m[1], m[2]] : [m[1]];
      });
    out.push({ spec, names });
  };
  for (const m of source.matchAll(/\b(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    push(m[2], m[1]);
  }
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1], '');
  for (const m of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1], '');
  return out;
}

/**
 * Matches a bound name as a whole JavaScript identifier.
 *
 * `\b` is the wrong boundary here: it sits between a word and a non-word
 * character, and `$` is a non-word character, so `\b$guard\b` neither anchors
 * where it looks like it does nor survives being interpolated — `$` is a regex
 * metacharacter. The name is escaped and the boundaries are explicit: no
 * identifier character on either side.
 */
export function identifierMatcher(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
}

/** Relative specifiers resolve to repo-relative paths; `.js` → `.ts` (ESM TS). */
export function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return spec;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return joined.replace(/\.js$/, '.ts');
}

function readSource(file, ctx) {
  if (ctx.sources && Object.prototype.hasOwnProperty.call(ctx.sources, file)) return ctx.sources[file];
  if (!ctx.repoRoot) return null;
  try {
    return fs.readFileSync(path.join(ctx.repoRoot, file), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The seam for a set of flagged files: the module most of them import, with
 * in-repo modules preferred over packages and the number of its bound names
 * mentioned in the findings as the tiebreak. That last term is what picks the
 * module owning `writeSessionMessage` over a logger every file also imports.
 */
export function seamFor(files, findingText, ctx) {
  const bySpec = new Map();
  for (const file of files) {
    const source = readSource(file, ctx);
    if (source == null) continue;
    for (const { spec, names } of importsOf(source)) {
      const resolved = resolveSpec(file, spec);
      if (!seamCandidate(resolved, spec.startsWith('.'))) continue;
      let entry = bySpec.get(resolved);
      if (!entry) {
        entry = { spec: resolved, relative: spec.startsWith('.'), files: new Set(), names: new Map() };
        bySpec.set(resolved, entry);
      }
      entry.files.add(file);
      for (const n of names) entry.names.set(n, (entry.names.get(n) ?? 0) + 1);
    }
  }
  const scored = [...bySpec.values()].map((e) => ({
    spec: e.spec,
    inRepo: e.relative,
    fileCount: e.files.size,
    // Whole identifiers: `get` must not count because a finding said "target",
    // and `$guard` must count when a finding names it.
    mentioned: [...e.names.keys()].filter((n) => identifierMatcher(n).test(findingText)),
    names: [...e.names.keys()],
  }));
  scored.sort(
    (a, b) =>
      b.fileCount - a.fileCount ||
      b.mentioned.length - a.mentioned.length ||
      Number(b.inRepo) - Number(a.inRepo) ||
      a.spec.localeCompare(b.spec),
  );
  // A module nothing shares is not a seam. One flagged file is the exception:
  // its own imports are the only candidates there are.
  const top = scored.find((s) => s.fileCount >= 2 || files.length === 1);
  if (!top) return { seam: null, seamInRepo: false, substantiated: false, primitives: [] };
  const primitives = (top.mentioned.length > 0 ? top.mentioned : top.names).slice(0, 3);
  // Whether the ranking actually had evidence, as opposed to picking the
  // best-ranked import of a single file. Two or more flagged files sharing the
  // module IS the evidence; with one file the only evidence left is that the
  // findings name something the module exports. Neither, and the seam is a
  // guess — reported, never gated. See decideGate.
  const substantiated = top.fileCount >= 2 || top.mentioned.length > 0;
  return { seam: top.spec, seamInRepo: top.inRepo, substantiated, primitives };
}

// ── classification ──────────────────────────────────────────────────────────

function roundKey(f) {
  return f.reviewId ?? `at:${f.createdAt ?? ''}`;
}

function roundsOf(findings) {
  const first = new Map();
  for (const f of findings) {
    const k = roundKey(f);
    const at = f.createdAt ?? '';
    if (!first.has(k) || at < first.get(k)) first.set(k, at);
  }
  return [...first.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k]) => k);
}

function lastAt(findings) {
  return (
    findings
      .map((f) => f.createdAt)
      .filter(Boolean)
      .sort()
      .pop() ?? null
  );
}

/**
 * Severity direction across rounds, per `docs/review-policy.md`: escalation is
 * severity direction, not round count. Falling means the worst severity of the
 * last badged round is strictly less severe than the first's. Fewer than two
 * comparable rounds is NOT falling — an unlabelled run gets the gate, not the
 * benefit of the doubt.
 */
export function severityFalling(findings) {
  const byRound = new Map();
  for (const f of findings) {
    const s = severityOf(f.body);
    if (s == null) continue;
    const k = roundKey(f);
    byRound.set(k, Math.min(byRound.get(k) ?? Infinity, s));
  }
  const order = roundsOf(findings).filter((k) => byRound.has(k));
  if (order.length < 2) return false;
  return byRound.get(order[order.length - 1]) > byRound.get(order[0]);
}

/** Does this file import the module the class settled on as its seam? */
function fileImports(file, seam, ctx) {
  if (!file) return false;
  const source = readSource(file, ctx);
  if (source == null) return false;
  return importsOf(source).some(({ spec }) => resolveSpec(file, spec) === seam);
}

function buildClass(signature, group, derived) {
  const rounds = roundsOf(group);
  return {
    key: `${signature} @ ${derived.seam ?? '-'}`,
    signature,
    seam: derived.seam,
    seamInRepo: derived.seamInRepo,
    seamSubstantiated: derived.substantiated,
    primitives: derived.primitives,
    rounds: rounds.length,
    roundIds: rounds,
    findings: group.length,
    lastAt: lastAt(group),
    severities: group.map((f) => severityOf(f.body)),
    severityFalling: severityFalling(group),
    families: [...new Set(group.flatMap((f) => invariantFamilies(f)))],
    sites: group.map((f) => ({
      file: f.path ?? '(none)',
      line: f.line ?? null,
      title: titleOf(f.body),
      severity: severityOf(f.body),
      threadId: f.threadId ?? null,
      commentId: f.commentId ?? null,
    })),
  };
}

export function classify(payload) {
  const ctx = { repoRoot: payload.repoRoot, sources: payload.sources };
  const findings = (payload.findings ?? []).filter((f) => f && f.body);

  // Pass 1 — group by invariant signature.
  const groups = new Map();
  for (const f of findings) {
    const sig = signatureOf(f);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(f);
  }

  // Pass 2 — partition each signature group by the seam its sites actually
  // share. Three unrelated races at three different seams are three classes,
  // not one fabricated class with an arbitrary seam: the seam is derived from
  // the whole group, so without this split the derived seam would belong to
  // whichever subset happened to dominate, and the gate would refuse work at a
  // primitive that has nothing to do with most of the findings.
  const built = [];
  for (const [signature, group] of groups) {
    let remaining = group;
    while (remaining.length > 0) {
      const files = [...new Set(remaining.map((f) => f.path).filter(Boolean))];
      const text = remaining.map((f) => f.body).join('\n');
      const derived = seamFor(files, text, ctx);
      const members = derived.seam ? remaining.filter((f) => fileImports(f.path, derived.seam, ctx)) : [];
      if (members.length === 0) {
        // Nothing shared: one seamless class holding the rest. It is reported
        // and never gated — see decideGate.
        built.push({
          cls: buildClass(signature, remaining, {
            seam: null,
            seamInRepo: false,
            substantiated: false,
            primitives: [],
          }),
          group: remaining,
        });
        break;
      }
      built.push({ cls: buildClass(signature, members, derived), group: members });
      remaining = remaining.filter((f) => !members.includes(f));
    }
  }

  built.sort(
    (a, b) => b.cls.rounds - a.cls.rounds || b.cls.findings - a.cls.findings || a.cls.key.localeCompare(b.cls.key),
  );

  // Seam rollup — the safety net for a class key that splits. Findings hop
  // wording as well as files; when they keep landing on ONE seam with severity
  // flat, that is the same defect however the titles read.
  const bySeam = new Map();
  for (const b of built) {
    if (!b.cls.seam) continue;
    if (!bySeam.has(b.cls.seam)) bySeam.set(b.cls.seam, []);
    bySeam.get(b.cls.seam).push(b);
  }
  const seams = [...bySeam.entries()]
    .map(([seam, entries]) => {
      const group = entries.flatMap((e) => e.group);
      const rounds = roundsOf(group);
      // The rollup carries its OWN evidence, measured over its own files: two
      // or more flagged files importing the module is the same standard the
      // class-level rule uses, and it is what the rollup exists to see —
      // signature drift across files that share a callee, where no single
      // class can substantiate the seam alone. What it must never do is take
      // one class's naming as evidence for another class's guess, so naming
      // counts only for the class that did the naming.
      const filesOnSeam = new Set(
        [...new Set(group.map((f) => f.path).filter(Boolean))].filter((file) => fileImports(file, seam, ctx)),
      );
      return {
        seam,
        seamInRepo: entries[0].cls.seamInRepo,
        seamSubstantiated: filesOnSeam.size >= 2 || entries.some((e) => e.cls.seamSubstantiated),
        rounds: rounds.length,
        findings: group.length,
        lastAt: lastAt(group),
        classes: entries.map((e) => e.cls.key),
        primitives: [...new Set(entries.flatMap((e) => e.cls.primitives))].slice(0, 3),
        severityFalling: severityFalling(group),
        sites: group.map((f) => ({ file: f.path ?? '(none)', line: f.line ?? null, title: titleOf(f.body) })),
      };
    })
    .sort((a, b) => b.rounds - a.rounds || a.seam.localeCompare(b.seam));

  return {
    classes: built.map((b) => b.cls),
    seams,
    totalRounds: roundsOf(findings).length,
    totalFindings: findings.length,
  };
}

// ── the gate ────────────────────────────────────────────────────────────────

export const CLASS_ROUND_LIMIT = 3;

/**
 * What lifts the gate: a commit that TOUCHES the primitive's module, or one
 * whose message carries the reframe trailer. Both are read only from work done
 * AFTER the class's last finding — an older commit on the seam is not evidence
 * that this round's finding was reframed.
 */
const REFRAME_TRAILER = /^\s*Reframe:\s*(.+?)\s+enforced in\s+(.+?)\s*$/gim;

/** Does the trailer name one of the classifier's candidates for this entry? */
function primitiveNamed(entry, trailer) {
  if (entry.primitives.some((p) => trailer.primitive.includes(p))) return true;
  return Boolean(entry.seam) && trailer.primitive.includes(path.posix.basename(entry.seam).replace(/\.[jt]sx?$/, ''));
}

/** Does the trailer name this entry's invariant? */
function invariantNamed(entry, trailer) {
  const said = trailer.invariant.toLowerCase();
  const tokens = [
    ...(entry.families ?? []),
    ...(entry.signature?.startsWith('title:') ? entry.signature.slice(6).split('-') : []),
  ].filter((t) => t && t.length > 3);
  if (tokens.length === 0) return true;
  return tokens.some((t) => said.includes(t.toLowerCase()));
}

/**
 * Did this commit INTRODUCE a declaration of something the trailer names?
 *
 * Read from the file either side of the commit, never from the diff. A diff
 * hunk is text without context — an added line sitting inside a block comment
 * whose delimiters never changed looks exactly like code — and three rounds of
 * this review went into enumerating the ways a line can fail to be code before
 * the answer turned out to be "ask the file, where the question is decidable".
 *
 * Present in the post-image and absent from the pre-image, both comment- and
 * string-stripped, is precisely "this commit introduced this primitive". A
 * declaration that was already there does not count, which is what stops a site
 * patch from pointing its trailer at an existing helper.
 */
function declaredByCommit(named, commit, ctx) {
  const matchers = (named.match(/[A-Za-z_$][\w$]*/g) ?? []).map(declarationMatcher);
  if (matchers.length === 0) return false;
  for (const file of commit.files ?? []) {
    const after = fileAtCommit(commit, file, 'after', ctx);
    if (after == null) continue;
    const before = fileAtCommit(commit, file, 'before', ctx) ?? '';
    const afterCode = stripSource(after, { strings: true });
    const beforeCode = stripSource(before, { strings: true });
    if (matchers.some((m) => m.test(afterCode) && !m.test(beforeCode))) return true;
  }
  return false;
}

/** A declaration of one identifier, as code. */
function declarationMatcher(id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\b(?:function|class|const|let|var|interface|type|enum)\\s+${escaped}(?![A-Za-z0-9_$])` +
      `|(?<![A-Za-z0-9_$])${escaped}\\s*[:=]\\s*(?:async\\s*)?\\(`,
  );
}

/**
 * One file as it stood before or after a commit. Supplied by the payload in
 * tests; read with `git show` otherwise, and cached, since a trailer usually
 * points at one commit and a handful of files.
 */
function fileAtCommit(commit, file, side, ctx) {
  const supplied = side === 'after' ? commit.after : commit.before;
  if (supplied && Object.prototype.hasOwnProperty.call(supplied, file)) return supplied[file];
  if (!ctx.repoRoot || !commit.sha) return null;
  if (!ctx.blobCache) ctx.blobCache = new Map();
  const key = `${commit.sha}:${side}:${file}`;
  if (ctx.blobCache.has(key)) return ctx.blobCache.get(key);
  const ref = side === 'after' ? commit.sha : `${commit.sha}^`;
  const text = git(ctx.repoRoot, ['show', `${ref}:${file}`]);
  const value = text === '' ? null : text;
  ctx.blobCache.set(key, value);
  return value;
}

/**
 * Source with its comments blanked, line by line, carrying block-comment state
 * across lines — and optionally its string literals too. Every reader of source
 * text goes through this: the import scan, which otherwise reads the
 * `import { a, b } from '…'` example in this file's own header as a real
 * import, and the declaration scan, which otherwise reads a commented-out or
 * quoted `function foo` as declaring one.
 *
 * `strings` is opt-in because the two readers want opposite things: a module
 * specifier IS a string literal, so blanking strings would leave the import
 * scan with no specifier to read at all. Deliberately not a parser — this file
 * ships dependency-free into containers, and the cost of being crude is a seam
 * missed or a lift refused, never one wrongly granted.
 */
export function stripNonCode(lines, { strings = false } = {}) {
  let inBlock = false;
  return lines.map((raw) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return '';
      line = ' '.repeat(end + 2) + line.slice(end + 2);
      inBlock = false;
    }
    // Opening a block that does not close on this line takes the rest of it.
    for (;;) {
      const open = line.indexOf('/*');
      if (open === -1) break;
      const close = line.indexOf('*/', open + 2);
      if (close === -1) {
        line = line.slice(0, open);
        inBlock = true;
        break;
      }
      line = line.slice(0, open) + ' '.repeat(close + 2 - open) + line.slice(close + 2);
    }
    line = line.replace(/\/\/.*$/, ' ');
    if (!strings) return line;
    return line
      .replace(/`[^`]*`/g, ' ')
      .replace(/'[^']*'/g, ' ')
      .replace(/"[^"]*"/g, ' ');
  });
}

function stripSource(source, options) {
  return stripNonCode(source.split('\n'), options).join('\n');
}

function touches(changedFiles, seam, seamInRepo) {
  if (!seam || !seamInRepo) return false;
  const seamBase = seam.replace(/\.[jt]sx?$/, '');
  return changedFiles.some((f) => {
    const base = f.replace(/\.[jt]sx?$/, '');
    return base === seamBase || base.endsWith(`/${seamBase}`) || seamBase.endsWith(`/${base}`);
  });
}

/**
 * Commit dates come back as `%cI`, which carries the committer's UTC offset,
 * while GitHub timestamps are `Z`. Lexicographic comparison across offsets is
 * not chronological (`12:00-07:00` is later than `18:00Z` but sorts earlier),
 * so both sides are parsed to instants. An unparseable date is treated as
 * unknown and kept, the same as a missing one.
 */
function instant(value) {
  const t = Date.parse(value ?? '');
  return Number.isNaN(t) ? null : t;
}

function reframeTrailers(commits) {
  const out = [];
  for (const commit of commits) {
    for (const m of (commit.message ?? '').matchAll(REFRAME_TRAILER)) {
      out.push({ invariant: m[1], primitive: m[2], commit });
    }
  }
  return out;
}

/**
 * Decide the gate. `flagged` entries are the classes (and seams) that have
 * survived CLASS_ROUND_LIMIT rounds without a fix at the primitive.
 *
 *   status 'pass'     nothing flagged, or every flagged entry is lifted
 *   status 'refuse'   flagged and unlifted → exit 3, REFRAME REQUIRED
 *   status 'override' flagged and unlifted, but REVIEW_LOOP_ALLOW_SITE_PATCH=1
 */
export function decideGate(payload, options = {}) {
  const report = classify(payload);
  const ctx = { repoRoot: payload.repoRoot, sources: payload.sources };
  const commits = payload.commits ?? [];
  const worktree = payload.worktree ?? [];

  const flagged = [];
  for (const c of report.classes) {
    // A class whose seam the classifier cannot substantiate is reported, never
    // gated. With no seam there is no primitive to move the check into; with a
    // GUESSED seam — one flagged file, and nothing in the findings naming what
    // that module exports — the refusal names a primitive the fix has no reason
    // to touch, so the only way past is the override. A gate that fires on an
    // unfalsifiable seam drives people to the override, which is the failure it
    // exists to prevent. The class table still shows the row either way.
    if (c.rounds >= CLASS_ROUND_LIMIT && c.seam && c.seamSubstantiated) {
      flagged.push({ kind: 'class', ...c, reason: `${c.rounds} rounds on one finding class` });
    }
  }
  for (const s of report.seams) {
    if (
      s.rounds >= CLASS_ROUND_LIMIT &&
      s.seamSubstantiated &&
      !s.severityFalling &&
      !flagged.some((f) => f.seam === s.seam)
    ) {
      flagged.push({
        kind: 'seam',
        key: `seam ${s.seam}`,
        seam: s.seam,
        seamInRepo: s.seamInRepo,
        seamSubstantiated: s.seamSubstantiated,
        primitives: s.primitives,
        rounds: s.rounds,
        findings: s.findings,
        lastAt: s.lastAt,
        sites: s.sites,
        severityFalling: false,
        reason: `${s.rounds} rounds on one seam with severity not falling`,
      });
    }
  }

  const decided = flagged.map((entry) => {
    const since = instant(entry.lastAt ?? lastAt(payload.findings ?? []));
    const recent = commits.filter((c) => {
      const at = instant(c.date);
      return since === null || at === null || at >= since;
    });
    const changed = [...worktree, ...recent.flatMap((c) => c.files ?? [])];
    const trailers = reframeTrailers(recent);
    // A trailer naming only the primitive is enough while that primitive
    // belongs to one flagged class. When two flagged classes share it —
    // a race AND a durability defect at the same write — one trailer would
    // otherwise clear both, so the trailer must name the invariant too.
    const shared = flagged.some(
      (other) =>
        other !== entry &&
        ((entry.seam && other.seam === entry.seam) || other.primitives.some((p) => entry.primitives.includes(p))),
    );
    const named = trailers.filter((t) => {
      const byCandidate = primitiveNamed(entry, t);
      // The classifier's candidates are a ranking, not a fact, so a trailer
      // also counts when its commit DECLARES the primitive it names. That is
      // the stronger claim — the author overruling the classifier — so it
      // always names the invariant too: without that, one trailer naming a
      // newly declared primitive would clear every flagged class at once,
      // whatever the classifier had guessed their seams to be.
      const byDeclaration = !byCandidate && declaredByCommit(t.primitive, t.commit, ctx);
      if (byDeclaration) return invariantNamed(entry, t);
      return byCandidate && (!shared || invariantNamed(entry, t));
    });
    const touched = touches(changed, entry.seam, entry.seamInRepo);
    return {
      ...entry,
      lifted: touched || named.length > 0,
      liftedBy: touched ? 'diff touches the primitive' : named.length > 0 ? 'reframe trailer' : null,
    };
  });

  // Classes at the limit that are NOT gated, because their seam is a guess.
  // They are the "reported" half of the rule and must appear in the output: a
  // gate that prints "no finding class has reached 3 rounds" while the table
  // holds one is telling the operator something false.
  const gatedSeams = new Set(flagged.map((f) => f.seam).filter(Boolean));
  const reported = report.classes
    .filter(
      (c) =>
        c.rounds >= CLASS_ROUND_LIMIT &&
        !(c.seam && c.seamSubstantiated) &&
        // Its seam may still be gated by the rollup, on evidence the rollup
        // carries. Saying "not gated" beside a refusal naming the same seam
        // would be two answers to one question.
        !(c.seam && gatedSeams.has(c.seam)),
    )
    .map((c) => ({
      key: c.key,
      rounds: c.rounds,
      seam: c.seam,
      reason: c.seam
        ? 'the seam is a guess: one flagged file, and the findings name nothing it exports'
        : 'the sites share no seam',
    }));

  const unlifted = decided.filter((e) => !e.lifted);
  const allow =
    options.allowSitePatch ?? (Boolean(payload.allowSitePatch) || process.env.REVIEW_LOOP_ALLOW_SITE_PATCH === '1');
  const status = unlifted.length === 0 ? 'pass' : allow ? 'override' : 'refuse';
  return { status, flagged: decided, unlifted, reported, report };
}

// ── rendering ───────────────────────────────────────────────────────────────

function worst(severities) {
  const known = severities.filter((s) => s != null);
  return known.length ? `P${Math.min(...known)}` : 'P?';
}

function renderClasses(report) {
  const lines = [`${report.totalFindings} findings across ${report.totalRounds} rounds`, ''];
  for (const c of report.classes) {
    const flag = c.rounds >= CLASS_ROUND_LIMIT ? 'CHURN' : 'ok   ';
    lines.push(
      `${flag}  ${c.rounds} rounds  ${c.findings} findings  worst ${worst(c.severities)}  ${c.key}` +
        (c.primitives.length ? `  primitive(s): ${c.primitives.join(', ')}` : ''),
    );
    for (const s of c.sites) lines.push(`         ${s.file}:${s.line ?? '?'}  ${s.title}`);
  }
  lines.push('');
  for (const s of report.seams) {
    const flag = s.rounds >= CLASS_ROUND_LIMIT && !s.severityFalling ? 'CHURN' : 'ok   ';
    lines.push(
      `${flag}  ${s.rounds} rounds  ${s.findings} findings  seam ${s.seam}  severity ` +
        `${s.severityFalling ? 'falling' : 'not falling'}`,
    );
  }
  return lines.join('\n');
}

function renderGate(decision) {
  const bar = '='.repeat(70);
  const reportedLines = (decision.reported ?? []).map(
    (r) => `  reported, not gated: ${r.key} — ${r.rounds} rounds; ${r.reason}`,
  );
  if (decision.status === 'pass') {
    const n = decision.flagged.length;
    const head =
      n === 0
        ? 'review-loop gate: ok — no finding class is gated.'
        : `review-loop gate: ok — ${n} flagged class(es), each already reframed at the primitive.`;
    return [head, ...reportedLines].join('\n');
  }
  const lines = [
    bar,
    decision.status === 'override' ? 'SITE PATCH OVERRIDE — REFRAME STILL REQUIRED' : 'REFRAME REQUIRED',
    bar,
  ];
  for (const e of decision.unlifted) {
    lines.push(`class: ${e.key}`);
    lines.push(`  ${e.reason}`);
    lines.push('  sites:');
    for (const s of e.sites) lines.push(`    ${s.file}:${s.line ?? '?'}${s.title ? `  ${s.title}` : ''}`);
    lines.push(`  seam: ${e.seam ?? '(none found — name it yourself)'}`);
    lines.push(`  candidate primitive(s): ${e.primitives.length ? e.primitives.join(', ') : '(none found)'}`);
    lines.push('');
  }
  if (decision.status === 'override') {
    lines.push('REVIEW_LOOP_ALLOW_SITE_PATCH=1 is set: the site patch goes through, and');
    lines.push('`codex-review.sh push` records it in the PR body once the push succeeds.');
    lines.push('The class above is still unfixed.');
  } else {
    lines.push('The next commit must move the invariant into the primitive, not patch');
    lines.push('another call site. The gate lifts on a commit whose diff touches that');
    lines.push('primitive, or whose message carries:');
    lines.push('');
    lines.push('    Reframe: <invariant> enforced in <primitive>');
    lines.push('');
    lines.push('Escape hatch (loud, recorded in the PR body): REVIEW_LOOP_ALLOW_SITE_PATCH=1');
  }
  lines.push(...reportedLines);
  lines.push(bar);
  return lines.join('\n');
}

// ── git context (skipped entirely when the payload supplies it) ─────────────

function git(repoRoot, args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return '';
  }
}

const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

function gitContext(payload) {
  const root = payload.repoRoot;
  if (!root) return payload;
  const out = { ...payload };
  if (!out.commits) {
    // Back to the oldest finding on the PR, not a fixed commit count: a
    // reframe that lifted the gate at round 4 must still lift it at round 12,
    // and on a busy branch that commit is long past any `-n` cap.
    const oldest = (payload.findings ?? [])
      .map((f) => f.createdAt)
      .filter(Boolean)
      .sort()[0];
    const window = oldest ? [`--since=${oldest}`] : ['-n', '30'];
    const raw = git(root, [
      'log',
      ...window,
      `--format=${RECORD_SEP}%H${FIELD_SEP}%cI${FIELD_SEP}%B${FIELD_SEP}`,
      '--name-only',
    ]);
    out.commits = raw
      .split(RECORD_SEP)
      .slice(1)
      .map((rec) => {
        const [sha, date, message, names] = rec.split(FIELD_SEP);
        return {
          sha: (sha ?? '').trim(),
          date: (date ?? '').trim(),
          message: message ?? '',
          files: (names ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        };
      });
  }
  if (!out.worktree) {
    out.worktree = git(root, ['status', '--porcelain'])
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .map((l) => (l.includes(' -> ') ? l.split(' -> ')[1] : l));
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv) {
  const cmd = argv[0];
  const json = argv.includes('--json');
  if (cmd !== 'classify' && cmd !== 'gate') {
    process.stderr.write('usage: review-churn.mjs classify|gate [--json]  < payload.json\n');
    return 2;
  }
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (err) {
    process.stderr.write(`review-churn: payload is not JSON (${err.message})\n`);
    return 2;
  }
  if (cmd === 'classify') {
    const report = classify(payload);
    process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderClasses(report)}\n`);
    return 0;
  }
  const decision = decideGate(gitContext(payload), {
    allowSitePatch: argv.includes('--allow-site-patch') ? true : undefined,
  });
  // Human text always goes to stderr so `--json` on stdout stays parseable and
  // the caller can show both.
  process.stderr.write(`${renderGate(decision)}\n`);
  if (json) process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  return decision.status === 'refuse' ? 3 : 0;
}

const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (entry && entry === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`review-churn: ${err?.stack ?? err}\n`);
      process.exit(2);
    },
  );
}
