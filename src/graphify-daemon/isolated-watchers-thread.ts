import { parentPort } from 'node:worker_threads';
import { basename, resolve } from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import { isGraphifyDefaultExcludedPath } from '../graphify/discovery.js';
import type { GraphifyFilesystemChange, WorkgroupDescriptor } from './types.js';

type Command = { command: 'sync'; descriptors: WorkgroupDescriptor[]; debounceMs: number } | { command: 'close' };

const port = parentPort;
if (!port) throw new Error('Graphify isolated watchers require a parent port');
const watchers = new Map<
  string,
  {
    watcher: FSWatcher;
    debounce?: NodeJS.Timeout;
    changes: Map<string, GraphifyFilesystemChange>;
    fullScan: boolean;
  }
>();
const MAX_INCREMENTAL_CHANGES = 1_000;

async function sync(descriptors: WorkgroupDescriptor[], debounceMs: number): Promise<void> {
  const desired = new Set<string>();
  for (const descriptor of descriptors) {
    for (const root of descriptor.roots) {
      const key = `${descriptor.id}\0${root.absolutePath}`;
      desired.add(key);
      if (watchers.has(key)) continue;
      const entry: {
        watcher: FSWatcher;
        debounce?: NodeJS.Timeout;
        changes: Map<string, GraphifyFilesystemChange>;
        fullScan: boolean;
      } = {
        watcher: chokidar.watch(root.absolutePath, {
          ignoreInitial: true,
          followSymlinks: false,
          awaitWriteFinish: false,
          ignored: (candidate) => isGraphifyDefaultExcludedPath(root.absolutePath, candidate),
        }),
        changes: new Map(),
        fullScan: false,
      };
      entry.watcher.on('all', (event, candidate) => {
        const path = resolve(root.absolutePath, candidate);
        if (basename(path) === '.graphifyignore' || event === 'unlinkDir') {
          entry.fullScan = true;
          entry.changes.clear();
        } else if (event === 'add' || event === 'change' || event === 'unlink') {
          entry.changes.set(path, { root: root.absolutePath, path, kind: event });
          if (entry.changes.size > MAX_INCREMENTAL_CHANGES) {
            entry.fullScan = true;
            entry.changes.clear();
          }
        } else {
          return;
        }
        if (entry.debounce) clearTimeout(entry.debounce);
        entry.debounce = setTimeout(() => {
          port!.postMessage({
            event: 'dirty',
            workgroupId: descriptor.id,
            changes: [...entry.changes.values()],
            fullScan: entry.fullScan,
          });
          entry.changes.clear();
          entry.fullScan = false;
        }, debounceMs);
        entry.debounce.unref();
      });
      entry.watcher.on('error', (error) =>
        port!.postMessage({
          event: 'error',
          workgroupId: descriptor.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      watchers.set(key, entry);
    }
  }
  for (const [key, entry] of watchers) {
    if (desired.has(key)) continue;
    if (entry.debounce) clearTimeout(entry.debounce);
    await entry.watcher.close();
    watchers.delete(key);
  }
}

port.on('message', (message: Command) => {
  if (message.command === 'sync') {
    void sync(message.descriptors, message.debounceMs)
      .then(() => port.postMessage({ event: 'synced' }))
      .catch((error: unknown) =>
        port.postMessage({ event: 'fatal', error: error instanceof Error ? error.message : String(error) }),
      );
    return;
  }
  void Promise.all(
    [...watchers.values()].map(async (entry) => {
      if (entry.debounce) clearTimeout(entry.debounce);
      await entry.watcher.close();
    }),
  ).finally(() => {
    watchers.clear();
    port.postMessage({ event: 'closed' });
  });
});
