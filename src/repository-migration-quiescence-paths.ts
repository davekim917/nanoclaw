import path from 'path';

import { manifestPath, repositoryMigrationPath, type RepositoryMigrationManifest } from './repository-migration.js';
import { repositoryStateRoot } from './repository-workspaces.js';

function contained(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function minimalRoots(paths: readonly string[]): string[] {
  const selected: string[] = [];
  for (const candidate of [...new Set(paths.map((entry) => path.resolve(entry)))].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  )) {
    if (selected.some((root) => contained(candidate, root))) continue;
    selected.push(candidate);
  }
  return selected.sort();
}

export function completedRepositoryQuiescencePaths(manifest: RepositoryMigrationManifest): string[] {
  return minimalRoots([
    repositoryMigrationPath(manifest),
    path.dirname(manifestPath(manifest)),
    path.join(repositoryStateRoot(manifest.dataDir), manifest.workgroupId, manifest.repo),
    ...manifest.captures.flatMap((capture) =>
      [capture.checkoutPath, capture.destinationPath, capture.renamedOldPath].filter((entry): entry is string =>
        Boolean(entry),
      ),
    ),
    ...manifest.objectStores,
    ...Object.values(manifest.renamedObjectStores ?? {}),
  ]);
}
