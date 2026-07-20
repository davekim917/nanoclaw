import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  extractLookml,
  preprocessDiscoveredSource,
  redactHighConfidenceSecrets,
  summarizeDelimited,
  summarizeJson,
} from './extractors.js';

const roots: string[] = [];

function put(relativePath: string, contents: string): { root: string; absolutePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'graphify-extractors-'));
  roots.push(root);
  const absolutePath = join(root, relativePath);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents);
  return { root, absolutePath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('deterministic Graphify adapters', () => {
  test('test_lookml_adapter_links_models_views_measures_and_sql', () => {
    const lookml = [
      'include: "/views/*.view.lkml"',
      'connection: "warehouse"',
      'explore: orders {',
      '  join: customers { sql_on: ${orders.customer_id} = ${customers.id} ;; }',
      '}',
      'view: orders {',
      '  sql_table_name: analytics.orders ;;',
      '  dimension: id { primary_key: yes sql: ${TABLE}.id ;; }',
      '  measure: revenue { type: sum sql: ${TABLE}.revenue ;; }',
      '  derived_table: { sql: select * from raw.order_events ;; }',
      '}',
    ].join('\n');

    const result = extractLookml(lookml, 'models/orders.model.lkml');

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'model', name: 'orders', line: 1 }),
        expect.objectContaining({ type: 'explore', name: 'orders', line: 3 }),
        expect.objectContaining({ type: 'view', name: 'orders', line: 6 }),
        expect.objectContaining({ type: 'dimension', name: 'id', line: 8 }),
        expect.objectContaining({ type: 'measure', name: 'revenue', line: 9 }),
        expect.objectContaining({ type: 'sql_table', name: 'analytics.orders', line: 7 }),
        expect.objectContaining({ type: 'sql_table', name: 'raw.order_events', line: 10 }),
      ]),
    );
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'includes', line: 1 }),
        expect.objectContaining({ type: 'contains', source: expect.stringContaining('view:orders') }),
        expect.objectContaining({ type: 'depends_on', target: expect.stringContaining('sql_table:analytics.orders') }),
        expect.objectContaining({ type: 'joins', target: expect.stringContaining('view:customers') }),
      ]),
    );
  });

  test('test_csv_adapter_bounds_samples_and_infers_types', () => {
    const rows = ['id,active,amount,created_at,name'];
    for (let index = 1; index <= 150; index += 1) {
      rows.push(
        `${index},${index % 2 === 0},${index}.5,2026-07-${String((index % 28) + 1).padStart(2, '0')},Customer ${index}`,
      );
    }

    const result = summarizeDelimited(rows.join('\n'), ',');

    expect(result.headers).toEqual(['id', 'active', 'amount', 'created_at', 'name']);
    expect(result.rowCount).toBe(150);
    expect(result.types).toEqual({
      id: 'integer',
      active: 'boolean',
      amount: 'number',
      created_at: 'date',
      name: 'string',
    });
    expect(result.sampleRows).toHaveLength(100);
    expect(Buffer.byteLength(result.semanticText)).toBeLessThanOrEqual(256 * 1024);
    expect(result.semanticText).not.toContain('Customer 150');
  });

  test('test_json_adapter_summarizes_without_full_payload', () => {
    const payload = {
      account: { id: 42, active: true, tags: ['retail', 'vip'] },
      events: Array.from({ length: 1_000 }, (_, index) => ({
        event_id: index,
        description: `unique-payload-${index}-${'x'.repeat(200)}`,
      })),
    };
    const raw = JSON.stringify(payload);

    const result = summarizeJson(raw);

    expect(result.schema).toMatchObject({ type: 'object' });
    expect(result.semanticText).toContain('account');
    expect(result.semanticText).toContain('events');
    expect(result.semanticText.length).toBeLessThan(raw.length / 10);
    expect(result.semanticText).not.toContain('unique-payload-999');
  });

  test('test_empty_structured_artifact_is_indexed_without_a_parse_failure', async () => {
    const { absolutePath } = put('.mnemon-rollout.json', '');

    const result = await preprocessDiscoveredSource({
      id: 'source-empty-json',
      workgroupId: 'wg',
      relativePath: '.mnemon-rollout.json',
      absolutePath,
      kind: 'structured',
      bytes: 0,
      mtimeMs: Date.now(),
      sha256: createHash('sha256').update('').digest('hex'),
      state: 'pending',
    });

    expect(result).toMatchObject({
      sourceId: 'source-empty-json',
      semanticSegments: [],
      nodes: [],
      edges: [],
      redactionCount: 0,
      metadata: { empty: true },
      binary: false,
    });
  });

  test('test_json_adjacent_artifact_falls_back_to_redacted_plain_text', async () => {
    const contents = '{ "decision": "keep", // operator note\n "token": "sk-proj-abcdefghijklmnopqrstuvwxyz" }';
    const { absolutePath } = put('decision.json', contents);

    const result = await preprocessDiscoveredSource({
      id: 'source-jsonc',
      workgroupId: 'wg',
      relativePath: 'decision.json',
      absolutePath,
      kind: 'structured',
      bytes: Buffer.byteLength(contents),
      mtimeMs: Date.now(),
      sha256: createHash('sha256').update(contents).digest('hex'),
      state: 'pending',
    });

    expect(result.metadata).toMatchObject({ structuredParseFallback: 'plain_text' });
    expect(result.semanticSegments.join('\n')).toContain('operator note');
    expect(result.semanticSegments.join('\n')).not.toContain('sk-proj-');
    expect(result.redactionCount).toBeGreaterThan(0);
  });

  test('test_semantic_preprocessing_redacts_secrets_before_chunking', async () => {
    const contents = [
      '# Deployment decision',
      'Use the production warehouse for the weekly scorecard.',
      '',
      'API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      '',
      '-----BEGIN PRIVATE KEY-----',
      'highly-sensitive-material',
      '-----END PRIVATE KEY-----',
      '',
      '## Evidence',
      'The reconciliation query passed.',
    ].join('\n');
    const { absolutePath } = put('decision.md', contents);

    const direct = redactHighConfidenceSecrets(contents);
    expect(direct.redactionCount).toBe(2);
    expect(direct.text).toContain('Deployment decision');
    expect(direct.text).not.toContain('sk-proj-');
    expect(direct.text).not.toContain('highly-sensitive-material');

    const result = await preprocessDiscoveredSource({
      id: 'source-1',
      workgroupId: 'wg',
      relativePath: 'decision.md',
      absolutePath,
      kind: 'document',
      bytes: Buffer.byteLength(contents),
      mtimeMs: Date.now(),
      sha256: createHash('sha256').update(contents).digest('hex'),
      state: 'pending',
    });

    expect(result.redactionCount).toBe(2);
    expect(result.semanticSegments.length).toBeGreaterThan(0);
    expect(result.semanticSegments.join('\n')).toContain('weekly scorecard');
    expect(result.semanticSegments.join('\n')).not.toContain('sk-proj-');
    expect(result.semanticSegments.join('\n')).not.toContain('highly-sensitive-material');
    expect(result.semanticSegments.length).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(result.semanticSegments.join('\n'))).toBeLessThanOrEqual(256 * 1024);
  });
});
