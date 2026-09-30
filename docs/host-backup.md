# Host backup (off-host, S3)

A nightly copy of the host's non-reproducible state to one S3 bucket used only for this. Timer
`nanoclaw-host-backup.timer` (05:30 UTC) runs `scripts/host-backup.ts run`; reference units
are in `data/systemd/`.

Backups are **not client-side encrypted**, on purpose: a lost key would make every backup
useless. S3's default SSE-S3 applies. Read access is the control (below).

## What it holds

`/etc/nanoclaw-backup/config.json` lists `sources` (files or directories) and `exclude` globs
over absolute paths (`**` crosses `/`, `*` and `?` do not). Beyond those globs, every run:

- skips any directory below a source that is a git clone, worktree or bare repository with a
  remote. A source root that is itself a clone keeps its files but not its `.git`, so a clone
  that also holds untracked data (a workgroup pool, say) goes in as its own source. The check passes
  `safe.directory=*`: as root, git refuses a repository another user owns, and a refusal would
  read as "no remote" and pull the whole clone in. Commits and edits that
  exist only on the host are captured nightly by `scripts/git-safety.sh` into
  `~/nanoclaw-backups/`, so that directory is a source;
- skips Python virtualenvs (any directory holding `pyvenv.cfg`), whatever they are named;
- copies SQLite files, recognised by their header, with the online backup API under the file
  owner's uid, and never uploads `-journal`/`-wal`/`-shm` sidecars. The copy is stored in
  rollback-journal mode; a writer that wants WAL sets it again on open. Running as the owner
  means SQLite can never leave a root-owned sidecar next to a live database. The copy goes
  in steps of 1,024 pages, because a reader in a rollback-journal database blocks writers, and
  the host writes `archive.db` synchronously on its event loop. A commit between steps
  restarts the copy. A database kept busy for 10 minutes fails the run rather than stalling
  the host. A copy that comes back empty (the source stayed locked) is a failure, not a backup;
- records symlinks (target only) and restores them; sockets and FIFOs are ignored;
- runs `commands` (e.g. a database dump) and backs up each one's stdout as
  `<stateDir>/generated/<name>`.

Nothing is dropped quietly. A path that cannot be read, or cannot be an S3 key (control
characters, a backslash, over 1,000 bytes, a name or symlink target that is not valid UTF-8), fails the run and keeps its last uploaded
version in the manifest, along with the directory metadata recorded beneath it (kept in the
state DB). It is never treated as deleted. Rename or exclude such a path to
clear the failure. A `-journal`/`-wal`/`-shm` file whose database cannot be read fails the run
too, since uploading a sidecar without its database could later roll a restored copy back.
Every run, dry runs included, takes an `flock` on `<stateDir>/run.lock` (`src/file-lock.ts`),
so a manual run and the timer can never overlap. The state DB records the bucket it uploads to
and refuses any other: point a new bucket at a fresh `stateDir`.

A dry run prints the scan size without uploading:
`sudo -E node_modules/.bin/tsx scripts/host-backup.ts run --dry-run`.

## Bucket layout and retention

| Key                           | Contents                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files/<absolute path>`       | File content. One S3 version per change.                                                                                                                                                                                                          |
| `manifests/<run id>.jsonl.gz` | One per run, gzipped JSON Lines: a `header` line, one `e` line per path (size, sha256, mode, owner, mtime), one `d` line per directory (mode, owner), and a `trailer` line with that run's failures. A manifest without its trailer is truncated. |

The host's key can only `PutObject`, so each run diffs against a local state file
(`<stateDir>/state.db`, a SQLite table: size, mtime, inode, mode, owner, sha256 last uploaded) and uploads
only what changed. A path that disappears gets an empty object on top, so its last content
becomes a noncurrent version. Before each upload, the paths in it are marked dirty in the
state file. Only a successful upload clears the mark, and a dirty path is always uploaded
again. A partly failed batch therefore cannot leave a manifest that points at a version the
bucket no longer treats as current.

Lifecycle: noncurrent `files/` versions expire 30 days after they are superseded, manifests
35 days after they are written, and incomplete multipart uploads after 7 days. **Current
versions under `files/` never expire.** An unchanged file is uploaded once; expiring it by age
would silently remove a file the host still has. So every manifest from the last 30 days can
be restored in full.

Object Lock is on in COMPLIANCE mode with 30-day default retention. Until a version is 30 days
old, nobody can delete it, including the account root and anyone holding admin credentials.
Object Lock refuses a PutObject that carries neither Content-MD5 nor a checksum, so every
upload passes `--checksum-algorithm CRC32`.

## Access

| Principal                                                                        | Can                                                                                                |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Host writer (IAM user, key in `/etc/nanoclaw-backup/aws-credentials`, root 0600) | `s3:PutObject` on the bucket. No Get, List or Delete.                                              |
| The operator's IAM user                                                          | Read and list.                                                                                     |
| Break-glass role (assume with MFA)                                               | Read and list.                                                                                     |
| Everyone else                                                                    | Denied `s3:GetObject*` and `s3:ListBucket*` by the bucket policy, whatever their IAM policies say. |

Block Public Access is fully on and non-TLS requests are denied. Anyone with passwordless sudo
on the host can read the writer key, but it can only add objects: it cannot read a backup or
remove one.

## Install

1. `/etc/nanoclaw-backup/` (root 0700) holds:
   - `config.json`: `bucket`, `region`, `stateDir` (e.g. `/var/lib/nanoclaw-backup`),
     `sources`, `exclude`, optional `commands` and `batchBytes` (default 8 GiB staged per upload);
   - `aws-credentials` (0600): a `[default]` profile holding the writer key;
   - `aws-config`: `[default]` with `region`, plus an `s3 =` block that bounds the upload, e.g.
     `max_concurrent_requests = 4` and `max_bandwidth = 25MB/s`.
2. `sudo install -m 0644 data/systemd/nanoclaw-host-backup.{service,timer} /etc/systemd/system/`,
   then `sudo systemctl daemon-reload && sudo systemctl enable --now nanoclaw-host-backup.timer`.
3. Do the first full upload outside the unit's 3-hour limit. The limit only stops a run; the
   next run carries on from the last uploaded batch.
4. Once the timer has fired once, add `nanoclaw-host-backup.timer:93600` to the health
   sentinel's `WATCHED_TIMERS` (26 h). Before the first fire, an empty `LastTriggerUSec` reads
   as a breach.

A failed run exits 1, and `OnFailure=` sends the owner a DM with the run's last line, which
names the first failure.

## Restore

Restore uses the operator's credentials or the break-glass role, never the host writer key.

```bash
# Break-glass session (MFA): export the three values it returns.
aws sts assume-role --role-arn <break-glass role ARN> --role-session-name restore \
  --serial-number <MFA device ARN> --token-code <code>

# One file or subtree, as of the latest manifest (or --as-of <ISO time>):
AWS_PROFILE=<profile> node_modules/.bin/tsx scripts/host-backup.ts restore \
  --config /etc/nanoclaw-backup/config.json \
  --prefix /home/ubuntu/nanoclaw-v2/data/v2.db --dest /tmp/restore
```

`--dest` must not exist yet. Restore creates it mode 0700, so no other user can plant a link
inside while the restore runs. Paths keep their absolute layout under it, so the example
writes `/tmp/restore/home/ubuntu/nanoclaw-v2/data/v2.db`. Restore picks the newest run
manifest written at or before `--as-of` and prints any failures that night's run recorded. For each file it takes the newest version no later than that manifest,
checks it against the manifest's sha256, and falls back to an older retained version with the
right hash. Files come first and symlinks last, so nothing is ever written through a restored
link. File and directory modes and mtimes are restored, and ownership too when run as root.
That includes every ancestor directory of what `--prefix` selects, so a single restored
database sits in a directory its owner can write. Directories are finished last, deepest first. A path with no
matching version is reported and the command exits 1. Check a restored SQLite file with
`PRAGMA integrity_check`, then stop the host before copying it into place.

Without the repo, `aws s3api list-objects-v2 --prefix manifests/` lists the manifests, and
`aws s3api list-object-versions --prefix files/<path>` plus `get-object --version-id` fetch a
file. `zcat` the manifest to find a path's sha256; `sha256sum` confirms the version. Restore by
subtree (`--prefix`): the version listing for a prefix is read in one call.

A restore on a fresh machine also needs whatever the sources could not capture: repo clones
from their remotes, Docker images (rebuild), and the systemd units and logrotate entries,
which are under `files/etc/`.

## Verify

- `journalctl -u nanoclaw-host-backup -n 50`: the last line lists paths, files uploaded, and failures.
- `systemctl list-timers nanoclaw-host-backup.timer`: next and last fire.
- The writer key must fail on read: `aws s3api list-objects-v2`, `get-object` and
  `delete-object` all return AccessDenied.
