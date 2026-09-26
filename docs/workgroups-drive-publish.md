# Workgroup Drive publisher

`scripts/publish-workgroups-drive.sh` mirrors workgroup files from `data/workgroups/` to one Google Drive folder, with one subfolder per workgroup. It runs on the host, typically daily from a systemd oneshot and timer. It never runs in a container.

## What gets published

The Drive set is the union of two sources:

1. **Tracked records.** Every file git tracks in the workgroups repo at `data/workgroups/`. That repo's `.gitignore` is deny-by-default and curates durable records such as release boards, ledgers and runbooks. These files are published unfiltered.
2. **Deliverables allowlist.** This source is optional. Files under operator-listed include roots whose extension is allowed, up to a size cap. This is how finished decks, reports and exports reach Drive without being committed to git.

If no allowlist config exists, only the tracked set is published, exactly as before the allowlist existed.

## Invariants

- **One-way, never deletes.** A file that disappears locally is logged as `WOULD-REMOVE` and dropped from state. The Drive copy is left in place.
- **Named account.** gws always runs with `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`, never the ambient default credential.
- **Relative layout.** Drive paths mirror repo-relative paths under the `DRIVE_ROOT_NAME` folder. That variable has no default.
- **State.** A TSV of path → Drive id and sha256 (`DRIVE_STATE_FILE`). An unchanged file costs no API call.
- **Logs.** Everything goes to stderr. The only stdout output is the `--dry-run` report.

## Allowlist config

By default the publisher reads `data/workgroups/.drive-publish.json`, the root of the workgroups repo. Containers mount `data/workgroups/<id>/`, never that root (`src/container-runner.ts`, the workgroup shared-filesystem mount), so agents cannot edit the allowlist. `DRIVE_PUBLISH_CONFIG=<path>` names a different file. When that variable is set, the file must exist; a missing file is fatal.

A config that is present but malformed is **fatal**, and nothing is published. The publisher never falls back to publishing something anyway.

```json
{
  "include_roots": ["acme/artifacts", "example-co/artifacts"],
  "extensions": ["pdf", "html", "htm", "pptx", "xlsx", "docx", "md", "csv", "png", "jpg", "jpeg", "svg", "mp3", "mp4", "wav"],
  "exclude_dirs": ["node_modules", "repos", "worktrees", "wt-*", "scratch", "tmp", "__pycache__"],
  "max_file_mb": 50
}
```

| Key | Type | Meaning |
|---|---|---|
| `include_roots` | non-empty string[] | Repo-relative directories. The first component is the workgroup folder. No absolute paths and no `.`, `..` or hidden components. A root that does not exist is skipped with a warning. A root that is a symlink, or that resolves outside the tree, is refused and fails the run. |
| `extensions` | non-empty string[] | Allowed file extensions, without the dot. Matching ignores case. |
| `exclude_dirs` | string[] | Directory-name globs (`find -name`). Matching directories are pruned, so they are never walked. |
| `max_file_mb` | positive integer | Per-file cap. A larger file is skipped and logged `SKIP oversize`. The cap is checked again on the upload snapshot, so a file that grows after enumeration is still skipped. |

Unknown keys are rejected, so a typo such as `include_root` fails loudly instead of being ignored.

### Hard filters that the config cannot loosen

These apply to allowlisted files. Tracked files are already curated by the repo's `.gitignore` and are exempt.

- **Hidden entries.** Hidden directories, `.git` included, are pruned. Dotfiles are skipped (`SKIP dotfile`).
- **Secret-looking names.** A file is skipped (`SKIP secret-pattern`) if any component of its path matches `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*credential*`, `*token*`, `*secret*`, `*password*` or `id_{rsa,dsa,ecdsa,ed25519}*`. Matching ignores case and applies regardless of extension.
- **Symlinks.** A symlink is never followed. `find` runs with its default `-P`, so a symlinked directory is not descended and a symlinked file is skipped (`SKIP symlink`).
- **Swap race.** Every candidate is opened once and must be a regular file whose `/proc/self/fd` path is exactly `<repo>/<path>`. That pins it inside its own `data/workgroups/<workgroup>/`. The bytes uploaded are a snapshot read from that descriptor. This is the same check the tracked set gets. A file that fails it is refused, and the run exits non-zero.

## Dry run

```bash
bash scripts/publish-workgroups-drive.sh --dry-run
```

The dry run prints a TSV to stdout with one row per workgroup: `tracked`, `allowlist_files`, `allowlist_bytes`, and the subset of allowlisted files not yet in the state file (`unpublished_files` and `unpublished_bytes`). A summary line of skip counts follows the rows. The dry run needs no `DRIVE_ROOT_NAME`, makes no gws call, takes no lock and writes nothing. Per-file skip reasons go to stderr.

## Long runs, locking and resume

- **Lock.** A run takes `flock` on `$DRIVE_STATE_FILE.lock`. A second run that finds it held logs `SKIP another publisher run holds …` and exits 0. The kernel drops the lock when the process dies, so a stale lock cannot occur.
- **Resume.** Progress is checkpointed to the state file every 25 uploads (`DRIVE_CHECKPOINT_EVERY`) and again on exit, including after SIGTERM. Each checkpoint keeps the previous row of every live file the run has not reached yet. An interrupted run therefore resumes where it stopped: finished files hash-match and skip, and unreached files keep their Drive ids. A SIGKILL loses at most the uploads made since the last checkpoint. Those files are found again by a name-in-parent lookup, so no duplicates are created.
- **Cold runs.** Each new file costs one to two gws calls, about 1.5–2 s each on the reference host. A folder the run created itself is known to be empty, so the per-file lookup inside it is skipped. A first run that adds a large allowlist can take hours. If the unit's `TimeoutStartSec` is shorter than that, systemd stops the run at the timeout, the unit reports a failure, and the next timer fire resumes. To finish in one pass, raise the timeout with a drop-in before the first allowlisted run:

  ```ini
  # /etc/systemd/system/<unit>.service.d/timeout.conf
  [Service]
  TimeoutStartSec=12h
  ```

  A daily timer cannot start a second instance of a oneshot that is still running, and the lock also covers manual runs.
