import { describe, expect, test } from 'bun:test';

import { parseArgv as parseHostArgv } from '../../../../src/cli/parse-argv.js';

import { parseArgv as parseRunnerArgv } from './ncl.js';

const VECTORS = [
  ['groups', 'list'],
  ['groups', 'update', 'group-a', '--json', '--stdin-json', '--enabled'],
  ['tasks', 'create', '--title', 'daily report', '--process-after', '2026-09-05T00:00:00.000Z'],
  ['members', 'add', '--agent-group-id', 'group-a', '--user-id', 'channel:user-a', '--stdin-json'],
  ['secrets', 'intake', '--field', 'a|A', '--field', 'b|B', '--rotate', '--field', 'c|C'],
];

test('a repeated flag keeps every value, in order', () => {
  expect(parseRunnerArgv(['secrets', 'intake', '--field', 'a', '--field', 'b', '--rotate']).args).toEqual({
    field: ['a', 'b'],
    rotate: true,
  });
});

describe('host and container ncl argv parity', () => {
  for (const argv of VECTORS) {
    test(argv.join(' '), () => {
      expect(parseRunnerArgv(argv)).toEqual(parseHostArgv(argv));
    });
  }
});
