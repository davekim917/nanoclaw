import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../../src/test-hermeticity.js';
import { scanComments } from './comments.js';
import { commentFindings, sourceFiles } from './run.js';

enforceHermeticity();

const rules = (source: string, fileName = 'fixture.ts') =>
  scanComments(fileName, source).map((finding) => [finding.line, finding.rule]);

describe('comment scan flags', () => {
  it.each([
    ['a line comment citation', '// see src/router.ts:42\nexport const a = 1;\n', 'file-line-citation'],
    ['a block comment citation', '/* mirrors poll-loop.ts:10-20 */\nexport const a = 1;\n', 'file-line-citation'],
    ['a JSDoc citation', '/**\n * Same rule as core.ts:291.\n */\nexport function a() {}\n', 'file-line-citation'],
    [
      'a path-qualified Dockerfile citation',
      '// pinned at `container/Dockerfile:41`\nexport const a = 1;\n',
      'file-line-citation',
    ],
    ['a bare Makefile citation', '// same flags as Makefile:12\nexport const a = 1;\n', 'file-line-citation'],
    ['an extensionless path citation', '// see .husky/pre-push:30\nexport const a = 1;\n', 'file-line-citation'],
    [
      'a citation at a git revision',
      '// was `ac8582847:src/session-manager.ts:90-92`\nexport const a = 1;\n',
      'file-line-citation',
    ],
    [
      'a citation into another language',
      '// mirrors codex-rs/core/src/role.rs:88\nexport const a = 1;\n',
      'file-line-citation',
    ],
    ['a PR number', 'export const a = 1; // regression from #1144\n', 'pr-history'],
    ['a PR label', '// Added in PR 7 of the seam series.\nexport const a = 1;\n', 'pr-history'],
    ['a comment inside call arguments', 'call(a, /* see b.ts:3 */ c);\n', 'file-line-citation'],
    ['a comment in an empty block', 'if (a) {\n  // see #88\n}\n', 'pr-history'],
    ['a comment inside a template interpolation', 'const t = `x ${/* c.ts:9 */ a} y`;\n', 'file-line-citation'],
    ['an end-of-file comment', 'export const a = 1;\n// moved from old.ts:4\n', 'file-line-citation'],
    ['a knip public tag', '/** @public */\nexport function a() {}\n', 'inline-suppression'],
    ['a knip internal tag', '/** @internal */\nexport function a() {}\n', 'inline-suppression'],
    ['a knip beta tag', '/** @beta */\nexport function a() {}\n', 'inline-suppression'],
    ['a knip alias tag', '/** @alias b */\nexport function a() {}\n', 'inline-suppression'],
    ['a knip lintignore tag', '/** @lintignore */\nexport function a() {}\n', 'inline-suppression'],
    [
      'a suppression tag inside a directive',
      '/* eslint-disable -- @public */\nexport function a() {}\n',
      'inline-suppression',
    ],
    [
      'a jscpd ignore marker',
      '// jscpd:ignore-start\nexport const a = 1;\n// jscpd:ignore-end\n',
      'inline-suppression',
    ],
  ])('%s', (_name, source, rule) => {
    expect(rules(source).map(([, found]) => found)).toContain(rule);
  });

  it('reports every offending line of a multi-line comment at its own line', () => {
    const source = 'export const a = 1;\n/**\n * See x.ts:1.\n * Fixed in #12.\n */\nexport const b = 2;\n';
    expect(rules(source)).toEqual([
      [3, 'file-line-citation'],
      [4, 'pr-history'],
    ]);
  });

  it('reads a comment once even when it is trivia of two tokens', () => {
    expect(rules('const a = 1; // see z.ts:1\nconst b = 2;\n')).toEqual([[1, 'file-line-citation']]);
  });
});

describe('comment scan passes', () => {
  it.each([
    [
      'a lint directive that cites evidence',
      '// eslint-disable-next-line no-console -- see core.ts:12 and #5\nconsole.log(1);\n',
    ],
    ['a type directive', '// @ts-expect-error -- upstream types lag, #44\nconst a: number = "x";\n'],
    ['a formatter directive', '// prettier-ignore\nconst m = [1,0, 0,1];\n'],
    ['a coverage directive', '/* c8 ignore next -- see a.ts:1 */\nconst a = 1;\n'],
    ['a shebang line', '#!/usr/bin/env -S tsx --conditions=a.ts:1 #1234\nexport const a = 1;\n'],
    ['citations inside strings', 'const s = \'see src/router.ts:42 and #1144\';\nconst d = "// b.ts:2";\n'],
    ['citations inside template text', 'const t = `see src/router.ts:42 ${a} and // c.ts:3 #9`;\n'],
    ['citations inside a regex', 'const r = /\\/\\/ d.ts:4 #9/;\n'],
    ['an HTML entity', '// renders &#39; as a quote\nexport const a = 1;\n'],
    ['a host and port', '// listens on localhost:3000 and api.example.com:443\nexport const a = 1;\n'],
    ['an IP and port', '// binds 127.0.0.1:8080 and host.docker.internal:8765\nexport const a = 1;\n'],
    ['a time of day', '// runs daily at 12:30, once at 2026-09-24T09:15Z\nexport const a = 1;\n'],
    [
      'URLs with ports',
      '// GET https://api.example.com:8443/v1 or http://localhost:3000/health\nexport const a = 1;\n',
    ],
    ['an image tag', '// built FROM oven/bun:1.3.14 and node:22\nexport const a = 1;\n'],
    ['a platform id', '// routes telegram:12345 to the agent\nexport const a = 1;\n'],
    ['a ratio after a slash', '// a DM/1:1 conversation\nexport const a = 1;\n'],
    ['an email address', '// ask ops@example.com\nexport const a = 1;\n'],
  ])('%s', (_name, source) => {
    expect(rules(source)).toEqual([]);
  });
});

describe('scanned files', () => {
  it('covers non-test JS and TS source under the roots, skipping tests and fixture directories', () => {
    const root = globalThis.uniqueTmpRoot('hygiene-files');
    const files = {
      'src/a.ts': '// see b.ts:1\n',
      'src/a.test.ts': '// see b.ts:1\n',
      'src/db/transaction-fixtures/f.ts': '// see b.ts:1\n',
      'scripts/tool.mjs': '// fixed in #12\n',
      'scripts/__fixtures__/x.ts': '// see b.ts:1\n',
      'container/agent-runner/src/c.ts': '// see b.ts:1\n',
      'container/agent-runner/src/codex-hooks/__test-fixtures__/d.ts': '// see b.ts:1\n',
      'docs/e.ts': '// see b.ts:1\n',
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    const scanned = sourceFiles(root);
    expect(scanned).toEqual(['container/agent-runner/src/c.ts', 'scripts/tool.mjs', 'src/a.ts']);
    expect(commentFindings(root, scanned).map((finding) => `${finding.kind} ${finding.location}`)).toEqual([
      'file-line-citation container/agent-runner/src/c.ts:1',
      'pr-history scripts/tool.mjs:1',
      'file-line-citation src/a.ts:1',
    ]);
  });
});
