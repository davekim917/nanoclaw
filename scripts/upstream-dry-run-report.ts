#!/usr/bin/env tsx
/**
 * CLI shim — print the weekly upstream dry-run report to stdout, and
 * optionally submit it to the latest owner DM through the CLI socket.
 * Report generation lives in src/upstream-dry-run-report.ts. It fetches
 * upstream and runs `git merge-tree` (in-memory), never `git merge` or
 * checkout. The report is safe to run from the live checkout or any worktree
 * because it always compares origin/main and upstream/main.
 *
 * Usage: pnpm exec tsx scripts/upstream-dry-run-report.ts
 *        pnpm exec tsx scripts/upstream-dry-run-report.ts --notify-owner
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateDryRunReport } from '../src/upstream-dry-run-report.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NCL_SOCKET_CONNECT_TIMEOUT_MS = 5_000;

type SocketConnector = (socketPath: string) => net.Socket;

export interface DeliveryResult {
  messaging_group_id: string;
  channel_type: string;
  platform_id: string;
  instance: string;
  platform_message_id: string | null;
}

class InvalidDeliveryResponseError extends Error {}

function parseDeliveryResult(response: unknown, requestId: string): DeliveryResult {
  if (!response || typeof response !== 'object') {
    throw new InvalidDeliveryResponseError(
      'Host CLI returned a malformed response while delivering the weekly report.',
    );
  }
  const frame = response as Record<string, unknown>;
  if (frame.id !== requestId || typeof frame.ok !== 'boolean') {
    throw new InvalidDeliveryResponseError(
      'Host CLI returned a malformed response while delivering the weekly report.',
    );
  }
  if (!frame.ok) {
    const error = frame.error;
    const message =
      error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
        ? (error as Record<string, unknown>).message
        : 'unknown error';
    throw new InvalidDeliveryResponseError(`Host CLI rejected the weekly report notification: ${message}`);
  }
  if (!frame.data || typeof frame.data !== 'object') {
    throw new InvalidDeliveryResponseError('Host CLI returned no delivery result for the weekly report.');
  }
  const delivered = (frame.data as Record<string, unknown>).delivered;
  const messagingGroupId =
    delivered && typeof delivered === 'object'
      ? (delivered as Record<string, unknown>).messaging_group_id
      : undefined;
  if (typeof messagingGroupId !== 'string' || messagingGroupId.length === 0) {
    throw new InvalidDeliveryResponseError('Host CLI returned an invalid delivery result for the weekly report.');
  }
  return delivered as DeliveryResult;
}

/**
 * Deliver the report through the host-only ncl command and await its result.
 */
export async function submitOwnerReport(
  {
    socketPath,
    report,
    connectionTimeoutMs = NCL_SOCKET_CONNECT_TIMEOUT_MS,
  }: { socketPath: string; report: string; connectionTimeoutMs?: number },
  connectSocket: SocketConnector = (target) => net.createConnection(target),
): Promise<DeliveryResult> {
  const requestId = randomUUID();
  const payload = JSON.stringify({
    id: requestId,
    command: 'messaging-groups-notify-owner',
    args: { text: report },
  });

  return new Promise<DeliveryResult>((resolve, reject) => {
    let socket: net.Socket | undefined;
    let settled = false;
    let submitted = false;
    let buffer = '';
    const settle = (result?: DeliveryResult, err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimer);
      socket?.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(result as DeliveryResult);
      }
    };

    const connectionTimer = setTimeout(
      () =>
        settle(
          undefined,
          new Error(
            `CLI socket at ${socketPath} timed out after ${connectionTimeoutMs}ms while connecting, before submitting the weekly report.`,
          ),
        ),
      connectionTimeoutMs,
    );

    try {
      socket = connectSocket(socketPath);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      settle(undefined, new Error(`CLI socket at ${socketPath} submission failed before connecting: ${err.message}`));
      return;
    }

    socket.once('error', (err) => {
      const phase = submitted
        ? `errored after submitting the weekly report; delivery outcome is unknown: ${err.message}`
        : `submission failed before submitting the weekly report: ${err.message}`;
      settle(undefined, new Error(`CLI socket at ${socketPath} ${phase}`));
    });
    socket.once('close', () => {
      if (!settled) {
        const phase = submitted
          ? 'closed after submitting the weekly report; delivery outcome is unknown.'
          : 'closed before submitting the weekly report.';
        settle(undefined, new Error(`CLI socket at ${socketPath} ${phase}`));
      }
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        settle(parseDeliveryResult(JSON.parse(buffer.slice(0, newline)), requestId));
      } catch (err) {
        if (err instanceof InvalidDeliveryResponseError) {
          settle(undefined, err);
        } else if (err instanceof SyntaxError) {
          settle(
            undefined,
            new Error(`Host CLI returned a malformed response while delivering the weekly report: ${err.message}`),
          );
        } else {
          throw err;
        }
      }
    });
    socket.once('connect', () => {
      if (settled) return;
      clearTimeout(connectionTimer);
      submitted = true;
      socket.write(payload + '\n', (err?: Error | null) => {
        if (err) {
          settle(
            undefined,
            new Error(
              `CLI socket at ${socketPath} write failed after submitting the weekly report; delivery outcome is unknown: ${err.message}`,
            ),
          );
          return;
        }
      });
    });
  });
}

export interface MainDependencies {
  generateReport: typeof generateDryRunReport;
  submitReport: typeof submitOwnerReport;
}

export async function main(
  args = process.argv.slice(2),
  root = repoRoot,
  dependencies: Partial<MainDependencies> = {},
): Promise<void> {
  if (args.some((arg) => arg !== '--notify-owner') || args.filter((arg) => arg === '--notify-owner').length > 1) {
    throw new Error('Usage: pnpm exec tsx scripts/upstream-dry-run-report.ts [--notify-owner]');
  }

  const generateReport = dependencies.generateReport ?? generateDryRunReport;
  const submitReport = dependencies.submitReport ?? submitOwnerReport;
  const report = generateReport({ repoRoot: root });
  console.log(report);

  if (!args.includes('--notify-owner')) return;

  await submitReport({ socketPath: path.join(root, 'data', 'ncl.sock'), report });
  console.log('upstream-dry-run-report: report delivered to the owner DM through the host CLI.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
