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
  it('claims once and keeps completed platform events idempotent', async () => {
    expect(await claimChannelIngress(key)).toBe(true);
    expect(await claimChannelIngress(key)).toBe(false);
    await completeChannelIngress(key);
    expect(await claimChannelIngress(key)).toBe(false);
  });

  it('allows retry after a failed or restart-orphaned processing claim', async () => {
    expect(await claimChannelIngress(key)).toBe(true);
    await releaseChannelIngress(key);
    expect(await claimChannelIngress(key)).toBe(true);
    expect(await resetProcessingChannelIngress()).toBe(1);
    expect(await claimChannelIngress(key)).toBe(true);
  });

  it('blocks platform retries while approval is deferred and allows one explicit replay', async () => {
    expect(await claimChannelIngress(key)).toBe(true);
    await deferChannelIngress(key);
    expect(await claimChannelIngress(key)).toBe(false);
    expect(await resetProcessingChannelIngress()).toBe(0);

    expect(await claimDeferredChannelIngress(key)).toBe(true);
    expect(await claimDeferredChannelIngress(key)).toBe(false);
    await completeChannelIngress(key);
    expect(await claimDeferredChannelIngress(key)).toBe(false);
  });

  it('can resolve a denied deferred event without replaying it', async () => {
    expect(await claimChannelIngress(key)).toBe(true);
    await deferChannelIngress(key);
    await completeDeferredChannelIngress(key);
    expect(await claimChannelIngress(key)).toBe(false);
    expect(await claimDeferredChannelIngress(key)).toBe(false);
  });

  it('prunes only completed receipts beyond retention', async () => {
    expect(await claimChannelIngress(key)).toBe(true);
    await completeChannelIngress(key);
    expect(await pruneChannelIngressReceipts(Date.now() + 8 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(await claimChannelIngress(key)).toBe(true);
  });

  it('prunes stale deferred receipts so abandoned approvals do not grow forever', async () => {
    expect(await claimChannelIngress(key)).toBe(true);
    await deferChannelIngress(key);
    expect(await pruneChannelIngressReceipts(Date.now() + 8 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(await claimChannelIngress(key)).toBe(true);
  });
});
