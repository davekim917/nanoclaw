# Channel Isolation Model

NanoClaw decouples messaging channels from agent groups. When you connect a channel (Discord, Telegram, Slack, GitHub, etc.), you decide how it relates to your existing agents. There are three session-isolation levels.

Memory has a separate, explicit boundary: the workgroup. Every agent group in
one workgroup reads and edits the same canonical Markdown tree at
`data/workgroups/<workgroup-id>/memory`. Agent-group `CLAUDE.md` and
`CLAUDE.local.md` files remain provider, identity, and standing instruction
surfaces; they are not memory stores. Use different workgroups whenever memory
or archived conversation must not cross between agents.

Agent credentials are not an isolation boundary, and were never a reliable one.
Every container carries all three provider credentials whatever its own
provider: the Claude ring as env, the host Codex home
(`~/.codex-<folder>` where a group has its own, otherwise `~/.codex`) plus any
`codexAuthFallbacks` homes, and the OpenCode `auth.json`
(`~/.local/share/opencode-<folder>/auth.json`, otherwise the shared one) staged
into a session-private XDG tree. So any agent can drive `claude -p`,
`codex exec` or `opencode` headless with the fleet's own accounts.

What *is* bounded is credential SCOPE, not presence — which account a group
reaches, via the per-group ring and per-group home above — plus the one
withholding lever, `excludePlugins: ["codex"]`, which withholds the Codex
plugin and the credential that rides on it together. A per-group opt-in flag
for Codex host auth (`codexHostAuth`) used to sit in front of the mount; it is
gone, because presence was the wrong thing to gate.

## The Three Levels

### 1. Shared Session

Multiple channels feed into the same conversation. The agent sees all messages from all channels in one thread.

**What's shared:** The agent workspace, agent instructions, workgroup memory, and the conversation itself. A GitHub PR comment and a Slack message appear side by side in the agent's context.

**Example:** A Slack channel paired with GitHub webhooks. The agent receives PR review requests via GitHub and discusses them in Slack — all in one session. When someone comments on a PR, the agent can reference the earlier Slack discussion about that feature.

**When to use:** When one channel feeds context into another. Webhook/notification channels (GitHub, Linear) paired with a chat channel (Slack, Discord) are the classic case.

**Technical:** Both messaging groups are wired to the same agent group with `session_mode: 'agent-shared'`. Session resolution looks up by agent group ID only, ignoring the messaging group — so all channels converge on one session.

---

### 2. Same Agent, Separate Sessions

Multiple channels share the same agent (same workspace, instructions, personality, and workgroup memory) but have independent conversations.

**What's shared:** The agent workspace, instructions, personality, tools, and the workgroup memory canon. If you tell the agent something in one session, it can save that to the canon and recall it in another.

**What's separate:** The conversation thread. Messages from one channel don't appear in the other channel's session. Each channel has its own context window and conversation history.

**Example:** You have three Telegram chats with your agent — one for a side project, one for personal tasks, one for work. All three share the same agent workspace. If you ask it to remember your API key naming convention in the project chat, it may recall that convention in the work chat too. But the conversations themselves are independent.

**When to use:** When you're the primary (or sole) participant across channels and you want a unified agent identity. This is the most common setup for personal use across multiple platforms or multiple groups within one platform.

**Technical:** Multiple messaging groups are wired to the same agent group with `session_mode: 'shared'` (or `'per-thread'`). Each messaging group gets its own session, but they all run in the same agent group folder.

---

### 3. Separate Agent Groups

Each channel gets its own agent group, with its own workspace, instructions,
provider identity, container, routing, and conversation history. Memory and
archive isolation depends on the workgroup assignment.

**What's shared:** Nothing when the agent groups are also in different
workgroups. Deliberate siblings in the same workgroup share its memory canon and
archive while keeping their agent-scoped surfaces separate.

**Example:** You have a Telegram group with a friend and a Discord server for a
team project. The friend should not know what you discuss with your team, and
vice versa. Put the two agent groups in different workgroups. By contrast, a
Claude agent and Codex agent working on the same project can be separate agent
groups in one workgroup and intentionally share memory.

**When to use:** Use separate agent groups for separate identity, provider,
container, or routing. Also use separate workgroups when the information in one
channel must never be available to the other.

**Technical:** Each channel is wired to a different agent group, each with its
own folder under `groups/`. `agent_groups.workgroup_id` determines whether
their canonical memory and archive are shared or isolated.

---

## How to Decide

Decide the conversation boundary and memory boundary separately:

- **No information may cross** → Separate agent groups in separate workgroups
- **Yes, and the channels should see each other's messages** → Shared session (level 1)
- **Yes, but the conversations should be independent** → Same agent, separate sessions (level 2)
- **Separate provider identities should share durable knowledge** → Separate sibling agent groups in one workgroup

### Rules of Thumb

| Scenario | Recommended Level |
|----------|------------------|
| Just you, multiple platforms (Telegram + Discord + Slack) | Same agent, separate sessions |
| Just you, multiple groups on one platform (3 Telegram chats) | Same agent, separate sessions |
| Webhook channel + chat channel (GitHub + Slack) | Shared session |
| Channel with friend A and channel with friend B | Separate agent groups and workgroups |
| Personal channel and work channel | Separate agent groups and workgroups |
| Team channel with different access levels | Separate agent groups and workgroups |
| Claude + Codex siblings on one project | Separate agent groups, same workgroup |

### When in Doubt

If the participants are the same across channels → same agent group is usually fine.

If different people are involved → use separate agent groups and separate
workgroups. Agent-group separation alone does not isolate memory between
intentional workgroup siblings.

## Entity Model

```
workgroups (one canonical memory tree and archive)
    ↑ 1:many
agent_groups (workspace, CLAUDE.md/CLAUDE.local.md instructions, personality)
    ↕ many-to-many
messaging_groups (a specific channel/chat/group on a platform)
    via
messaging_group_agents (session_mode, engage_mode, engage_pattern, sender_scope, ignored_message_policy, priority, threads)
```

Wiring-creation defaults for engage mode/pattern, thread policy, and unknown-sender policy come from the channel adapter's declaration (per DM/group context), overridable per wiring at creation — see [setup-wiring.md](setup-wiring.md#channel-defaults-two-level-model) and [api-details.md](api-details.md#channel-defaults).

- **Shared session:** multiple messaging_groups → same agent_group, `session_mode = 'agent-shared'`
- **Same agent, separate sessions:** multiple messaging_groups → same agent_group, `session_mode = 'shared'`
- **Separate agents:** each messaging_group → different agent_group; choose the
  same or different workgroup explicitly based on whether memory should pool
