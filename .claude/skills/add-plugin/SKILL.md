---
name: add-plugin
description: Add any third-party GitHub repo as a container agent plugin. Clones the repo into ~/plugins/, scaffolds .claude-plugin/plugin.json if missing, validates the structure for SDK discovery, and optionally configures group exclusions. Use when the user wants to install a plugin, add a skills repo, or set up a third-party package for the container agent. Triggers on "add plugin", "install plugin", "new plugin", or any GitHub repo URL the user wants mounted as a container plugin.
---

# Add Plugin

Install a third-party GitHub repo as a plugin for the container agent.

**Usage:** `/add-plugin <repo-url>`

## Phase 1: Parse and Check

### Derive directory name

Extract the repo name from the URL. Use the repo name as the directory name under `~/plugins/`. If the name is too generic (e.g. `skills`), prefix with the owner (e.g. `remotion-skills`).

### Check if already installed

```bash
ls ~/plugins/
```

If a directory for this repo already exists, tell the user and check if it has `.claude-plugin/plugin.json`. If the plugin is fully configured, skip to Phase 4. If it's cloned but missing the plugin config, skip to Phase 3.

### Clone

```bash
cd ~/plugins && git clone <repo-url> <directory-name>
```

## Phase 2: Check Existing Plugin Config

If `.claude-plugin/plugin.json` already exists in the cloned repo, read it and show the user what it contains. Skip to Phase 4.

## Phase 3: Scaffold Plugin Config

The container agent-runner discovers plugins by looking for `.claude-plugin/plugin.json` at the root of each directory in `~/plugins/`. The `skills` field must point to a directory containing subdirectories with `SKILL.md` files. Without this file, the SDK will silently skip the repo.

### Find skills

Search the repo for the skills directory structure:

1. Look for a `skills/` directory at root containing subdirectories with `SKILL.md` files
2. If not found, search recursively for any `SKILL.md` files and identify their parent structure
3. If no `SKILL.md` files exist anywhere, warn the user that this repo doesn't appear to contain Claude skills and ask how they want to proceed

### Gather metadata

Pull metadata from available sources in this priority order:

- **package.json**: name, version, description, author, repository
- **README.md**: description (first paragraph or heading)
- **GitHub API**: `gh api repos/<owner>/<repo>` for description, author

### Create the config

```bash
mkdir -p <plugin-dir>/.claude-plugin
```

Write `.claude-plugin/plugin.json`:

```json
{
  "name": "<repo-name>",
  "description": "<from metadata>",
  "version": "<from package.json or '1.0.0'>",
  "author": { "name": "<from metadata>" },
  "repository": "<repo-url>",
  "skills": "./<path-to-skills-dir>"
}
```

### Validate

Confirm the plugin will be discovered by verifying:

1. `.claude-plugin/plugin.json` exists and is valid JSON
2. The `skills` path resolves to an existing directory
3. That directory contains at least one subdirectory with a `SKILL.md` file

If validation fails, explain what's wrong and fix it.

## Phase 4: Group Exclusions

Ask the user:

> This plugin will be available to **all groups** by default. Do you want to exclude it from any specific groups?

If yes, list the registered groups:

```bash
sqlite3 data/nanoclaw.db "SELECT jid, name, container_config FROM registered_groups"
```

For each group the user wants to exclude, update its `containerConfig.excludePlugins` array. Read the current `container_config`, parse it, append the plugin directory name to the `excludePlugins` array (creating it if needed), and write it back:

```bash
sqlite3 data/nanoclaw.db "UPDATE registered_groups SET container_config = '<updated-json>' WHERE jid = '<jid>'"
```

If the user says no exclusions are needed, move on.

## Phase 5: Confirm

Summarize what was done:

- Where the plugin was cloned
- Whether `.claude-plugin/plugin.json` was created or already existed
- How many skills were found
- Which groups (if any) it's excluded from
- That the plugin will be mounted read-only at `/workspace/plugins/<name>` on the next container launch
- That the hourly plugin updater will keep it in sync with upstream via `git pull --ff-only`

## Troubleshooting

### Plugin not loading in container

The agent-runner discovers plugins at startup. If the plugin isn't loading:

1. Verify `.claude-plugin/plugin.json` exists and the `skills` field points to a real directory
2. Check the directory name isn't in the group's `excludePlugins` list
3. The container must be restarted — plugins are mounted at launch time

### Repo has no skills/ directory

Some repos organize skills differently. If `SKILL.md` files exist but not under a `skills/` directory, either:
- Set the `skills` field to point to the actual parent directory
- Or restructure by creating a `skills/` directory and symlinking

### Multi-plugin repos

Some repos contain multiple plugins under a `plugins/` subdirectory (e.g. the `bootstrap` repo). The agent-runner handles this automatically — it checks each subdirectory under `plugins/` for its own `.claude-plugin/plugin.json`. If the repo follows this pattern, scaffold a `plugin.json` inside each sub-plugin, not at the root.
