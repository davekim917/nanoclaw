/**
 * Acceptance cases R-6 and R-7 for the runner admission-gate seam
 * (docs/specs/upstream-mailbox-seam/plan.md §4.5, §8).
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { evaluateAdmission, registerAdmissionGate, resetAdmissionGatesForTesting } from './admission-gate.js';
import { getAgentMailbox } from './mailbox/index.js';
import { getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { repositoryFenceAdmissionGate } from './modules/mailbox/admission.js';
import type { NanoclawMailboxOperations } from './modules/mailbox/index.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';

const ACK_KEY = 'repository_mount_barrier_ack';
const SENTINEL = '1970-01-01T00:00:00.000Z';

function ackRow(): { value: string; updated_at: string } | null {
  return getOutboundDb().prepare('SELECT value, updated_at FROM session_state WHERE key = ?').get(ACK_KEY) as {
    value: string;
    updated_at: string;
  } | null;
}

function activateFence(epoch: string, generation: string): void {
  getInboundDb()
    .prepare("INSERT INTO repo_ingress_fence (id, epoch, generation, state) VALUES (1, ?, ?, 'active')")
    .run(epoch, generation);
}

beforeEach(() => {
  initTestSessionDb();
  resetAdmissionGatesForTesting();
});

afterEach(() => {
  closeSessionDb();
});

// The fence gate registers itself when modules/mailbox loads. resetAdmissionGatesForTesting()
// above drops it, so restore the production registration for any test file that runs after
// this one in the same bun process.
afterAll(() => {
  resetAdmissionGatesForTesting();
  registerAdmissionGate(repositoryFenceAdmissionGate);
});

describe('admission gate', () => {
  test('evaluateAdmission runs every registered gate and holds when any holds', () => {
    expect(evaluateAdmission()).toBe(false);

    let secondCalls = 0;
    registerAdmissionGate(() => true);
    registerAdmissionGate(() => {
      secondCalls += 1;
      return false;
    });

    expect(evaluateAdmission()).toBe(true);
    expect(secondCalls).toBe(1);

    // A throwing gate is not holding, is reported once per distinct message, and
    // never stops the gates registered after it from running.
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      resetAdmissionGatesForTesting();
      let thirdCalls = 0;
      registerAdmissionGate(() => {
        throw new Error('gate exploded');
      });
      registerAdmissionGate(() => {
        thirdCalls += 1;
        return false;
      });

      expect(evaluateAdmission()).toBe(false);
      expect(thirdCalls).toBe(1);
      expect(errors.mock.calls.length).toBe(1);

      expect(evaluateAdmission()).toBe(false);
      expect(thirdCalls).toBe(2);
      expect(errors.mock.calls.length).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });

  test('the fence gate publishes the exact [epoch, generation] token only from the idle boundary', async () => {
    await getAgentMailbox().start(null);
    const operations = getAgentMailbox().operations as NanoclawMailboxOperations;
    const token = JSON.stringify(['epoch-r7', 'gen-r7']);

    activateFence('epoch-r7', 'gen-r7');

    // Selection alone never publishes the acknowledgement (R-5 holds here too).
    expect(operations.getPendingMessages(10, false)).toEqual([]);
    expect(ackRow()).toBeNull();

    registerAdmissionGate(repositoryFenceAdmissionGate);
    expect(evaluateAdmission()).toBe(true);
    expect(ackRow()).toEqual({ value: token, updated_at: expect.any(String) });

    // A second evaluation of the same token is idempotent — no rewrite.
    getOutboundDb().prepare('UPDATE session_state SET updated_at = ? WHERE key = ?').run(SENTINEL, ACK_KEY);
    expect(evaluateAdmission()).toBe(true);
    expect(ackRow()).toEqual({ value: token, updated_at: SENTINEL });

    // A new generation republishes.
    getInboundDb().prepare("UPDATE repo_ingress_fence SET generation = 'gen-r7b' WHERE id = 1").run();
    expect(evaluateAdmission()).toBe(true);
    expect(ackRow()?.value).toBe(JSON.stringify(['epoch-r7', 'gen-r7b']));

    // Released fence releases admission and re-admits selection.
    getInboundDb().prepare("UPDATE repo_ingress_fence SET state = 'released' WHERE id = 1").run();
    expect(evaluateAdmission()).toBe(false);
  });

  // Round 1 (Codex P2): the seam's fail-open catch is right for an optional
  // observer and wrong for this gate. The loop's late re-checks run after
  // selection has already produced a batch, so a swallowed read error there
  // would admit a turn under an active fence with nothing left to stop it.
  test('the fence gate holds when the barrier read fails, and reports it once', () => {
    // A fence table the read cannot understand: 'no such table' is a legitimate
    // pre-fence session DB and returns null, but 'no such column' rethrows.
    getInboundDb().exec('DROP TABLE repo_ingress_fence');
    getInboundDb().exec('CREATE TABLE repo_ingress_fence (id INTEGER PRIMARY KEY)');

    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      registerAdmissionGate(repositoryFenceAdmissionGate);
      expect(evaluateAdmission()).toBe(true);
      expect(evaluateAdmission()).toBe(true);
      expect(errors.mock.calls.length).toBe(1);
      // The gate absorbed it — the seam never saw a throwing gate.
      expect(String(errors.mock.calls[0][0])).toContain('[admission] repository fence read failed');
      expect(ackRow()).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });
});
