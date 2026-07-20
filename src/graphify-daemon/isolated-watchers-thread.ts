import { parentPort } from 'node:worker_threads';

import chokidar, { type FSWatcher } from 'chokidar';

import { isGraphifyDefaultExcludedPath } from '../graphify/discovery.js';
import type { WorkgroupDescriptor } from './types.js';

type Command = { command: 'sync'; descriptors: WorkgroupDescriptor[]; debounceMs: number } | { command: 'close' };

const port = parentPort;
if (!port) throw new Error('Graphify isolated watchers require a parent port');
const watchers = new Map<string, { watcher: FSWatcher; debounce?: NodeJS.Timeout }>();

async function sync(descriptors: WorkgroupDescriptor[], debounceMs: number): Promise<void> {
  const desired = new Set<string>();
  for (const descriptor of descriptors) {
    for (const root of descriptor.roots) {
      const key = `${descriptor.id}\0${root.absolutePath}`;
      desired.add(key);
      if (watchers.has(key)) continue;
      const entry: { watcher: FSWatcher; debounce?: NodeJS.Timeout } = {
        watcher: chokidar.watch(root.absolutePath, {
          ignoreInitial: true,
          followSymlinks: false,
          awaitWriteFinish: false,
          ignored: (candidate) => isGraphifyDefaultExcludedPath(root.absolutePath, candidate),
        }),
      };
      entry.watcher.on('all', () => {
        if (entry.debounce) clearTimeout(entry.debounce);
        entry.debounce = setTimeout(
          () => port!.postMessage({ event: 'dirty', workgroupId: descriptor.id }),
          debounceMs,
        );
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
