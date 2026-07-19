import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CONTAINER_IMAGE, CONTAINER_INSTALL_LABEL, DATA_DIR, GROUPS_DIR } from '../config.js';
import { DEFAULT_GRAPHIFY_SOCKET_PATH } from '../graphify/client.js';
import { GraphifyControlServer } from './control-server.js';
import { WorkgroupGraphDaemon } from './daemon.js';

interface IntegrationManifest {
  package?: { version?: string };
}

export async function main(): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), 'container', 'graphify-integration.json'), 'utf8'),
  ) as IntegrationManifest;
  const version = manifest.package?.version;
  if (!version) throw new Error('Graphify integration manifest does not declare a package version');
  const daemon = new WorkgroupGraphDaemon({
    dataDir: DATA_DIR,
    groupsDir: GROUPS_DIR,
    containerImage: CONTAINER_IMAGE,
    installLabel: CONTAINER_INSTALL_LABEL,
    graphifyVersion: version,
  });
  await daemon.refreshCatalog();
  const control = new GraphifyControlServer(daemon, { socketPath: DEFAULT_GRAPHIFY_SOCKET_PATH });
  await control.start();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await control.close();
      await daemon.close();
    })();
    return closing;
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void close();
    });
  try {
    // start() installs watchers and enqueues the serialized dark backfill; it
    // does not wait for corpus hashing, so the control socket is responsive.
    await daemon.start();
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
