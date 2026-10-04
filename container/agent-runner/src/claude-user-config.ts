/**
 * Claude Code keeps `~/.claude.json` in the container's throwaway home but its backups in the group-shared
 * `~/.claude/backups`, so a fresh container's first CLI start prints a "configuration file not found" notice that
 * then heads every crash report's stderr and reads as the cause. A missing file already runs on defaults merged
 * under `{}`, so seeding `{}` changes only the notice.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || env.HOME || os.homedir(), '.claude.json');
}

export function ensureClaudeUserConfig(log: (msg: string) => void, file = claudeUserConfigPath()): void {
  try {
    fs.writeFileSync(file, '{}\n', { flag: 'wx', mode: 0o600 });
    log(`Seeded empty Claude Code user config at ${file}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
    log(`Could not seed ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
