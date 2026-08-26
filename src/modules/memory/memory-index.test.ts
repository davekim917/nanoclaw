import { describe, expect, it } from 'vitest';

import { TOPIC_DIRECTORIES } from './curator-contract.js';
import {
  hookFromContent,
  mergeManagedLinks,
  mergeRootIndexMap,
  renderFolderIndex,
  titleFromStem,
} from './memory-index.js';

// A real root index, shaped like the live ones: OKF frontmatter, a
// hand-written Core Memory section the operator maintains, a Map with
// hand-written entries, and a further hand-written section after it.
const HAND_WRITTEN_ROOT = [
  '---',
  'okf_version: "0.1"',
  '---',
  '',
  '# Memory Index',
  '',
  '## Core Memory',
  '',
  '- The user is Dave Kim and this agent works on Illysium and XZO.',
  '- **DM contents stay in the DM** — never repeated in a channel.',
  '- Verify real code and runtime state before concluding.',
  '',
  '## Map',
  '',
  '- [Memory system definition](system/definition.md) - how this memory works',
  '- [Imported Claude auto-memory](imported/claude-auto/index.md) - legacy durable notes',
  '',
  '## Methods — canonical note per topic',
  '',
  'Read the canonical one first.',
  '',
].join('\n');

const FOLDER_LINKS = [
  { target: 'people/index.md', title: 'People', hook: '2 consolidated concepts' },
  { target: 'domain/index.md', title: 'Domain', hook: '5 consolidated concepts' },
];

describe('root index.md merge', () => {
  // THE regression this must never lose: a regeneration that rebuilt index.md
  // from curator state would drop the operator's Core Memory, which is a
  // worse bug than the stale map it fixes.
  it('preserves every hand-written line — frontmatter, Core Memory, other sections', () => {
    const merged = mergeRootIndexMap(HAND_WRITTEN_ROOT, TOPIC_DIRECTORIES, FOLDER_LINKS);
    for (const line of HAND_WRITTEN_ROOT.split('\n')) {
      if (line.trim() === '') continue;
      expect(merged.split('\n')).toContain(line);
    }
    expect(merged).toContain('okf_version: "0.1"');
    expect(merged).toContain('- The user is Dave Kim and this agent works on Illysium and XZO.');
    expect(merged).toContain('## Methods — canonical note per topic');
    // Core Memory keeps its position ahead of the Map.
    expect(merged.indexOf('## Core Memory')).toBeLessThan(merged.indexOf('## Map'));
  });

  it('adds the folder-index links inside ## Map without touching the hand-written links there', () => {
    const merged = mergeRootIndexMap(HAND_WRITTEN_ROOT, TOPIC_DIRECTORIES, FOLDER_LINKS);
    expect(merged).toContain('- [Memory system definition](system/definition.md) - how this memory works');
    expect(merged).toContain('- [People](people/index.md) - 2 consolidated concepts');
    expect(merged).toContain('- [Domain](domain/index.md) - 5 consolidated concepts');
    const lines = merged.split('\n');
    const map = lines.indexOf('## Map');
    const next = lines.findIndex((line, index) => index > map && line.startsWith('## '));
    expect(lines.slice(map, next).join('\n')).toContain('- [People](people/index.md)');
  });

  it('is idempotent: a second merge over unchanged input produces no diff', () => {
    const once = mergeRootIndexMap(HAND_WRITTEN_ROOT, TOPIC_DIRECTORIES, FOLDER_LINKS);
    expect(mergeRootIndexMap(once, TOPIC_DIRECTORIES, FOLDER_LINKS)).toBe(once);
  });

  it('replaces a stale folder link rather than stacking a second one', () => {
    const once = mergeRootIndexMap(HAND_WRITTEN_ROOT, TOPIC_DIRECTORIES, FOLDER_LINKS);
    const twice = mergeRootIndexMap(once, TOPIC_DIRECTORIES, [
      { target: 'people/index.md', title: 'People', hook: '9 consolidated concepts' },
      { target: 'domain/index.md', title: 'Domain', hook: '5 consolidated concepts' },
    ]);
    expect(twice.match(/\(people\/index\.md\)/g)).toHaveLength(1);
    expect(twice).toContain('- [People](people/index.md) - 9 consolidated concepts');
  });

  it('inserts with the section top-level bullets, never inside a later sub-heading', () => {
    const existing = [
      '## Map',
      '',
      '- [Definition](system/definition.md) - how this works',
      '',
      '### Corrections',
      '',
      '- [A correction](correction-a.md) - what changed',
      '',
      '## Later',
      '',
      'Untouched.',
      '',
    ].join('\n');
    const merged = mergeRootIndexMap(existing, TOPIC_DIRECTORIES, FOLDER_LINKS);
    const lines = merged.split('\n');
    expect(lines.indexOf('- [People](people/index.md) - 2 consolidated concepts')).toBeLessThan(
      lines.indexOf('### Corrections'),
    );
    expect(lines.indexOf('- [Definition](system/definition.md) - how this works')).toBeLessThan(
      lines.indexOf('- [People](people/index.md) - 2 consolidated concepts'),
    );
    expect(merged).toContain('- [A correction](correction-a.md) - what changed');
    expect(merged).toContain('Untouched.');
    expect(lines[lines.indexOf('### Corrections') - 1]).toBe('');
    expect(mergeRootIndexMap(merged, TOPIC_DIRECTORIES, FOLDER_LINKS)).toBe(merged);
  });

  it('creates a ## Map section when the index has none, keeping the rest intact', () => {
    const bare = ['# Memory Index', '', '## Core Memory', '', '- Only this.', ''].join('\n');
    const merged = mergeRootIndexMap(bare, TOPIC_DIRECTORIES, FOLDER_LINKS);
    expect(merged).toContain('- Only this.');
    expect(merged).toContain('## Map');
    expect(merged).toContain('- [People](people/index.md) - 2 consolidated concepts');
    expect(mergeRootIndexMap(merged, TOPIC_DIRECTORIES, FOLDER_LINKS)).toBe(merged);
  });
});

describe('folder index rendering', () => {
  const entries = [
    {
      name: 'alexis-kim.md',
      content: '---\ntype: person\nconsolidated_facts: 4\n---\n\nAlexis Kim runs intern onboarding.\n',
    },
    { name: 'james.md', content: '<!-- consolidated: facts=9 -->\nJames owns the XZO release train.\n' },
  ];
  const owned = new Set(['alexis-kim.md', 'james.md']);
  const present = new Set(['alexis-kim.md', 'james.md', 'roster.md']);

  it('maps owned files, deriving the hook from the lead line under any header shape', () => {
    const rendered = renderFolderIndex('people', entries, owned, present, '');
    expect(rendered).toContain('# People');
    expect(rendered).toContain('- [Alexis Kim](alexis-kim.md) - Alexis Kim runs intern onboarding.');
    // A file the curator has not rewritten yet still yields a real hook.
    expect(rendered).toContain('- [James](james.md) - James owns the XZO release train.');
    expect(rendered).not.toContain('consolidated');
  });

  it('keeps a hand-written link to a human-authored file in the same folder', () => {
    const existing = [
      '# People',
      '',
      'Who we work with.',
      '',
      '- [Roster](roster.md) - hand-maintained roster',
      '',
    ].join('\n');
    const rendered = renderFolderIndex('people', entries, owned, present, existing);
    expect(rendered).toContain('Who we work with.');
    expect(rendered).toContain('- [Roster](roster.md) - hand-maintained roster');
    expect(rendered).toContain('- [James](james.md) - James owns the XZO release train.');
  });

  it('drops the link for a topic file that no longer exists', () => {
    const stale = renderFolderIndex('people', entries, owned, present, '');
    const after = renderFolderIndex(
      'people',
      [entries[0]!],
      new Set(['alexis-kim.md']),
      new Set(['alexis-kim.md', 'roster.md']),
      stale,
    );
    expect(after).not.toContain('james.md');
    expect(after).toContain('alexis-kim.md');
  });

  it('is idempotent over unchanged input', () => {
    const once = renderFolderIndex('people', entries, owned, present, '');
    expect(renderFolderIndex('people', entries, owned, present, once)).toBe(once);
  });
});

describe('merge mechanics', () => {
  it('removes a replaced bullet together with its wrapped continuation lines', () => {
    const existing = [
      '# NanoClaw',
      '',
      '- [Package update runbook](package-updates.md) - the audit:',
      '  permanent holds and their evidence, gates CI enforces that the prompt',
      '  does not mention.',
      '',
    ].join('\n');
    const merged = mergeManagedLinks(existing, '# NanoClaw', (target) => target === 'package-updates.md', [
      { target: 'package-updates.md', title: 'Package update runbook', hook: 'the audit' },
    ]);
    expect(merged).not.toContain('permanent holds and their evidence');
    expect(merged).toContain('- [Package update runbook](package-updates.md) - the audit');
  });

  it('stops at the next heading of the same or a higher level', () => {
    const existing = ['## Map', '', '- [A](a.md)', '', '## Later', '', '- [B](b.md)', ''].join('\n');
    const merged = mergeManagedLinks(existing, '## Map', () => true, []);
    expect(merged).toContain('- [B](b.md)');
    expect(merged).not.toContain('- [A](a.md)');
  });
});

describe('hook and title derivation', () => {
  it('skips headings and bounds the hook at a word boundary', () => {
    const long = `# Heading\n\n${'word '.repeat(60)}\n`;
    const hook = hookFromContent(long, 40);
    expect(hook.length).toBeLessThanOrEqual(41);
    expect(hook.endsWith('…')).toBe(true);
    expect(hook).not.toContain('# Heading');
  });

  it('returns an empty hook for a file with no body', () => {
    expect(hookFromContent('---\ntype: person\n---\n\n', 40)).toBe('');
  });

  it('titles a slug without inventing case for identifiers', () => {
    expect(titleFromStem('xzo-961-depletions')).toBe('Xzo 961 Depletions');
    expect(titleFromStem('domain')).toBe('Domain');
  });
});
