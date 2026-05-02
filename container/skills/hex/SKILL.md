---
name: hex
description: >
  Programmatically interact with the Hex data analytics platform (https://hex.tech). Create projects,
  add python and sql cells to notebooks, write queries against data connections, build
  stakeholder-facing dashboards.
allowed-tools: Bash(hex:*) Bash(jq:*)
---

# Hex CLI -- Agent Skill

The `hex` CLI manages Hex projects, cells, runs, data connections, and workspace resources from the command line. Use it to automate Hex workflows, create and modify notebook cells, trigger project runs, and inspect workspace state.

Hex projects include notebook (draft) and app (published) views. Users can create and modify cells in a project, and run a project to generate outputs. Hex uses Python and SQL to execute code and query data connections.

Always pass `--json` when you need to parse output programmatically. JSON mode returns structured data; text mode is for human display only.

## Prerequisites

Before running any command, verify the user is authenticated:

```bash
hex auth status
```

If not logged in, prompt the user to run:

```bash
hex auth login
```

All SQL cells require a data connection (usually a data warehouse or sql database). Users should already have data connections configured. Before starting a complex workflow, query for available data connections and prompt the user to ask which one they would like to use:

```bash
hex connections list
```

If a user is using this skill in a repo that defines a warehouse or database schema, clarify if the data connection matches the desired schema. Use their local schema as context in authoring notebook cells queried against that connection.

## Global Flags

These flags work on every command:

| Flag               | Short | Description                                |
| ------------------ | ----- | ------------------------------------------ |
| `--json`           |       | Output as JSON (for scripting and parsing) |
| `--verbose`        | `-v`  | Show verbose output for debugging          |
| `--quiet`          | `-q`  | Suppress non-essential output              |
| `--no-color`       |       | Disable colored output                     |
| `--api-url <url>`  |       | Override API base URL for this command     |
| `--profile <name>` | `-p`  | Use a specific profile for this command    |

## Profile Management

Profiles can be used if the user has multiple Hex accounts or workspaces. Most users just have a single `default` profile.

```bash
# List all profiles, the current profile is marked with a *
hex auth status

# Login with a specific profile name
hex auth login <name>

# Switch active profile, used in all subsequent commands
# This is persisted across sessions
hex auth switch <name>

# Remove a profile
hex auth logout --delete <name>
```

## Command Reference

### auth

```bash
hex auth login    # Log in via browser-based OAuth device flow
hex auth logout   # Log out and clear stored credentials
hex auth status   # Show current authentication status
```

### projects

```bash
# List projects (default limit 25, supports cursor pagination)
hex project list [-n <limit>] [--after <cursor>] [--before <cursor>] \
  [--sort-by <created-at|last-edited-at|last-published-at>] [--sort-direction <asc|desc>] \
  [--status <published|draft|archived>] [--category <name>] \
  [--collection-id <uuid>] [--creator-email <email>] [--owner-email <email>] \
  [--include-archived] [--include-components] [--include-sharing] [--include-trashed]

# Get project details
hex project get <project_id>

# Open project in browser
hex project open <project_id>
```

### cells

```bash
# List cells in a project (default limit 25, supports cursor pagination)
hex cell list <project_id> [-n <limit>] [--after <cursor>] [--before <cursor>]

# Get a single cell
hex cell get <cell_id>

# Create a cell
hex cell create <project_id> \
  -t <code|sql> \
  -s <source> \
  [-l <label>] \
  [--data-connection-id <uuid>] \
  [--output-dataframe <name>] \
  [--after-cell-id <uuid>] \
  [--parent-cell-id <uuid>] \
  [--child-position <first|last>]

# Update a cell
hex cell update <cell_id> \
  [-t <code|sql>] \
  [-s <source>] \
  [--data-connection-id <uuid>] \
  [--output-dataframe <name>]

# Delete a cell
hex cell delete <cell_id>

# Run a cell and its dependencies
hex cell run <cell_id> [--dry-run]
```

### connections

```bash
# List data connections (default limit 25, supports cursor pagination)
hex connection list [-n <limit>] [--after <cursor>] [--before <cursor>] \
  [--sort-by <created-at|name>] [--sort-direction <asc|desc>] \
  [-t <connection_type>]

# Get connection details
hex connection get <connection_id>
```

### collections

```bash
# List collections (default limit 25, supports cursor pagination)
hex collection list [-n <limit>] [--after <cursor>] [--before <cursor>] \
  [--sort-by <name>]

# Get collection details
hex collection get <collection_id>
```

### groups

IMPORTANT: stop and ask permission from a user before making any changes to groups.

```bash
# List groups (default limit 25, supports cursor pagination)
hex group list [-n <limit>] [--after <cursor>] [--before <cursor>] \
  [--sort-by <created-at|name>] [--sort-direction <asc|desc>]

# Get group details
hex group get <group_id>

# Create a group
hex group create <name>

# Delete a group
hex group delete <group_id>
```

### users

```bash
# List users (default limit 25, supports cursor pagination)
hex user list [-n <limit>] [--after <cursor>] [--before <cursor>] \
  [--sort-by <name|email>] [--sort-direction <asc|desc>] \
  [--group-id <uuid>]

# Get user details (by ID or email)
hex user get <user_id_or_email>
```

### suggestions

Suggestions are automatically generated proposed context changes that can include updates to guides, workspace context, data warehouse descriptions, or endorsements to improve agent performance in Hex. Agents and users can review these proposed changes, apply them in their preferred tool of choice, and then mark the suggestion as completed or dismissed.

```bash
# List suggestions (shows open suggestions only by default)
hex suggestion list [-n <limit>] [--after <cursor>] [--before <cursor>] \
  [--sort-by <created-date|evidence-count|last-source-added-date>] \
  [--sort-direction <asc|desc>] \
  [--status <OPEN|COMPLETED|DISMISSED>]

# Get a suggestion's details, including associated warnings and proposed changes
hex suggestion get <suggestion_id>

# Mark a suggestion as completed or dismissed
hex suggestion update <suggestion_id> \
  --status <COMPLETED|DISMISSED> \
  [--dismiss-reason <reason>]

# Mark a proposed change as completed or dismissed
hex suggestion change update <suggestion_id> <change_id> \
  --status <COMPLETED|DISMISSED> \
  --update-target <FILE_UPDATE|DATA_WAREHOUSE_UPDATE> \
  [--dismiss-reason <reason>]
```

Typical workflow:

- List open suggestions using `hex suggestion list`
- Fetch details of an individual suggestion using `hex suggestion get` to inspect the associated warnings and proposed changes
- Review the proposed changes and, for each change, either apply it externally and mark it `COMPLETED`, or ignore it and mark as `DISMISSED`, using `hex suggestion change update`.
- After reviewing all proposed changes, you can close the suggestion by marking it as either `COMPLETED` or `DISMISSED` using `hex suggestion update`

### config

```bash
# Show all configuration
hex config list

# Get a config value
hex config get <key>

# Set a config value
hex config set <key> <value>

# Show config file path
hex config path
```

Config keys: h`update_check`, `logging_enabled`.

### logs

```bash
# Print log contents
hex debug logs [-n <lines>]

# Follow logs (like tail -f)
hex debug logs -f

# Print log file path
hex debug logs --path
```

## Workflow Examples

IMPORTANT: always open the project in a users browser when making changes to cells:

```bash
# opens project in default browser. Also spawns a kernal for executing cells in, which is necessary for running a cell
hex project open "$PROJECT_ID"
```

### Create a project and add cells

```bash
# List projects to find the target
PROJECT_ID=$(hex project list --json | jq -r '.projects[0].id')

# Create a Python code cell
hex cell create "$PROJECT_ID" -t code -s "import pandas as pd
df = pd.read_csv('data.csv')
df.head()"

# Create a SQL cell after the first one
FIRST_CELL=$(hex cell list "$PROJECT_ID" --json | jq -r '.cells[0].id')
hex cell create "$PROJECT_ID" -t sql -s "SELECT * FROM my_table LIMIT 10" \
  --after-cell-id "$FIRST_CELL" --data-connection-id "$DATA_CONNECTION_ID"

# Verify cells were created
hex cell list "$PROJECT_ID"
```

### Discover data connections and create SQL cells

```bash
# List available connections
hex connection list --json

# Ask the user which connection to use, then create a SQL cell with it
CONNECTION_ID="<selected-connection-id>"
hex cell create "$PROJECT_ID" -t sql \
  -s "SELECT count(*) FROM users" \
  --data-connection-id "$CONNECTION_ID" \
  --output-dataframe "user_count"

# Run the cell
CELL_ID=$(hex cell list "$PROJECT_ID" --json | jq -r '.cells[-1].id')
hex cell run "$CELL_ID"
```

### Open, update, and run

```bash
# Get project details
hex project get "$PROJECT_ID" --json

# Open in browser for the user to review
hex project open "$PROJECT_ID"

# List cells and update one
CELLS=$(hex cell list "$PROJECT_ID" --json)
CELL_ID=$(echo "$CELLS" | jq -r '.cells[0].id')
hex cell update "$CELL_ID" -t code -s "print('updated code')"

# Run the updated cell
hex cell run "$CELL_ID"
```

### Run with parameters and monitor

```bash
# Trigger a run with input parameters
hex project run "$PROJECT_ID" \
  -i start_date=2024-01-01 \
  -i end_date=2024-12-31 \
  -i threshold=0.95 \
  --timeout 30m

# Or run async and monitor separately
hex project run "$PROJECT_ID" -i region=us-east-1 --no-wait --json
# Returns: {"run_id": "...", "project_id": "...", "status": "PENDING", "run_url": "..."}

RUN_ID="<run_id from above>"
hex run status "$PROJECT_ID" "$RUN_ID" --watch
```

### Workspace management

```bash
# List users and groups (JSON output includes pagination cursors)
hex user list --json
hex group list --json

# Create a new group
hex group create "Data Engineering"
```

### Troubleshooting a failed run

```bash
# Check run status
hex run status "$PROJECT_ID" "$RUN_ID" --json
# Look at the "status" field: COMPLETED, ERRORED, KILLED, UNABLE_TO_ALLOCATE_KERNEL

# View CLI logs for debugging
hex debug logs -n 50

# If a run is stuck, cancel and retry
hex run cancel "$PROJECT_ID" "$RUN_ID"
hex project run "$PROJECT_ID" --no-cache
```
