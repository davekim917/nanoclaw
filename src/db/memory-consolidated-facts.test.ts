import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './index.js';
import { consolidatedFactIds, markFactsConsolidated, pruneConsolidatedFacts } from './memory-consolidated-facts.js';

beforeEach(() => {
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
});

describe('memory_consolidated_facts', () => {
  it('markFactsConsolidated inserts ids idempotently, scoped per workgroup', () => {
    markFactsConsolidated('wg-a', ['mem_a', 'mem_b']);
    markFactsConsolidated('wg-a', ['mem_a']); // re-insert is a no-op (INSERT OR IGNORE)
    markFactsConsolidated('wg-b', ['mem_a']); // same id, different workgroup — independent rows
    expect(consolidatedFactIds('wg-a')).toEqual(new Set(['mem_a', 'mem_b']));
    expect(consolidatedFactIds('wg-b')).toEqual(new Set(['mem_a']));
  });

  // F3: a superseded fact's row must die with it. Fact ids are content-hash
  // derived, so an A→B→A revert — B superseding A, then a later fact
  // re-stating A's exact text — produces the SAME id A had. Without pruning,
  // that id stays permanently marked consolidated even though its line left
  // the ledger for a while; pruning makes it tail-eligible again the moment
  // it's gone, so it re-enters the tail correctly when it comes back.
  it('drops rows for ids no longer in the live ledger, making them tail-eligible again', () => {
    markFactsConsolidated('wg-a', ['mem_a', 'mem_b']);
    pruneConsolidatedFacts('wg-a', new Set(['mem_b'])); // mem_a's line left the ledger
    expect(consolidatedFactIds('wg-a')).toEqual(new Set(['mem_b']));
  });

  it('only prunes the given workgroup', () => {
    markFactsConsolidated('wg-a', ['mem_a']);
    markFactsConsolidated('wg-b', ['mem_a']);
    pruneConsolidatedFacts('wg-a', new Set()); // wg-a's ledger no longer has mem_a at all
    expect(consolidatedFactIds('wg-a')).toEqual(new Set());
    expect(consolidatedFactIds('wg-b')).toEqual(new Set(['mem_a'])); // untouched
  });

  it('is a no-op against an empty table and leaves live ids alone', () => {
    markFactsConsolidated('wg-a', ['mem_a']);
    pruneConsolidatedFacts('wg-a', new Set(['mem_a', 'mem_b'])); // mem_b isn't marked; nothing to prune
    expect(consolidatedFactIds('wg-a')).toEqual(new Set(['mem_a']));
    pruneConsolidatedFacts('wg-empty', new Set());
    expect(consolidatedFactIds('wg-empty')).toEqual(new Set());
  });
});
