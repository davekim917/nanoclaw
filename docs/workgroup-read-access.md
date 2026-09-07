# Cross-workgroup read access

Workgroups are isolated by default. An operator may grant selected recipient
workgroups read-only access to selected source workgroups with the host-only
policy `data/workgroup-read-access.json`. The policy applies to every current
and future agent sibling in the recipient workgroup, independent of provider.

Missing policy means no cross-workgroup mounts.

## Policy

```json
{
  "version": 1,
  "recipients": {
    "example-hub": { "mode": "all", "sources": "*" },
    "example-dev": { "mode": "all", "sources": "*" },
    "example-research": { "mode": "archives", "sources": "*" }
  }
}
```

`recipients` is keyed by recipient workgroup ID. `mode` is either:

- `archives`: only `memory` and `conversations`.
- `all`: the whole source workgroup tree plus the current repository and
  topic-worktree stores.

`sources` is `"*"` for every registered workgroup, including workgroups added
later, or a non-empty array of explicit registered workgroup IDs. IDs must be
lowercase slugs using letters, digits, and hyphens. The host rejects malformed
policy, unknown recipients or sources, unsafe IDs, source symlinks, and
non-directory source roots before spawning a container; it never treats a
directory name as an arbitrary host path.

The existing mount allowlist still applies. It must permit the relevant
`data/` root read-only, otherwise the grant produces no mount. A policy grant
cannot bypass blocked-path rules or allow read-write access.

## Container paths

For source workgroup `<source>`, every mount is read-only below
`/workspace/extra/work/<source>/`.

| Mode | Path | Host source |
| --- | --- | --- |
| `archives` | `memory` | `data/workgroups/<source>/memory` |
| `archives` | `conversations` | `data/workgroups/<source>/conversations` |
| `all` | `files` | `data/workgroups/<source>` |
| `all` | `memory`, `conversations` | archive compatibility paths above |
| `all` | `repositories` | `data/repositories/<source>` |
| `all` | `topics` | `data/v2-topics/<source>` |
| `all` | `legacy-threads` | `data/v2-threads/wg-<source>` when present |

`files` keeps the source workgroup's complete normal tree available without
nesting project-store mounts beneath a read-only bind. A symlink inside a
mounted tree does not grant access to a host target outside the mounted paths;
the host does not resolve or add symlink targets as mounts.

The host adds a short provider-neutral instruction section to generated
`CLAUDE.md` and `AGENTS.md` listing the actual admitted paths. This is a
discovery aid only; mounts enforce access.

## Activation and rollback

1. Validate the JSON and verify every named workgroup exists in `data/v2.db`.
2. Ensure the mount allowlist permits the intended data root read-only.
3. Remove only the migrated legacy `additionalMounts` entries targeting
   `/workspace/extra/work` from each recipient's `container.json`; preserve
   unrelated mounts. This prevents those per-agent entries from restoring
   access if the policy is later removed.
4. Restart recipient containers or the host service. New spawns load the policy
   and every sibling receives the same resolved grant.
5. Inspect a fresh container's mount set and generated project document.

To revoke access, first remove any legacy `/workspace/extra/work` entries for
the affected recipient, then remove its policy entry (or the policy file), and
restart its containers. Existing containers retain their already-created mounts
until restart.

For recipients with a policy grant, legacy per-agent `additionalMounts`
targeting `/workspace/extra/work` are no longer an authority for
cross-workgroup access. An identical read-only policy mount is deduplicated;
every other collision in that namespace is rejected. Groups with no grant
retain unrelated legacy mount behavior for migration compatibility.

Policy mount sources are rechecked immediately before Docker receives each
pathname and a changed or symlinked source aborts the spawn. Docker bind mounts
pathnames rather than opened descriptors, so a final kernel-level race remains;
the recheck reduces the window but does not claim to eliminate it.
