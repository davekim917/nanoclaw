# sender-allowlist: v1 vs v2

## Scope
- v1: `src/v1/sender-allowlist.ts` (97 LOC), `sender-allowlist.test.ts` (217 LOC) — flat JSON config at `~/.config/nanoclaw/sender-allowlist.json`
- v2 counterparts: `src/access.ts` (116 LOC), `src/router.ts` (317 LOC), `src/db/schema.ts` (user_roles, agent_group_members, messaging_groups.unknown_sender_policy), `src/container-runner.ts:291-295` (admin injection), `src/types.ts` (MessagingGroupAgent.response_scope)

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| Per-chat entry (`chats[chatJid]`) | `messaging_groups.unknown_sender_policy` | replaced | Policy per channel, not allowlist entries |
| Default entry | Default `unknown_sender_policy = 'strict'` | **reversed** | v1 default-allow → v2 default-deny |
| `allow: '*'` wildcard | Not present | removed | |
| `allow: string[]` (exact-match list) | `agent_group_members` rows + `user_roles` | replaced | Role-based / membership-based |
| `mode: 'trigger'` (allow for processing) | Implicit (access granted → routed) | kept | |
| `mode: 'drop'` (silent drop) | `recordDroppedMessage()` (logs only) | **partially lost** | No silent-drop mode; denied = logged |
| Admin override | owner / global_admin / scoped_admin | **new in v2** | Richer privilege hierarchy |
| Static JSON file | Central DB (`users`, `user_roles`, `agent_group_members`) | changed | Runtime-mutable, queryable |
| Exact-string sender | Namespaced `channel_type:handle` user IDs | enhanced | Explicit channel scoping |
| `logDenied` flag | implicit (log at decision point) | kept | |

## Access-model diff
**v1**: flat allowlist per chat → default-allow → binary allowed/denied.
**v2**: entity model (`users` + roles + memberships) + per-messaging-group policy (`strict | request_approval | public`) → default-deny for unknowns.

**Strictly more expressive:** role hierarchy, per-agent-group scope, three-way unknown handling, user metadata (display_name/kind), runtime reconfig.
**Lost:** per-message `drop` mode, default-allow posture, simple JSON editing.

## Missing from v2
1. **`request_approval` flow** — marked TODO in `router.ts:295`. Approval-on-first-contact for unknown senders is scaffolded but not wired
2. **`response_scope` enforcement** — field exists (`'all' | 'triggered' | 'allowlisted'`) but is not checked in `router.ts` or `delivery.ts`
3. **Trigger-rule matching on `messaging_group_agents`** — `router.ts:198` TODO ("Future: trigger rule matching"); currently only priority-based agent selection
4. **Silent-drop option for known-noisy senders** — v1's `mode: 'drop'` allowed "I see you but I ignore you"; v2 can only log and drop

## Behavioral discrepancies
1. **Default posture flipped**: v1 open-by-default vs v2 closed-by-default — **breaking for migrations that relied on default-allow**
2. **Drop semantics**: v1 silent drop; v2 `recordDroppedMessage()` always logs
3. **Admin bypass**: v1 had no implicit bypass; v2 grants owners/admins access regardless of membership — more permissive for privileged users
4. **Scope resolution**: v1 per-chat; v2 per-agent-group via `user_roles.agent_group_id` — misalignment if one chat routes to multiple agent groups with different admins

## Worth preserving?
The v2 role-based model is architecturally superior. The gaps worth closing:
- **Finish `request_approval`** flow — half-implemented scaffolding
- **Finish `response_scope` enforcement** — exists in schema but unused
- **Finish trigger-rule matching** in `pickAgent` — without it, every wired agent fires on every message
- **Consider silent-drop via a dedicated table** (`(agent_group_id, sender_pattern)` with action=drop) — orthogonal to privilege
