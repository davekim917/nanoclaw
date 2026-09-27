/**
 * Sole reader/writer for a container `config.toml`. Every writer rewrites the file from what it read, so
 * `[hooks.state.*] trusted_hash` (without it Codex never dispatches the guard chain) and `[plugins.*]` /
 * `[marketplaces.*]` vanish silently unless reads keep ENOENT apart from failure and commits are atomic.
 */
import fs from 'fs';
import path from 'path';

function log(msg: string): void {
  console.error(`[codex-config-file] ${msg}`);
}

/** Only ENOENT is an empty base: callers rewrite the file from what they read, so a failed read must throw. */
export function readCodexConfigToml(configPath: string): string {
  try {
    return fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
    const detail = err instanceof Error ? err.message : String(err);
    log(`FAILED to read ${configPath} — refusing to rewrite it from an empty base: ${detail}`);
    throw new Error(`could not read Codex config at ${configPath}: ${detail}`);
  }
}

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Not every filesystem allows fsync on a directory; the rename has already happened.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing left to do */
      }
    }
  }
}

/**
 * `render` gets the current contents ('' only when absent, or always with `readBase: false`); a throwing renderer
 * writes nothing. A symlinked config.toml is replaced rather than written through, and a leftover
 * `config.toml.tmp` directory blocks every write until removed by hand.
 */
export function writeCodexConfigToml(
  configPath: string,
  render: (base: string) => string,
  opts?: { readBase?: boolean },
): void {
  const base = opts?.readBase === false ? '' : readCodexConfigToml(configPath);
  const next = render(base);

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  // Sibling of the target, so the rename below stays within one filesystem.
  const tmpPath = `${configPath}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, next);
    fs.fsyncSync(fd);
    // Cleared before the close: close(2) frees the fd even on error, so a second close could hit a reused fd.
    const toClose = fd;
    fd = undefined;
    fs.closeSync(toClose);
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the open succeeded but a later step failed; nothing left to do */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* never created, or already gone */
    }
    const detail = err instanceof Error ? err.message : String(err);
    log(`FAILED to commit ${configPath} — the previous configuration is left standing: ${detail}`);
    throw new Error(`could not write Codex config at ${configPath}: ${detail}`);
  }
  fsyncDir(dir);
}

/** Checks `requiredSubstrings` against the bytes on disk after the rename, not against the rendered text. */
export function writeCodexConfigTomlAsserting(
  configPath: string,
  render: (base: string) => string,
  requiredSubstrings: readonly string[],
): void {
  writeCodexConfigToml(configPath, render);
  if (requiredSubstrings.length === 0) return;
  const committed = readCodexConfigToml(configPath);
  const missing = requiredSubstrings.filter((needle) => !committed.includes(needle));
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(', ') + (missing.length > 5 ? `, …(${missing.length - 5} more)` : '');
    log(
      `FAILED post-write check on ${configPath} — committed file is missing ${missing.length} required entry(ies): ${shown}`,
    );
    throw new Error(`Codex config at ${configPath} committed without ${missing.length} required entry(ies): ${shown}`);
  }
}
