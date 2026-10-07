import fs from 'fs';
import path from 'path';

export const DEPENDENCY_PATHS_FILE = 'container/dependency-paths.json';

type PackageClass = { kind: 'dev' } | { kind: 'runtime' } | { kind: 'live'; paths: string[] };

export interface DependencyPathRegistry {
  livePaths: Record<string, { description: string; tests: string[] }>;
  packages: Record<string, PackageClass>;
}

export function readDependencyPathRegistry(repoRoot: string): DependencyPathRegistry | null {
  const file = path.join(repoRoot, DEPENDENCY_PATHS_FILE);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as DependencyPathRegistry;
}

/** The live paths a change to `name` would touch that have no real-library test, so the change cannot merge. */
export function untestedLivePaths(registry: DependencyPathRegistry, name: string): string[] {
  const cls = registry.packages[name];
  if (cls?.kind !== 'live') return [];
  return cls.paths.filter((id) => registry.livePaths[id]?.tests.length === 0);
}
