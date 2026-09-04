import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, getRawDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import {
  claimChannelIngress,
  claimDeferredChannelIngress,
  completeChannelIngress,
  completeDeferredChannelIngress,
  deferChannelIngress,
  pruneChannelIngressReceipts,
  releaseChannelIngress,
  resetProcessingChannelIngress,
  type ChannelIngressReceiptKey,
} from './channel-ingress-receipts.js';

const key: ChannelIngressReceiptKey = {
  channelType: 'discord',
  instance: 'discord',
  platformId: 'discord:g:c',
  messageId: 'm1',
};

beforeEach(async () => {
  await initTestDb();
  runMigrations(getRawDb());
});

afterEach(() => closeDb());

describe('channel ingress receipts', () => {
  it('claims once and keeps completed platform events idempotent', () => {
    expect(claimChannelIngress(key)).toBe(true);
    expect(claimChannelIngress(key)).toBe(false);
    completeChannelIngress(key);
    expect(claimChannelIngress(key)).toBe(false);
  });

  it('allows retry after a failed or restart-orphaned processing claim', () => {
    expect(claimChannelIngress(key)).toBe(true);
    releaseChannelIngress(key);
    expect(claimChannelIngress(key)).toBe(true);
    expect(resetProcessingChannelIngress()).toBe(1);
    expect(claimChannelIngress(key)).toBe(true);
  });

  it('blocks platform retries while approval is deferred and allows one explicit replay', () => {
    expect(claimChannelIngress(key)).toBe(true);
    deferChannelIngress(key);
    expect(claimChannelIngress(key)).toBe(false);
    expect(resetProcessingChannelIngress()).toBe(0);

    expect(claimDeferredChannelIngress(key)).toBe(true);
    expect(claimDeferredChannelIngress(key)).toBe(false);
    completeChannelIngress(key);
    expect(claimDeferredChannelIngress(key)).toBe(false);
  });

  it('can resolve a denied deferred event without replaying it', () => {
    expect(claimChannelIngress(key)).toBe(true);
    deferChannelIngress(key);
    completeDeferredChannelIngress(key);
    expect(claimChannelIngress(key)).toBe(false);
    expect(claimDeferredChannelIngress(key)).toBe(false);
  });

  it('prunes only completed receipts beyond retention', () => {
    expect(claimChannelIngress(key)).toBe(true);
    completeChannelIngress(key);
    expect(pruneChannelIngressReceipts(Date.now() + 8 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(claimChannelIngress(key)).toBe(true);
  });

  it('prunes stale deferred receipts so abandoned approvals do not grow forever', () => {
    expect(claimChannelIngress(key)).toBe(true);
    deferChannelIngress(key);
    expect(pruneChannelIngressReceipts(Date.now() + 8 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(claimChannelIngress(key)).toBe(true);
  });
});
