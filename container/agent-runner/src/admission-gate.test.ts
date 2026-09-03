/**
 * Acceptance case R-6 for the runner admission-gate seam
 * (docs/specs/upstream-mailbox-seam/plan.md §4.5, §8).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { evaluateAdmission, registerAdmissionGate, resetAdmissionGatesForTesting } from './admission-gate.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';

beforeEach(() => {
  initTestSessionDb();
  resetAdmissionGatesForTesting();
});

afterEach(() => {
  closeSessionDb();
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
});
