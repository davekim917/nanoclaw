import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export interface ProtectedArchiveEvidence {
  root: string;
  markerSha256: string;
  stateSha256: string;
  entryCount: number;
}

const GENERATED_DIRECTORIES = new Set([
  'node_modules',
  '.cache',
  '.pnpm-store',
  'dist',
  'build',
  'coverage',
  'allure-results',
  '.next',
  'target',
]);

export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, fs.constants.O_RDONLY);
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function captureProtectedArchive(root: string): ProtectedArchiveEvidence {
  const realRoot = fs.realpathSync(root);
  const records: Array<{
    path: string;
    type: 'directory' | 'file' | 'symlink';
    mode: number;
    size: number;
    sha256?: string;
  }> = [];
  const walk = (directory: string, relativeRoot: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (GENERATED_DIRECTORIES.has(name)) continue;
      const absolute = path.join(directory, name);
      const relative = relativeRoot ? `${relativeRoot}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute, { encoding: 'buffer' });
        records.push({
          path: relative,
          type: 'symlink',
          mode: stat.mode & 0o7777,
          size: target.length,
          sha256: createHash('sha256').update(target).digest('hex'),
        });
      } else if (stat.isDirectory()) {
        records.push({ path: relative, type: 'directory', mode: stat.mode & 0o7777, size: 0 });
        walk(absolute, relative);
      } else if (stat.isFile()) {
        records.push({
          path: relative,
          type: 'file',
          mode: stat.mode & 0o7777,
          size: stat.size,
          sha256: sha256File(absolute),
        });
      } else {
        throw new Error(`protected archive contains a special filesystem entry: ${absolute}`);
      }
    }
  };
  walk(realRoot, '');
  const marker = path.join(realRoot, '.archive-sha');
  const markerStat = fs.lstatSync(marker);
  if (markerStat.isSymbolicLink() || !markerStat.isFile())
    throw new Error(`unsafe protected archive marker: ${marker}`);
  return {
    root: realRoot,
    markerSha256: sha256File(marker),
    stateSha256: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
    entryCount: records.length,
  };
}

export function verifyProtectedArchives(expected: ProtectedArchiveEvidence[]): void {
  for (const archive of expected) {
    const actual = captureProtectedArchive(archive.root);
    if (
      actual.markerSha256 !== archive.markerSha256 ||
      actual.stateSha256 !== archive.stateSha256 ||
      actual.entryCount !== archive.entryCount
    ) {
      throw new Error(`protected non-Git archive changed during repository migration: ${archive.root}`);
    }
  }
}
