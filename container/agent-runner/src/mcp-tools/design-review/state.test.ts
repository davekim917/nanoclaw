import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readState, writeState, mergeRound, openFindings, decideStatus, recordRound, CAP,
  type TraceState,
} from './state.js';
import type { Finding } from './linter.js';

let base: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'dal-state-')); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

const F = (id: string, severity: Finding['severity'] = 'high'): Finding => ({
  id, severity, locus: id, message: id,
});

describe('state machine — disk-atomic + carry-forward + R9', () => {
  it('test_fresh_id_starts_empty', () => {
    const s = readState('abc', base);
    expect(s.rounds).toHaveLength(0);
    expect(s.finalStatus).toBeNull();
  });

  it('test_atomic_write_no_partial', () => {
    let s = readState('x', base);
    s = mergeRound(s, [F('no-js:0')]);
    writeState(s, base);
    const dir = path.join(base, 'x');
    // no leftover temp/lock, and trace.json is valid JSON
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.') || f.endsWith('.lock'));
    expect(leftovers).toHaveLength(0);
    expect(() => JSON.parse(fs.readFileSync(path.join(dir, 'trace.json'), 'utf-8'))).not.toThrow();
  });

  it('test_roundtrip_persists', () => {
    let s = readState('rt', base);
    s = mergeRound(s, [F('token-trace:#fff')]);
    writeState(s, base);
    const reloaded = readState('rt', base);
    expect(reloaded.rounds).toHaveLength(1);
    expect(reloaded.rounds[0].findings[0].id).toBe('token-trace:#fff');
  });

  it('test_carry_forward_marks_unresolved', () => {
    let s: TraceState = readState('cf', base);
    s = mergeRound(s, [F('font-denylist:Inter', 'medium')]);          // round 1
    s = mergeRound(s, [F('font-denylist:Inter', 'medium')]);          // round 2, still present
    const last = s.rounds[s.rounds.length - 1];
    const inter = last.findings.find((f) => f.id === 'font-denylist:Inter');
    expect(inter!.state).toBe('unresolved');
    // not duplicated within the round
    expect(last.findings.filter((f) => f.id === 'font-denylist:Inter')).toHaveLength(1);
  });

  it('test_resolved_when_absent_next_round', () => {
    let s = readState('rs', base);
    s = mergeRound(s, [F('no-js:0')]);   // round 1
    s = mergeRound(s, []);               // round 2 — fixed
    const last = s.rounds[s.rounds.length - 1];
    expect(last.findings.find((f) => f.id === 'no-js:0')!.state).toBe('resolved');
    expect(openFindings(s)).toHaveLength(0);
  });

  it('test_continue_below_cap_with_open', () => {
    let s = readState('c1', base);
    s = mergeRound(s, [F('no-js:0')]); // round 1, open high
    expect(decideStatus(s)).toBe('continue');
  });

  it('test_critic_found_issue_can_revise_reverify_and_ship', () => {
    // Codex P1 (round 4): the critic round-trip must fit inside the loop — a critic-found HIGH
    // must be fixable and clearable, not deadlock-block at the cap.
    const criticHigh: Finding = { id: 'taste-high:hero', severity: 'high', locus: 'hero', message: 'generic', source: 'critic' };
    const r1 = recordRound('loop', [], base, false);            // render v1, await critic
    expect(r1.status).toBe('continue');
    const r2 = recordRound('loop', [criticHigh], base, true);   // critic reports a HIGH on v1
    expect(r2.status).toBe('continue');
    const r3 = recordRound('loop', [], base, false);            // agent revised v2; critic not re-run yet
    expect(r3.status).toBe('continue');                          // must NOT block — the high is carried, awaiting re-review
    expect(r3.mustFixOpen.map((f) => f.id)).toContain('taste-high:hero');
    const r4 = recordRound('loop', [], base, true);             // fresh critic pass on v2 finds nothing
    expect(r4.status).toBe('shipped-with-disclosures');         // cleared + critic-reviewed → ships
  });

  it('test_cap_blocks_on_open_high', () => {
    let s = readState('cap', base);
    for (let i = 0; i < CAP; i++) s = mergeRound(s, [F('no-js:0')]); // 3 rounds, still open high
    expect(s.rounds[s.rounds.length - 1].round).toBe(CAP);
    expect(decideStatus(s)).toBe('blocked');
  });

  it('test_cap_discloses_medium_only_when_critic_reviewed', () => {
    let s = readState('cap2', base);
    for (let i = 0; i < CAP; i++) s = mergeRound(s, [F('font-denylist:Inter', 'medium')], true);
    expect(decideStatus(s)).toBe('shipped-with-disclosures'); // critic reviewed → disclose
  });

  it('test_cap_blocks_medium_only_without_critic', () => {
    // Codex P2: a medium/low-only run at the cap that the critic never reviewed must NOT
    // ship as a disclosure — the visual critic is the only slop check.
    let s = readState('cap3', base);
    for (let i = 0; i < CAP; i++) s = mergeRound(s, [F('font-denylist:Inter', 'medium')]); // never critiqued
    expect(decideStatus(s)).toBe('blocked');
  });

  it('test_clean_round_requires_critic_before_ship', () => {
    // Codex P1: a clean deterministic lint must NOT auto-ship — the independent visual
    // critic is mandatory and must have reviewed this version first.
    let s = readState('clean', base);
    s = mergeRound(s, []);                       // clean lint/render, critic not yet run
    expect(decideStatus(s)).toBe('continue');    // forced to run the critic
    s = mergeRound(s, [], true);                 // critic reviewed this version, found nothing
    expect(decideStatus(s)).toBe('shipped-with-disclosures');
    expect(openFindings(s)).toHaveLength(0);
  });

  it('test_clean_but_uncritiqued_blocks_at_cap', () => {
    // Codex P1: agent ignored the critic directive for all rounds — at the cap the loop must
    // terminate, but it must NOT ship an artifact the mandatory visual critic never reviewed.
    let s = readState('clean-cap', base);
    for (let i = 0; i < CAP; i++) s = mergeRound(s, []); // clean every round, never critiqued
    expect(s.rounds[s.rounds.length - 1].round).toBe(CAP);
    expect(decideStatus(s)).toBe('blocked');
  });

  it('test_critic_high_stays_open_across_uncritiqued_revision', () => {
    // Codex P1: a critic-sourced HIGH must not silently resolve when the agent revises
    // without re-running the critic.
    const critic: Finding = { id: 'taste-high:hero', severity: 'high', locus: 'hero', message: 'generic', source: 'critic' };
    let s = readState('cc', base);
    s = mergeRound(s, [critic], true);   // round 1: critic reviewed, flagged a high
    s = mergeRound(s, [], false);        // round 2: agent revised, did NOT re-run critic
    const open = openFindings(s);
    expect(open.some((f) => f.id === 'taste-high:hero')).toBe(true); // still open, not dropped
    // round 3: a fresh critic pass omits it ⇒ now it clears
    s = mergeRound(s, [], true);
    expect(openFindings(s).some((f) => f.id === 'taste-high:hero')).toBe(false);
  });

  it('test_deterministic_finding_resolves_normally', () => {
    // a lint/render finding (no source) still resolves by absence — only critic findings are sticky
    let s = readState('det', base);
    s = mergeRound(s, [F('no-js:script')]);
    s = mergeRound(s, []); // fixed
    expect(openFindings(s)).toHaveLength(0);
  });

  it('test_terminal_cap_no_round_past_cap', () => {
    // Codex P2: once a terminal status is recorded, recordRound must not append round 4+.
    for (let i = 0; i < CAP; i++) recordRound('term', [F('no-js:script')], base); // 3 rounds → blocked
    const afterCap = readState('term', base);
    expect(afterCap.finalStatus).toBe('blocked');
    expect(afterCap.rounds).toHaveLength(CAP);
    const r4 = recordRound('term', [F('no-js:script')], base); // further call
    expect(r4.status).toBe('blocked');
    expect(readState('term', base).rounds).toHaveLength(CAP); // still 3 — no round 4 appended
  });

  it('test_recordRound_transactional_carry_forward', () => {
    const r1 = recordRound('rr', [F('no-js:script'), F('font-denylist:Inter', 'medium')], base);
    expect(r1.status).toBe('continue');
    expect(r1.mustFixOpen.map((f) => f.id)).toContain('no-js:script'); // only HIGH in mustFixOpen
    expect(r1.mustFixOpen.map((f) => f.id)).not.toContain('font-denylist:Inter');
    const r2 = recordRound('rr', [F('font-denylist:Inter', 'medium')], base); // script fixed
    expect(r2.mustFixOpen).toHaveLength(0);
    // round 2 persisted on disk via the transactional write
    expect(readState('rr', base).rounds).toHaveLength(2);
    expect(r2.state.rounds[1].findings.find((f) => f.id === 'no-js:script')!.state).toBe('resolved');
  });

  it('test_concurrent_writes_do_not_corrupt', async () => {
    // fire several writes at the same id concurrently; final trace.json must be valid
    const writes = Array.from({ length: 8 }, (_, i) => {
      let s = readState('race', base);
      s = mergeRound(s, [F(`no-js:${i}`)]);
      return Promise.resolve().then(() => writeState(s, base));
    });
    await Promise.all(writes);
    const dir = path.join(base, 'race');
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp.'))).toHaveLength(0);
    expect(() => JSON.parse(fs.readFileSync(path.join(dir, 'trace.json'), 'utf-8'))).not.toThrow();
  });
});
