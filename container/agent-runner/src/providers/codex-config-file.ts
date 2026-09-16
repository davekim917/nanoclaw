/**
 * The ONE owning reader/writer for a container `config.toml`.
 *
 * Three writers in this tree rewrite the generated Codex `config.toml` on every
 * spawn — the MCP block (`writeCodexMcpConfigToml`), the hook-trust block
 * (`syncCodexHookTrust`), and the peer-mode runtime config
 * (`setupCodexRuntime`) — and each rewrites the file from what it read. That
 * makes the file's OTHER tables collateral on every write, and two of them are
 * load-bearing with no default behind them:
 *
 * - `[hooks.state."<key>"] trusted_hash` — without the matching row Codex loads
 *   the destructive-action guard chain, reports it `untrusted`, and never
 *   dispatches it (see `./codex-hook-trust.ts`);
 * - `[marketplaces.*]` / `[plugins.*]` — written by `codex plugin add`, and the
 *   only record that the mounted plugins are registered at all.
 *
 * (`[features] hooks = true` is NOT in that list any more, and the issue that
 * asked for this module originally led with it. Re-measured on codex-cli
 * 0.154.0: `codex features list` reports `hooks  stable  true`, so the flag is
 * on by default and dropping the line disables nothing; an unknown or removed
 * key under `[features]` is ignored silently. The line is inert noise, not an
 * invariant. The trust entries and the plugin tables are the invariant.)
 *
 * Two failure shapes put those tables at risk, and both are silent — the write
 * succeeds, the app-server starts, and the guard chain is simply gone:
 *
 * 1. **A two-answer read.** `catch { base = '' }` cannot tell "the file is not
 *    there" from "I could not look". A config.toml that is unreadable but
 *    writable (mode `0200`, a mount that lost read access) is then rewritten
 *    from an EMPTY base, which deletes every table the writer did not author.
 *    `readCodexConfigToml` answers three ways instead: ENOENT — and only
 *    ENOENT — is an empty base; everything else throws and the caller decides.
 * 2. **A truncating commit.** `fs.writeFileSync` truncates in place, so an
 *    ENOSPC or a crash after the open leaves the file empty or half-written and
 *    the NEXT spawn reads the damage as its base. `writeCodexConfigToml`
 *    renders the whole file in memory, writes a sibling temp file, `fsync`s it,
 *    and `rename`s it over the target — so a failed update leaves the last
 *    valid configuration standing, untouched.
 *
 * A half-fix is a site patch: giving only one writer an atomic rename buys
 * nothing while another truncates the same file two lines earlier in the same
 * spawn (`writeCodexMcpConfigToml` runs immediately before
 * `writeCodexHooksAndTrust` at `./codex.ts`). Hence one primitive, and every
 * in-tree writer of a container config.toml goes through it.
 */
import fs from 'fs';
import path from 'path';

function log(msg: string): void {
  console.error(`[codex-config-file] ${msg}`);
}

/**
 * Read a `config.toml`, keeping "it is not there" and "I could not look" apart.
 *
 * Every caller reads a config.toml only to REWRITE it from what it read, so
 * collapsing a read failure into `''` does not lose a read — it loses the file.
 * ENOENT, and only ENOENT, is an empty base.
 */
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

/** Best-effort `fsync` of a directory, so a completed rename survives a crash. */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Not every filesystem permits opening a directory for fsync, and the
    // rename has already happened either way. Losing it to a power cut costs
    // one regenerated config on the next spawn, never a corrupt one.
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
 * Atomically replace a container `config.toml`.
 *
 * `render` receives the CURRENT contents (`''` only when the file genuinely
 * does not exist) and returns the complete new file. It runs before anything is
 * written, so a renderer that throws leaves the file untouched. Pass
 * `readBase: false` for a FULL regeneration that ignores what was there — the
 * renderer then gets `''` and an unreadable current file is not a reason to
 * refuse, since nothing was going to be carried forward from it.
 *
 * Commit is temp-file-and-rename in the SAME directory — `rename(2)` is atomic
 * only within a filesystem, and a temp file elsewhere (`/tmp`) would silently
 * degrade to a copy across a mount boundary. The temp file is `fsync`ed before
 * the rename so the rename cannot publish a name pointing at unwritten data,
 * and the directory is `fsync`ed after so the rename itself is durable.
 *
 * Two edges, both recorded because neither is reachable in this tree and a
 * future caller could make one so. A config.toml that is a SYMLINK is replaced
 * by a regular file rather than written through — nothing here creates one (the
 * host writes a regular file, `src/fs-safety.ts` and `src/container-runner.ts`).
 * And a leftover DIRECTORY named `config.toml.tmp` blocks every write: `open`
 * fails EISDIR and `unlink` cannot clear it, so the spawn refuses until it is
 * removed by hand.
 *
 * Throws on any failure, after removing the temp file. That is deliberate at
 * every call site: a Codex spawn that cannot persist its guard wiring must not
 * proceed as if it had.
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
    // Cleared BEFORE the close, not after: `close(2)` frees the descriptor even
    // when it reports an error, so a catch block that closed it again could
    // shut a file some other thread had since been handed the same number for.
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

/**
 * `writeCodexConfigToml` plus a read-back assertion, for the writer that owns a
 * table nothing else can restore.
 *
 * `requiredSubstrings` are checked against the bytes actually on disk after the
 * rename — not against what was rendered. That is what makes this close the
 * CLASS rather than the instances: it does not matter whether a table went
 * missing because a renderer dropped it, a read answered `''`, or the commit
 * landed short. If the committed file does not carry it, the spawn is refused
 * while the operator still has a log line naming the missing table.
 */
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
