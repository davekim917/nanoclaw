import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Writes `node_modules/.install-stamp.json` the way the repo's own install tool does after an `npm ci` that ran
 * lifecycle scripts, computed from the package dir independently of `src/dependency-cache.ts`.
 */
export function writeInstallStamp(
  pkgDir: string,
  options: { node?: string; arch?: string; overrides?: Record<string, unknown> } = {},
): void {
  const digest = (file: string): string | null => {
    try {
      return crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(pkgDir, file)))
        .digest('hex');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
  const stamp = {
    v: 1,
    lockSha256: digest('package-lock.json'),
    pkgSha256: digest('package.json'),
    npmrcSha256: digest('.npmrc'),
    node: options.node ?? '22.23.2',
    npm: '10.9.4',
    platform: 'linux',
    arch: options.arch ?? process.arch,
    libc: 'glibc',
    scripts: true,
    writer: 'test',
    at: new Date().toISOString(),
    ...options.overrides,
  };
  fs.writeFileSync(path.join(pkgDir, 'node_modules', '.install-stamp.json'), JSON.stringify(stamp));
}
