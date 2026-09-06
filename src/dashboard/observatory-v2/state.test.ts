import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { SIGNAL_SCHEMA } from '../../db/migrations/072-observatory-signal.js';
import { applyReview, decisionId, decorateReview, digest, readReview } from './state.js';
import type { SignalDecision } from './types.js';

export function source(): SignalDecision {
  return {
    id: decisionId('w', 'release-item', 'r'),
    workgroup_id: 'w',
    project_id: null,
    source_kind: 'release-item',
    source_id: 'r',
    source_as_of: null,
    source_url: null,
    question: 'Which policy?',
    context: 'A real tradeoff',
    next_action: null,
    owner_hint: 'Reviewer One or Reviewer Two',
    owner: null,
    evidence_hash: digest('original'),
    version: 0,
    state: 'open',
    answer: null,
    answered_by: null,
    answered_at: null,
    thread_id: null,
    agent_group_id: null,
    blocks_release: false,
    dispatch_state: 'not_requested',
    dispatch_error: null,
    capabilities: { claim: true, answer: true, dispatch: false },
    history: [],
  };
}
const reviewerOne = { id: 'd', name: 'Reviewer One' };
const reviewerTwo = { id: 'j', name: 'Reviewer Two' };
beforeEach(async () => {
  await initTestDb();
  await getDb().exec('CREATE TABLE workgroups(id TEXT PRIMARY KEY);');
  await getDb().run("INSERT INTO workgroups VALUES ('w')");
  await getDb().exec(SIGNAL_SCHEMA);
});
afterEach(closeDb);
describe('shared Signal review CAS', () => {
  it('allows exactly one simultaneous claimant and leaves one atomic history event', async () => {
    const s = source();
    const request = {
      expected_version: 0,
      evidence_hash: s.evidence_hash,
      action: 'claim' as const,
      idempotency_key: 'k',
    };
    const results = await Promise.allSettled([
      applyReview(s, request, reviewerOne, true),
      applyReview(s, { ...request, idempotency_key: 'j' }, reviewerTwo, false),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const row = await readReview(s.id);
    expect(row?.version).toBe(1);
    expect(JSON.parse(row!.record).history).toHaveLength(1);
  });
  it('replays same request and refuses same key with different body', async () => {
    const s = source();
    const req = {
      expected_version: 0,
      evidence_hash: s.evidence_hash,
      action: 'answer' as const,
      text: 'Choose A',
      idempotency_key: 'k',
    };
    expect((await applyReview(s, req, reviewerOne, true)).version).toBe(1);
    expect((await applyReview(s, req, reviewerOne, true)).version).toBe(1);
    await expect(applyReview(s, { ...req, text: 'Choose B' }, reviewerOne, true)).rejects.toThrow(
      'idempotency_conflict',
    );
  });
  it('preserves answers on timestamp-only refresh, rejects old evidence and retains history after new answer', async () => {
    const s = source();
    await applyReview(
      s,
      { expected_version: 0, evidence_hash: s.evidence_hash, action: 'answer', text: 'A', idempotency_key: 'a' },
      reviewerOne,
      true,
    );
    expect(decorateReview({ ...s, source_as_of: '2099-01-01T00:00:00Z' }, await readReview(s.id)).state).toBe(
      'answered',
    );
    const changed = { ...s, evidence_hash: digest('changed') };
    expect(decorateReview(changed, await readReview(s.id)).state).toBe('changed');
    await expect(
      applyReview(
        changed,
        { expected_version: 1, evidence_hash: s.evidence_hash, action: 'answer', text: 'B', idempotency_key: 'b' },
        reviewerOne,
        true,
      ),
    ).rejects.toThrow('evidence_changed');
    const reviewed = await applyReview(
      changed,
      { expected_version: 1, evidence_hash: changed.evidence_hash, action: 'answer', text: 'B', idempotency_key: 'b' },
      reviewerOne,
      true,
    );
    expect(reviewed.history.map((e) => e.note)).toEqual(['A', 'B']);
  });
  it('does not let an administrator overwrite another reviewer answer', async () => {
    const s = source();
    await applyReview(
      s,
      { expected_version: 0, evidence_hash: s.evidence_hash, action: 'claim', idempotency_key: 'a' },
      reviewerTwo,
      false,
    );
    await expect(
      applyReview(
        s,
        {
          expected_version: 1,
          evidence_hash: s.evidence_hash,
          action: 'answer',
          text: 'override',
          idempotency_key: 'b',
        },
        reviewerOne,
        true,
      ),
    ).rejects.toThrow('owned_by_another');
  });
});
