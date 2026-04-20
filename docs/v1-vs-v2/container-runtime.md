# container-runtime + mount-security: v1 vs v2

## Scope
- v1: `src/v1/container-runtime.ts` (81 LOC), `container-runtime.test.ts` (148 LOC), `mount-security.ts` (406 LOC)
- v2: `src/container-runtime.ts` (81 LOC), `container-runtime.test.ts` (149 LOC), `mount-security.ts` (390 LOC)

## Capability map

### container-runtime.ts

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| `CONTAINER_RUNTIME_BIN = 'docker'` | `container-runtime.ts:1` | kept | Hardcoded; Apple Container runtime is NOT handled here in either version |
| `hostGatewayArgs()` | `container-runtime.ts` | kept | Identical |
| `readonlyMountArgs()` | `container-runtime.ts` | kept | Identical |
| `stopContainer()` | `container-runtime.ts` | kept | Identical |
| `ensureContainerRuntimeRunning()` | `container-runtime.ts` | kept | Identical |
| `cleanupOrphans()` | `container-runtime.ts:60-80` | kept | Identical logic |
| Logging module | | **changed** | v1 imports `logger` (data-first); v2 imports `log` (message-first) |

### mount-security.ts

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| `AdditionalMount` / `AllowedRoot` / `MountAllowlist` types | `mount-security.ts:16-29` | kept | Same shape except `nonMainReadOnly` removed |
| Default blocked patterns | `mount-security.ts:39` | kept | Same list |
| Allowlist load + file-watch cache | `mount-security.ts:64-102` | kept | |
| Path expansion (`~`) | `mount-security.ts` | kept | |
| Symlink resolution | `mount-security.ts` | kept | |
| Container-path validation | `mount-security.ts` | kept | |
| Template generation | `mount-security.ts:362-386` | changed | v2 template omits `nonMainReadOnly: true` |
| `validateMount(mount, isMain)` | `mount-security.ts:230-307` | **signature changed** | v2 is `validateMount(mount)` — no `isMain` |
| `validateAdditionalMounts(mounts, groupName, isMain)` | same | **signature changed** | v2 drops `isMain` |
| Non-main groups forced to read-only | — | **removed** | v1 lines 283-291; v2 only checks `allowedRoot.allowReadWrite` |

## Missing from v2
1. **`nonMainReadOnly` flag on `MountAllowlist`** — v1 could force non-main agent groups to read-only even when their allowlist permitted RW
2. **`isMain` param flow** through `validateMount` / `validateAdditionalMounts`
3. **Non-main group RW enforcement** at mount-validation time — now delegated entirely to `allowedRoot.allowReadWrite`

## Behavioral discrepancies
1. **Isolation model weakened**: a non-main ("shared" or auxiliary) agent group can now mount RW on any path its root permits. v1's defense-in-depth (allowlist permits RW + group must be main) is reduced to just the allowlist check
2. **Logger import**: only surface difference in container-runtime.ts

## Worth preserving?
**`nonMainReadOnly` restoration has security value** for multi-tenant setups where shared/sandbox agent groups should not mutate filesystem even if the allowlist is permissive. Low-cost to reintroduce: restore the field on `MountAllowlist`, restore the `isMain` param, restore the check in `validateMount()`. If v2 has explicitly decided isolation is enforced elsewhere (agent-group config), document that; otherwise this is a regression.
