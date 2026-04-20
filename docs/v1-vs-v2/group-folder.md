# group-folder: v1 vs v2

## Scope
- v1: `src/v1/group-folder.ts` (45 LOC), `group-folder.test.ts` (35 LOC) — validation + path resolution only
- v2 counterparts:
  - `src/group-folder.ts` (45 LOC) — byte-identical to v1
  - `src/group-init.ts` (128 LOC) — **new** filesystem bootstrap
  - `src/container-config.ts` (115 LOC) — **new** per-group container.json management
  - `src/group-folder.test.ts` (35 LOC) — identical to v1

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| `GROUP_FOLDER_PATTERN` (alphanumeric + `-` + `_`, 1-64) | `group-folder.ts:5-6` | identical | |
| Reserved folder `global` | `group-folder.ts:6` | identical | `RESERVED_FOLDERS` set |
| `isValidGroupFolder()` (reject empty, whitespace, traversal, absolute) | `group-folder.ts:8-16` | identical | |
| `assertValidGroupFolder()` | `group-folder.ts:18-22` | identical | |
| `resolveGroupFolderPath()` + `ensureWithinBase()` | `group-folder.ts:31-36` | identical | |
| `resolveGroupIpcPath()` (resolves `data/ipc/<folder>`) | `group-folder.ts:38-44` | kept | IPC dir is legacy — no longer used since v2 moved to session DBs |
| Filesystem scaffold (CLAUDE.md, skills, overlays) | — | **new in v2** | `group-init.ts:48-127` |
| Global memory symlink (`.claude-global.md` → `/workspace/global/CLAUDE.md`) | `group-init.ts:55-70` | **new** | Uses `lstat` to detect dangling symlinks |
| Per-group `container.json` init | `group-init.ts:83-85` + `container-config.ts:109-114` | **new** | Graceful fallback on corruption |
| `.claude-shared` session dir | `group-init.ts:87-92` | **new** | Under `data/v2-sessions/<id>/` |
| `settings.json` with `CLAUDE_CODE_*` flags | `group-init.ts:94-98` | **new** | |
| Recursive skill copy from `container/skills/` | `group-init.ts:100-107` | **new** | |
| Per-group agent-runner src overlay copy | `group-init.ts:109-117` | **new** | |
| Idempotent init (every step gates on `fs.existsSync()`) | `group-init.ts:44-127` | **new** | Safe to re-run |
| Step logging via `log.info()` | `group-init.ts:119-126` | **new** | |

## Missing from v2
None. All v1 validation/resolution behavior is preserved byte-for-byte.

## Behavioral discrepancies
None on the validation layer. v2 adds the filesystem-scaffold layer as a separate module (`group-init.ts`) so validation stays pure.

## Worth preserving?
Clean split — keep as-is. `group-folder.ts` = names + paths; `group-init.ts` = file creation. Both modules are small and single-purpose.
