import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../../log.js';
import {
  deriveBranchCiItems,
  deriveDefectRegisterItems,
  deriveOpenQuestionItems,
  readBranchCiSource,
  readDefectRegisterSource,
  readOpenQuestionsSource,
} from './desk-attention.js';
import type { AttentionSourceDecl } from '../../attention-sources.js';

/**
 * Every identifier below is a FIXTURE identifier and must stay one.
 * `scripts/check-public-boundary.ts` scans this tree for real Slack channel
 * ids, real repo names and real people; its Slack rule only accepts ids
 * carrying one of a fixed set of synthetic words (`EXAMPLE`, `FIXTURE`,
 * `TEST`, …). Do not paste a live register or questions file in here to "make
 * the test realistic" — the SHAPES are what the code reads, and the shapes are
 * here, written by hand.
 */
const WORKGROUP = 'example-labs';
const CHANNEL_KEY = 'slack:CEXAMPLE001';
const BINDING = { workgroupId: WORKGROUP, channelKey: CHANNEL_KEY };

const GENERATED = '2026-08-16T14:52:24Z';
/** Whole seconds: `fs.utimesSync` takes float seconds and loses sub-ms. */
const MTIME = '2026-08-18T20:20:19.000Z';

/* ─── defect-register ──────────────────────────────────────────────────────── */

/** A register in the exact shape the generator writes. */
const REGISTER = [
  '# Open defect register — Example',
  '',
  `*Generated ${GENERATED} by \`ops/gen-defects.py\`. Do not hand-edit — rerun it.*`,
  '',
  '**5 open findings.** escalated 1 · product-decision 3 · actionable 1',
  '',
  '- **escalated** — the autonomous fix loop stopped.',
  '- **product-decision** — no fix gets written until someone says what correct looks like.',
  '- **actionable** — the real build queue.',
  '',
  '## escalated (1)',
  '',
  '- **[#101](https://github.com/example-org/example-app/issues/101)** · p1 · filed 2026-08-08 · An escalated one',
  '',
  '## product-decision (3)',
  '',
  '- **[#201](https://github.com/example-org/example-app/issues/201)** · p1 · filed 2026-08-08 · A decision is owed',
  '- **[#202](https://github.com/example-org/example-app/issues/202)** · p2 · filed 2026-08-14 · A second decision',
  '- **[#203](https://github.com/example-org/example-app/issues/203)** · p3 · filed 2026-08-15 · A third decision',
  '',
  '## actionable (1)',
  '',
  '- **[#301](https://github.com/example-org/example-app/issues/301)** · p1 · filed 2026-08-09 · Build queue item',
  '',
].join('\n');

describe('deriveDefectRegisterItems', () => {
  it('emits ONLY the product-decision bucket', () => {
    // escalated and actionable are agent work — escalated needs a diagnosis
    // pass, actionable is the build queue. Emitting all three would flood a
    // queue whose entire job is saying what is blocked on the OPERATOR.
    const read = deriveDefectRegisterItems(REGISTER, BINDING);
    expect(read.items.map((i) => i.id)).toEqual([
      'defect:example-org/example-app#201',
      'defect:example-org/example-app#202',
      'defect:example-org/example-app#203',
    ]);
  });

  it('takes asOf from the Generated header', () => {
    expect(deriveDefectRegisterItems(REGISTER, BINDING).asOf).toBe(GENERATED);
  });

  it.each([
    ['no header at all', REGISTER.replace(/^\*Generated.*$/m, '')],
    ['an unparseable header timestamp', REGISTER.replace(GENERATED, 'last Tuesday')],
    ['a naive non-UTC timestamp', REGISTER.replace(GENERATED, '2026-08-16 14:52:24')],
  ])('reports asOf null, and still the items, when the file carries %s', (_why, text) => {
    // Deliberately NOT the file mtime. A hand-edited generated file would then
    // claim a freshness it does not have — and the file's own first line says
    // not to hand-edit it, so that is exactly the case to stay honest about.
    const read = deriveDefectRegisterItems(text, BINDING);
    expect(read.asOf).toBeNull();
    expect(read.items).toHaveLength(3);
  });

  it('skips one malformed line without blanking the bucket', () => {
    const text = REGISTER.replace(
      '- **[#202](https://github.com/example-org/example-app/issues/202)** · p2 · filed 2026-08-14 · A second decision',
      '- **[#202]** something the generator has never written',
    );
    expect(deriveDefectRegisterItems(text, BINDING).items.map((i) => i.id)).toEqual([
      'defect:example-org/example-app#201',
      'defect:example-org/example-app#203',
    ]);
  });

  it('carries the filed date as `since`, widened to the day start', () => {
    expect(deriveDefectRegisterItems(REGISTER, BINDING).items[0]!.since).toBe('2026-08-08T00:00:00Z');
  });

  it('emits a claimNote that satisfies the WAITING_ON_NOTE routing regex (/\\bwaiting on\\b/i)', () => {
    for (const item of deriveDefectRegisterItems(REGISTER, BINDING).items) {
      expect(item.claimNote).toMatch(/\bwaiting on\b/i);
    }
  });

  it('carries the bucket and the priority in the note, and the issue in the next action', () => {
    const first = deriveDefectRegisterItems(REGISTER, BINDING).items[0]!;
    expect(first.claimNote).toBe('waiting on a human: product-decision · p1');
    expect(first.nextAction).toBe('Decide #201');
    expect(first.title).toBe('A decision is owed');
    expect(first.url).toBe('https://github.com/example-org/example-app/issues/201');
  });

  it('namespaces the id by the repo the issue URL names', () => {
    // An issue number and a PR number are DIFFERENT namespaces to this code —
    // the `defect:` prefix plus the repo is what stops a defect ever colliding
    // with a release-board PR item on a bare number.
    const read = deriveDefectRegisterItems(REGISTER, BINDING);
    for (const item of read.items) expect(item.id).toMatch(/^defect:example-org\/example-app#\d+$/);
  });

  it('still emits when the URL is not issue-shaped, with no repo in the id', () => {
    const text = REGISTER.replace(
      'https://github.com/example-org/example-app/issues/201',
      'https://example.invalid/tracker?id=201',
    );
    expect(deriveDefectRegisterItems(text, BINDING).items[0]!.id).toBe('defect:#201');
  });

  it('takes its channel and workgroup from the BINDING, never from the file', () => {
    const read = deriveDefectRegisterItems(REGISTER, {
      workgroupId: 'other-workgroup',
      channelKey: 'discord:123456789012345678:123456789098765432',
    });
    expect(read.items[0]!.workgroupId).toBe('other-workgroup');
    expect(read.items[0]!.channel_key).toBe('discord:123456789012345678:123456789098765432');
  });

  it('emits ownerless rows: sessionCount 0, no participants, no claim owner', () => {
    for (const item of deriveDefectRegisterItems(REGISTER, BINDING).items) {
      expect(item.sessionCount).toBe(0);
      expect(item.participants).toEqual([]);
      expect(item.claimOwner).toBeNull();
      expect(item.claimState).toBe('parked');
    }
  });

  it('emits nothing from a register whose product-decision bucket is empty', () => {
    const text = ['# Register', '', `*Generated ${GENERATED} by \`gen.py\`.*`, '', '## product-decision (0)', ''].join(
      '\n',
    );
    expect(deriveDefectRegisterItems(text, BINDING)).toEqual({ asOf: GENERATED, items: [] });
  });
});

/* ─── open-questions ───────────────────────────────────────────────────────── */

const QUESTIONS = [
  '# Open questions — standing arguments, not dated decisions',
  '',
  '**This file exists so the canvas can stay one screen.** Everything here is',
  'real and unresolved. This preamble is not an item.',
  '',
  '---',
  '',
  '## Process authority — how merges actually get authorized',
  '',
  '- **New pattern, 2026-08-17:** an agent self-merged its own PR under the',
  '  shared login while the reviewer connector was capped, with no gate entry',
  '  and no second reader of any kind recorded anywhere.',
  '',
  '  More narrative, weeks later, appended inline as a second paragraph.',
  '',
  '### A sub-heading that is NOT its own item',
  '',
  '- Detail beneath the sub-heading.',
  '',
  '## Migration hygiene',
  '',
  '- Migration `177` is applied on dev while its own header says "NOT YET APPLIED".',
  '- Migration `178` declares its ordering in prose the CI regex does not read.',
  '',
  '## Seat provisioning',
  '',
].join('\n');

describe('deriveOpenQuestionItems', () => {
  it('emits one item per `##` heading and skips the preamble', () => {
    const read = deriveOpenQuestionItems(QUESTIONS, MTIME, BINDING);
    expect(read.items.map((i) => i.title)).toEqual([
      'Process authority — how merges actually get authorized',
      'Migration hygiene',
      'Seat provisioning',
    ]);
  });

  it('does not treat a `###` sub-heading as its own item', () => {
    const read = deriveOpenQuestionItems(QUESTIONS, MTIME, BINDING);
    expect(read.items.map((i) => i.title)).not.toContain('A sub-heading that is NOT its own item');
  });

  it('takes the note from the opening paragraph only, not the whole section', () => {
    const first = deriveOpenQuestionItems(QUESTIONS, MTIME, BINDING).items[0]!;
    expect(first.claimNote).toMatch(/^waiting on a human: New pattern, 2026-08-17: an agent self-merged/);
    expect(first.claimNote).not.toContain('More narrative, weeks later');
  });

  it('stops at the blank line, not at the truncation cap', () => {
    // The assertion above holds even with a broken paragraph boundary, because
    // the live sections are long enough that the cap hides the bug. This one
    // uses a SHORT first paragraph so only the boundary can keep the rest out.
    const text = ['## A short one', '', 'The opening claim.', '', 'A later paragraph nobody asked for.'].join('\n');
    expect(deriveOpenQuestionItems(text, MTIME, BINDING).items[0]!.claimNote).toBe(
      'waiting on a human: The opening claim.',
    );
  });

  it('truncates a long opening paragraph with an ellipsis', () => {
    const text = ['## A long one', '', 'x'.repeat(400)].join('\n');
    const note = deriveOpenQuestionItems(text, MTIME, BINDING).items[0]!.claimNote!;
    expect(note.endsWith('…')).toBe(true);
    expect(note.length).toBeLessThan(220);
  });

  it('falls back to the heading when a section has no body at all', () => {
    const last = deriveOpenQuestionItems(QUESTIONS, MTIME, BINDING).items.at(-1)!;
    expect(last.claimNote).toBe('waiting on a human: Seat provisioning');
  });

  it('every claimNote satisfies the WAITING_ON_NOTE routing regex (/\\bwaiting on\\b/i)', () => {
    for (const item of deriveOpenQuestionItems(QUESTIONS, MTIME, BINDING).items) {
      expect(item.claimNote).toMatch(/\bwaiting on\b/i);
    }
  });

  it('invents no URL — this document carries no per-section link', () => {
    for (const item of deriveOpenQuestionItems(QUESTIONS, MTIME, BINDING).items) expect(item.url).toBeNull();
  });

  it('uses the file mtime for both asOf and since', () => {
    // Acceptable HERE and not for the defect register: a human writes this
    // file, so when it was last written IS its freshness.
    const read = deriveOpenQuestionItems(QUESTIONS, MTIME, BINDING);
    expect(read.asOf).toBe(MTIME);
    for (const item of read.items) expect(item.since).toBe(MTIME);
  });

  it('leaves `since` unmeasured rather than zero when the mtime is unreadable', () => {
    // §12: an unmeasured value is not a zero. An empty `since` parses to null
    // upstream, which sorts the row last instead of parking it at one end.
    const read = deriveOpenQuestionItems(QUESTIONS, null, BINDING);
    expect(read.asOf).toBeNull();
    expect(read.items[0]!.since).toBe('');
  });

  it('keys the id on the heading text, so a reorder does not churn it', () => {
    const read = deriveOpenQuestionItems(QUESTIONS, MTIME, BINDING);
    expect(read.items.map((i) => i.id)).toEqual([
      'question:process-authority-how-merges-actually-get-authorized',
      'question:migration-hygiene',
      'question:seat-provisioning',
    ]);
  });

  it('disambiguates a repeated heading instead of dropping the second one', () => {
    const text = ['## Seat provisioning', '', 'first', '', '## Seat provisioning', '', 'second'].join('\n');
    const read = deriveOpenQuestionItems(text, MTIME, BINDING);
    expect(read.items.map((i) => i.id)).toEqual(['question:seat-provisioning', 'question:seat-provisioning-2']);
  });

  it('falls back to a positional id when a heading slugifies to nothing', () => {
    const read = deriveOpenQuestionItems(['## ———', '', 'body'].join('\n'), MTIME, BINDING);
    expect(read.items[0]!.id).toBe('question:section-1');
  });

  it('emits nothing but still reports asOf when the file has no sections', () => {
    const read = deriveOpenQuestionItems('# Title only\n\nsome prose\n', MTIME, BINDING);
    expect(read).toEqual({ asOf: MTIME, items: [] });
  });

  it('emits ownerless rows', () => {
    for (const item of deriveOpenQuestionItems(QUESTIONS, MTIME, BINDING).items) {
      expect(item.sessionCount).toBe(0);
      expect(item.participants).toEqual([]);
      expect(item.claimOwner).toBeNull();
      expect(item.claimState).toBe('parked');
    }
  });
});

/* ─── branch-ci ────────────────────────────────────────────────────────────── */

const SNAP_ASOF = '2026-08-23T00:00:45Z';

describe('deriveBranchCiItems', () => {
  it('emits one item when the declared branch is failing', () => {
    const read = deriveBranchCiItems({ asOf: SNAP_ASOF, develop_ci: 'failure' }, 'develop', BINDING);
    expect(read.asOf).toBe(SNAP_ASOF);
    expect(read.items).toEqual([
      {
        id: 'branch-ci:develop',
        channel_key: CHANNEL_KEY,
        title: 'CI is failing on develop',
        url: null,
        workgroupId: WORKGROUP,
        claimState: 'parked',
        claimNote: 'waiting on a human: CI on develop is failing',
        claimOwner: null,
        participants: [],
        sessionCount: 0,
        since: SNAP_ASOF,
        nextAction: 'Fix or revert what broke develop',
      },
    ]);
  });

  it.each([['success'], ['running'], ['cancelled'], ['unknown']])(
    'emits nothing on state %s, while still reporting the snapshot asOf',
    (state) => {
      // `cancelled` is absence WITH A REASON, the same class as `unknown` —
      // a run stopped before a verdict is not a positive statement that the
      // branch is broken, and claiming one would be a false alarm.
      const read = deriveBranchCiItems({ asOf: SNAP_ASOF, develop_ci: state }, 'develop', BINDING);
      expect(read).toEqual({ asOf: SNAP_ASOF, items: [] });
    },
  );

  it('emits nothing when the field is absent — an absent signal is not a red branch', () => {
    const debug = vi.spyOn(log, 'debug').mockImplementation(() => {});
    const read = deriveBranchCiItems({ asOf: SNAP_ASOF }, 'develop', BINDING);
    expect(read).toEqual({ asOf: SNAP_ASOF, items: [] });
    expect(debug).toHaveBeenCalledWith(
      'Branch CI: snapshot carries no CI state for this branch, emitting nothing',
      expect.objectContaining({ branch: 'develop' }),
    );
  });

  it('reads the field key off the DECLARED branch, not a hardcoded one', () => {
    const snapshot = { asOf: SNAP_ASOF, develop_ci: 'success', main_ci: 'failure' };
    expect(deriveBranchCiItems(snapshot, 'develop', BINDING).items).toEqual([]);
    expect(deriveBranchCiItems(snapshot, 'main', BINDING).items.map((i) => i.id)).toEqual(['branch-ci:main']);
  });

  it.each([
    ['a value that is not one of the known states', { asOf: SNAP_ASOF, develop_ci: 'red' }],
    ['a non-string value', { asOf: SNAP_ASOF, develop_ci: 1 }],
  ])('warns and emits nothing on %s', (_why, snapshot) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(deriveBranchCiItems(snapshot, 'develop', BINDING).items).toEqual([]);
    expect(warn).toHaveBeenCalledWith('Branch CI: unrecognised CI state, emitting nothing', expect.anything());
  });

  it.each([
    ['no asOf', { develop_ci: 'failure' }],
    ['a naive non-UTC asOf', { asOf: '2026-08-23 00:00:45', develop_ci: 'failure' }],
    ['an array', [{ asOf: SNAP_ASOF, develop_ci: 'failure' }]],
    ['null', null],
  ])('emits nothing with asOf null when the snapshot carries %s', (_why, snapshot) => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(deriveBranchCiItems(snapshot, 'develop', BINDING)).toEqual({ asOf: null, items: [] });
  });
});

/* ─── IO readers ───────────────────────────────────────────────────────────── */

const tmpdirs: string[] = [];

function groupsRootWith(files: Record<string, string>, workgroup = WORKGROUP): string {
  const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-desk-'));
  tmpdirs.push(groupsRoot);
  const dir = path.join(groupsRoot, workgroup, 'releases');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return groupsRoot;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const DEFECT_DECL: AttentionSourceDecl = {
  kind: 'defect-register',
  root: 'releases',
  channel_key: CHANNEL_KEY,
  file: 'defects.md',
};
const QUESTIONS_DECL: AttentionSourceDecl = {
  kind: 'open-questions',
  root: 'releases',
  channel_key: CHANNEL_KEY,
  file: 'open-questions.md',
};
const CI_DECL: AttentionSourceDecl = {
  kind: 'branch-ci',
  root: 'releases',
  channel_key: CHANNEL_KEY,
  file: 'release-state.json',
  branch: 'develop',
};

describe('readDefectRegisterSource', () => {
  it('reads the declared file under the declared root', () => {
    const groupsRoot = groupsRootWith({ 'defects.md': REGISTER });
    const read = readDefectRegisterSource(DEFECT_DECL, WORKGROUP, Date.now(), { groupsRoot });
    expect(read.asOf).toBe(GENERATED);
    expect(read.items).toHaveLength(3);
  });

  it('warns and emits nothing when the declaration carries no `file`', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const groupsRoot = groupsRootWith({ 'defects.md': REGISTER });
    const { file: _file, ...noFile } = DEFECT_DECL;
    expect(readDefectRegisterSource(noFile, WORKGROUP, Date.now(), { groupsRoot })).toEqual({ asOf: null, items: [] });
    expect(warn).toHaveBeenCalledWith(
      'Defect register: declaration carries no `file`, emitting nothing',
      expect.objectContaining({ workgroupId: WORKGROUP }),
    );
  });

  it('warns and emits nothing when the file is absent', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const groupsRoot = groupsRootWith({});
    expect(readDefectRegisterSource(DEFECT_DECL, WORKGROUP, Date.now(), { groupsRoot })).toEqual({
      asOf: null,
      items: [],
    });
    expect(warn).toHaveBeenCalledWith(
      'Defect register: file absent or escapes the root, emitting nothing',
      expect.objectContaining({ relative: 'defects.md' }),
    );
  });

  it('emits nothing rather than throwing when the workgroup folder does not exist', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-desk-'));
    tmpdirs.push(groupsRoot);
    expect(readDefectRegisterSource(DEFECT_DECL, WORKGROUP, Date.now(), { groupsRoot })).toEqual({
      asOf: null,
      items: [],
    });
  });

  it('reads nothing when the declared FILE is a symlink into another workgroup', () => {
    // The declared root is bind-mounted read-write into the workgroup's own
    // containers, so an agent can replace a leaf with a symlink. Pinning only
    // the root would be a fix that looks complete.
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const groupsRoot = groupsRootWith({ 'defects.md': REGISTER }, 'other-workgroup');
    const own = path.join(groupsRoot, WORKGROUP, 'releases');
    fs.mkdirSync(own, { recursive: true });
    fs.symlinkSync(path.join(groupsRoot, 'other-workgroup', 'releases', 'defects.md'), path.join(own, 'defects.md'));
    expect(readDefectRegisterSource(DEFECT_DECL, WORKGROUP, Date.now(), { groupsRoot })).toEqual({
      asOf: null,
      items: [],
    });
  });

  it('reads nothing when the declared ROOT is a symlink into another workgroup', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const groupsRoot = groupsRootWith({ 'defects.md': REGISTER }, 'other-workgroup');
    const wgDir = path.join(groupsRoot, WORKGROUP);
    fs.mkdirSync(wgDir, { recursive: true });
    fs.symlinkSync(path.join(groupsRoot, 'other-workgroup', 'releases'), path.join(wgDir, 'releases'), 'dir');
    expect(readDefectRegisterSource(DEFECT_DECL, WORKGROUP, Date.now(), { groupsRoot })).toEqual({
      asOf: null,
      items: [],
    });
  });

  it('still reads a file reached through a symlink that stays INSIDE the workgroup', () => {
    // Containment, not "no symlinks".
    const groupsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-desk-'));
    tmpdirs.push(groupsRoot);
    const real = path.join(groupsRoot, WORKGROUP, 'desks', 'ship');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'defects.md'), REGISTER);
    fs.symlinkSync(real, path.join(groupsRoot, WORKGROUP, 'releases'), 'dir');
    expect(readDefectRegisterSource(DEFECT_DECL, WORKGROUP, Date.now(), { groupsRoot }).items).toHaveLength(3);
  });
});

describe('readOpenQuestionsSource', () => {
  it('reads the declared file and derives asOf from its mtime', () => {
    const groupsRoot = groupsRootWith({ 'open-questions.md': QUESTIONS });
    const at = Date.parse(MTIME);
    fs.utimesSync(path.join(groupsRoot, WORKGROUP, 'releases', 'open-questions.md'), at / 1000, at / 1000);
    const read = readOpenQuestionsSource(QUESTIONS_DECL, WORKGROUP, Date.now(), { groupsRoot });
    expect(read.asOf).toBe(MTIME);
    expect(read.items).toHaveLength(3);
  });

  it('warns and emits nothing when the declaration carries no `file`', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const groupsRoot = groupsRootWith({ 'open-questions.md': QUESTIONS });
    const { file: _file, ...noFile } = QUESTIONS_DECL;
    expect(readOpenQuestionsSource(noFile, WORKGROUP, Date.now(), { groupsRoot })).toEqual({ asOf: null, items: [] });
    expect(warn).toHaveBeenCalledWith(
      'Open questions: declaration carries no `file`, emitting nothing',
      expect.objectContaining({ workgroupId: WORKGROUP }),
    );
  });

  it('reads nothing when the declared file symlinks out of the workgroup', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const groupsRoot = groupsRootWith({ 'open-questions.md': QUESTIONS }, 'other-workgroup');
    const own = path.join(groupsRoot, WORKGROUP, 'releases');
    fs.mkdirSync(own, { recursive: true });
    fs.symlinkSync(
      path.join(groupsRoot, 'other-workgroup', 'releases', 'open-questions.md'),
      path.join(own, 'open-questions.md'),
    );
    expect(readOpenQuestionsSource(QUESTIONS_DECL, WORKGROUP, Date.now(), { groupsRoot })).toEqual({
      asOf: null,
      items: [],
    });
  });
});

describe('readBranchCiSource', () => {
  it('emits the item when the snapshot says the declared branch is failing', () => {
    const groupsRoot = groupsRootWith({
      'release-state.json': JSON.stringify({ asOf: SNAP_ASOF, develop_ci: 'failure', items: [] }),
    });
    const read = readBranchCiSource(CI_DECL, WORKGROUP, Date.now(), { groupsRoot });
    expect(read.asOf).toBe(SNAP_ASOF);
    expect(read.items.map((i) => i.id)).toEqual(['branch-ci:develop']);
  });

  it('emits nothing when the snapshot has no CI field yet', () => {
    vi.spyOn(log, 'debug').mockImplementation(() => {});
    const groupsRoot = groupsRootWith({
      'release-state.json': JSON.stringify({ asOf: SNAP_ASOF, items: [] }),
    });
    expect(readBranchCiSource(CI_DECL, WORKGROUP, Date.now(), { groupsRoot }).items).toEqual([]);
  });

  it('warns and emits nothing when the declaration carries no `branch`', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const groupsRoot = groupsRootWith({
      'release-state.json': JSON.stringify({ asOf: SNAP_ASOF, develop_ci: 'failure' }),
    });
    const { branch: _branch, ...noBranch } = CI_DECL;
    expect(readBranchCiSource(noBranch, WORKGROUP, Date.now(), { groupsRoot })).toEqual({ asOf: null, items: [] });
    expect(warn).toHaveBeenCalledWith(
      'Branch CI: declaration carries no `branch`, emitting nothing',
      expect.objectContaining({ workgroupId: WORKGROUP }),
    );
  });

  it('warns and emits nothing when the snapshot is not JSON', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const groupsRoot = groupsRootWith({ 'release-state.json': '{ this is not json' });
    expect(readBranchCiSource(CI_DECL, WORKGROUP, Date.now(), { groupsRoot })).toEqual({ asOf: null, items: [] });
    expect(warn).toHaveBeenCalledWith(
      'Branch CI: snapshot unreadable, emitting nothing',
      expect.objectContaining({ workgroupId: WORKGROUP }),
    );
  });
});
