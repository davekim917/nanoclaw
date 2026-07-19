import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildFixtureDockerArgs,
  computeFixtureFingerprint,
  fixtureFilesForGeneration,
  loadFixtureGroundTruth,
  parseFixtureCliArgs,
  scoreFixtureGeneration,
  type FixtureGroundTruth,
  type FixtureOutputs,
} from './verify-graphify-fixture.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const FILES = {
  'src/order-router.ts': 'export function routeOrder() { return submitOrder(); }\n',
  'src/order-service.ts': 'export function submitOrder() { return enqueueOrder(); }\n',
};

const GROUND_TRUTH: FixtureGroundTruth = {
  version: 1,
  generations: [
    {
      id: 'initial',
      fingerprint: computeFixtureFingerprint(
        Object.entries(FILES).map(([path, content]) => ({
          path,
          bytes: Buffer.byteLength(content),
          sha256: sha256(content),
        })),
      ),
      files: Object.entries(FILES).map(([path, content]) => ({
        path,
        bytes: Buffer.byteLength(content),
        sha256: sha256(content),
      })),
      intentionalExclusions: [],
      cases: [
        {
          id: 'query-submit-order',
          command: 'query',
          arguments: ['submitOrder'],
          requiredFacts: ['symbol:submitOrder', 'file:src/order-service.ts'],
          forbiddenFacts: ['symbol:submitOrderBatch', 'file:src/unrelated.ts'],
        },
        {
          id: 'path-route-to-enqueue',
          command: 'path',
          arguments: ['routeOrder', 'enqueueOrder'],
          requiredFacts: [
            'symbol:routeOrder',
            'symbol:submitOrder',
            'symbol:enqueueOrder',
            'edge:routeOrder->submitOrder',
            'edge:submitOrder->enqueueOrder',
          ],
          forbiddenFacts: ['symbol:submitOrderBatch'],
        },
        {
          id: 'explain-submit-order',
          command: 'explain',
          arguments: ['submitOrder'],
          requiredFacts: ['symbol:submitOrder', 'file:src/order-service.ts'],
          forbiddenFacts: ['symbol:submitOrderBatch'],
        },
        {
          id: 'affected-enqueue-order',
          command: 'affected',
          arguments: ['enqueueOrder'],
          requiredFacts: ['symbol:submitOrder', 'symbol:routeOrder'],
          forbiddenFacts: ['symbol:submitOrderBatch'],
        },
        {
          id: 'negative-missing-path',
          command: 'path',
          arguments: ['missingOrder', 'enqueueOrder'],
          requiredFacts: [],
          forbiddenFacts: [],
          expectEmpty: true,
        },
      ],
    },
  ],
};

const VALID_OUTPUTS: FixtureOutputs = {
  'query-submit-order': 'function:submitOrder\tsubmitOrder\tsrc/order-service.ts\n',
  'path-route-to-enqueue': 'routeOrder -> submitOrder -> enqueueOrder\n',
  'explain-submit-order': JSON.stringify({
    node: {
      id: 'function:submitOrder',
      label: 'submitOrder',
      source_file: 'src/order-service.ts',
    },
    connections: [],
  }),
  'affected-enqueue-order': ['function:submitOrder\tsubmitOrder', 'function:routeOrder\trouteOrder'].join('\n'),
  'negative-missing-path': 'No path.\n',
};

describe('Graphify fixture scorer', () => {
  it('test_fixture_scores_all_commands_and_ambiguous_names', () => {
    const passing = scoreFixtureGeneration(GROUND_TRUTH, 'initial', GROUND_TRUTH.generations[0].files, VALID_OUTPUTS);
    expect(passing.passed).toBe(true);
    expect(passing.score).toBe(1);
    expect(passing.cases).toHaveLength(5);

    const overbroad = scoreFixtureGeneration(GROUND_TRUTH, 'initial', GROUND_TRUTH.generations[0].files, {
      ...VALID_OUTPUTS,
      'query-submit-order': [
        VALID_OUTPUTS['query-submit-order'],
        'function:submitOrderBatch\tsubmitOrderBatch\tsrc/unrelated.ts',
      ].join('\n'),
    });
    expect(overbroad.passed).toBe(false);
    expect(overbroad.cases.find((entry) => entry.id === 'query-submit-order')?.forbiddenPresent).toEqual([
      'file:src/unrelated.ts',
      'symbol:submitOrderBatch',
    ]);
  });

  it('test_fixture_detects_stale_or_incomplete_generation', () => {
    const modifiedFiles = GROUND_TRUTH.generations[0].files.map((file) =>
      file.path === 'src/order-service.ts' ? { ...file, bytes: file.bytes + 1, sha256: '0'.repeat(64) } : file,
    );
    const stale = scoreFixtureGeneration(GROUND_TRUTH, 'initial', modifiedFiles, VALID_OUTPUTS);

    expect(stale.passed).toBe(false);
    expect(stale.score).toBe(0);
    expect(stale.generationError).toMatch(/fingerprint/i);
    expect(stale.cases).toEqual([]);
  });

  it('commits exact initial cached modified untracked deleted and data-json generations', () => {
    const fixtureRoot = new URL('../tests/fixtures/graphify-eval/', import.meta.url);
    const groundTruth = loadFixtureGroundTruth(fixtureRoot);

    expect(groundTruth.generations.map((generation) => generation.id)).toEqual([
      'initial',
      'cached',
      'modified',
      'untracked',
      'deleted',
      'data-json',
    ]);
    for (const generation of groundTruth.generations) {
      const files = fixtureFilesForGeneration(fixtureRoot, generation);
      expect(computeFixtureFingerprint(files), generation.id).toBe(generation.fingerprint);
      expect(generation.intentionalExclusions).toEqual(['dataset.json']);
    }
    const commands = new Set(
      groundTruth.generations.flatMap((generation) => generation.cases.map((entry) => entry.command)),
    );
    expect(commands).toEqual(new Set(['query', 'path', 'explain', 'affected']));
    expect(groundTruth.generations.flatMap((generation) => generation.cases).some((entry) => entry.expectEmpty)).toBe(
      true,
    );
  });

  it('drives only the public gateway in an isolated restart-preserving container', () => {
    const args = buildFixtureDockerArgs({
      image: 'candidate:latest',
      worktreesPath: '/tmp/graphify-e1/worktrees',
      cachePath: '/tmp/graphify-e1/cache',
      runtimePath: '/tmp/graphify-e1/runtime',
      repositoryName: 'graphify-eval',
      command: 'path',
      arguments: ['routeOrder', 'validateOrder'],
    });

    expect(args).toContain('NANOCLAW_CONTAINER=1');
    expect(args).toContain('/workspace/.graphify-stage:rw,size=201326592,mode=0700,uid=1001,gid=1001');
    expect(args).toContain('/tmp/graphify-e1/cache:/workspace/.cache/graphify');
    expect(args).toContain('/tmp/graphify-e1/runtime:/run/nanoclaw-graphify');
    expect(args).toContain('/usr/local/bin/graphify');
    expect(args.slice(-4)).toEqual(['candidate:latest', 'path', 'routeOrder', 'validateOrder']);
    expect(args.join(' ')).not.toContain('/home/ubuntu/nanoclaw-v2/data/');
  });

  it('parses an explicit candidate image and rejects replacement evidence inputs', () => {
    expect(parseFixtureCliArgs(['--image', 'candidate:latest', '--fixture', '/tmp/fixture'])).toEqual({
      image: 'candidate:latest',
      fixture: '/tmp/fixture',
    });
    expect(() => parseFixtureCliArgs(['--image', 'candidate:latest', '--outputs', 'hand-picked.json'])).toThrow(
      /unsupported/i,
    );
  });
});
