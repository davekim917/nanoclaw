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
import Database from 'better-sqlite3';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateDryRunReport } from '../src/upstream-dry-run-report.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_SOCKET_TIMEOUT_MS = 5_000;

export interface OwnerDm {
  channelType: string;
  platformId: string;
}

type SocketConnector = (socketPath: string) => net.Socket;

/** Resolve the most recently used DM for any user with the owner role. */
export function resolveLatestOwnerDm(dbPath: string): OwnerDm | undefined {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      (db
        .prepare(
          `SELECT mg.platform_id AS platformId, ud.channel_type AS channelType
             FROM user_roles ur
             JOIN user_dms ud ON ud.user_id = ur.user_id
             JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
            WHERE ur.role = 'owner'
            ORDER BY ud.resolved_at DESC
            LIMIT 1`,
        )
        .get() as OwnerDm | undefined) ?? undefined
    );
  } finally {
    db.close();
  }
}

/**
 * Submit a routed system message. The CLI socket has no acknowledgement, so
 * resolving means the payload was submitted to the socket, not delivered.
 */
export async function submitOwnerReport(
  {
    socketPath,
    dm,
    report,
    timeoutMs = CLI_SOCKET_TIMEOUT_MS,
  }: { socketPath: string; dm: OwnerDm; report: string; timeoutMs?: number },
  connectSocket: SocketConnector = (target) => net.createConnection(target),
): Promise<void> {
  const payload =
    JSON.stringify({
      text: `System notification (weekly upstream dry-run): Please relay the following weekly upstream dry-run report to the operator:\n\n${report}`,
      senderId: 'system:upstream-dry-run',
      sender: 'Upstream Dry Run',
      isMention: true,
      to: {
        channelType: dm.channelType,
        platformId: dm.platformId,
        threadId: dm.platformId,
      },
    }) + '\n';

  await new Promise<void>((resolve, reject) => {
    let socket: net.Socket | undefined;
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const timer = setTimeout(
      () =>
        settle(
          new Error(`CLI socket at ${socketPath} timed out after ${timeoutMs}ms while submitting the weekly report.`),
        ),
      timeoutMs,
    );

    try {
      socket = connectSocket(socketPath);
    } catch (err) {
      settle(
        new Error(`CLI socket at ${socketPath} submission failed: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }

    socket.once('error', (err) => settle(new Error(`CLI socket at ${socketPath} submission failed: ${err.message}`)));
    socket.once('connect', () => {
      socket.end(payload, (err?: Error | null) => {
        if (err) {
          settle(new Error(`CLI socket at ${socketPath} submission failed: ${err.message}`));
          return;
        }
        settle();
      });
    });
  });
}

export interface MainDependencies {
  generateReport: typeof generateDryRunReport;
  resolveOwnerDm: typeof resolveLatestOwnerDm;
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
  const resolveOwnerDm = dependencies.resolveOwnerDm ?? resolveLatestOwnerDm;
  const submitReport = dependencies.submitReport ?? submitOwnerReport;
  const report = generateReport({ repoRoot: root });
  console.log(report);

  if (!args.includes('--notify-owner')) return;

  const dbPath = path.join(root, 'data', 'v2.db');
  const dm = resolveOwnerDm(dbPath);
  if (!dm) {
    throw new Error('Cannot notify the owner: no owner DM found through user_roles + user_dms.');
  }

  await submitReport({ socketPath: path.join(root, 'data', 'cli.sock'), dm, report });
  console.log(
    'upstream-dry-run-report: report submitted to the owner DM agent via the CLI socket; delivery is unconfirmed.',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
