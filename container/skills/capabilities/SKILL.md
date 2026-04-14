---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Read-only. Use when the user asks what the bot can do, what's installed, or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a structured read-only report of what this NanoClaw instance can do.

The project root is mounted read-only at `/workspace/project` — use it to explore the codebase, understand the architecture, and read source code.

## How to gather the information

Run these commands and compile the results into the report format below.

### 1. Installed skills

**Built-in skills** (synced into the container):

```bash
ls -1 /home/node/.claude/skills/ 2>/dev/null || echo "No skills found"
```

Each directory is a skill. The directory name is the skill name (e.g., `agent-browser` → `/agent-browser`).

**Plugin skills** (loaded by the SDK from mounted plugin repos):

```bash
python3 -c "
import json, os
plugins_root = '/workspace/plugins'
if not os.path.isdir(plugins_root):
    exit()
for entry in sorted(os.listdir(plugins_root)):
    repo = os.path.join(plugins_root, entry)
    if not os.path.isdir(repo):
        continue
    # Collect plugin roots: direct plugin or multi-plugin repo
    plugin_roots = []
    if os.path.isfile(os.path.join(repo, '.claude-plugin', 'plugin.json')):
        plugin_roots.append(repo)
    else:
        sub_dir = os.path.join(repo, 'plugins')
        if os.path.isdir(sub_dir):
            for sub in sorted(os.listdir(sub_dir)):
                sp = os.path.join(sub_dir, sub)
                if os.path.isdir(sp) and os.path.isfile(os.path.join(sp, '.claude-plugin', 'plugin.json')):
                    plugin_roots.append(sp)
    for proot in plugin_roots:
        try:
            with open(os.path.join(proot, '.claude-plugin', 'plugin.json')) as f:
                cfg = json.load(f)
        except:
            cfg = {}
        name = cfg.get('name', os.path.basename(proot))
        # Resolve skill directories: default ./skills/ plus declared paths
        skill_dirs = []
        default_skills = os.path.join(proot, 'skills')
        if os.path.isdir(default_skills):
            skill_dirs.append(default_skills)
        declared = cfg.get('skills')
        if isinstance(declared, str):
            declared = [declared]
        if isinstance(declared, list):
            for d in declared:
                resolved = os.path.normpath(os.path.join(proot, d))
                if os.path.isdir(resolved) and resolved not in skill_dirs:
                    skill_dirs.append(resolved)
        skills = set()
        for sd in skill_dirs:
            for s in os.listdir(sd):
                if os.path.isdir(os.path.join(sd, s)):
                    skills.add(s)
        if skills:
            print(f'{name}: {", ".join(sorted(skills))}')
" 2>/dev/null
```

Plugin skills are prefixed with the plugin name when invoked (e.g., `impeccable:polish` → `/polish`, `bootstrap-workflow:team-build` → `/team-build`). Include both built-in and plugin skills in the report.

### 2. Available tools

Read the allowed tools from your SDK configuration. You always have access to:

- **Core:** Bash, Read, Write, Edit, Glob, Grep
- **Web:** WebSearch, WebFetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **Other:** TodoWrite, ToolSearch, Skill, NotebookEdit
- **MCP:** mcp**nanoclaw**\* (messaging, tasks, group management)

### 3. MCP server tools

The NanoClaw MCP server exposes these tools (via `mcp__nanoclaw__*` prefix):

- `send_message` — send a message to the user/group
- `schedule_task` — schedule a recurring or one-time task
- `list_tasks` — list scheduled tasks
- `pause_task` — pause a scheduled task
- `resume_task` — resume a paused task
- `cancel_task` — cancel and delete a task
- `update_task` — update an existing task
- `register_group` — register a new chat/group (main only)

### 4. Container skills (Bash tools)

Check for executable tools in the container:

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
```

### 5. Group info

```bash
ls /workspace/group/CLAUDE.md 2>/dev/null && echo "Group memory: yes" || echo "Group memory: no"
ls /workspace/extra/ 2>/dev/null && echo "Extra mounts: $(ls /workspace/extra/ 2>/dev/null | wc -l | tr -d ' ')" || echo "Extra mounts: none"
```

## Report format

Present the report as a clean, readable message. Example:

```
📋 *NanoClaw Capabilities*

*Installed Skills:*
• /agent-browser — Browse the web, fill forms, extract data
• /capabilities — This report
(list all found skills)

*Tools:*
• Core: Bash, Read, Write, Edit, Glob, Grep
• Web: WebSearch, WebFetch
• Orchestration: Task, TeamCreate, SendMessage
• MCP: send_message, schedule_task, list_tasks, pause/resume/cancel/update_task, register_group

*Container Tools:*
• agent-browser: ✓ (or not installed)

*System:*
• Group memory: yes/no
• Extra mounts: N directories
• Project root: read-only (or read-write for main)
```

Adapt the output based on what you actually find — don't list things that aren't installed.

**See also:** `/status` for a quick health check of session, workspace, and tasks.
