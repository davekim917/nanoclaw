# Self-mod module

Optional-tier module that gives agents admin-gated self-modification:
installing OS/npm packages, rebuilding the container image, and registering
new MCP servers. All three paths go through the approvals module's request
primitive — no unapproved changes ever land.

## What this module adds

- Three delivery actions (`install_packages`, `request_rebuild`, `add_mcp_server`)
  that the container's self-mod MCP tools write into outbound.db. On the host,
  each handler validates input and queues an approval via
  `approvals.requestApproval()`.
- Three matching approval handlers that run on approve: mutate the container
  config via `updateContainerConfig`, rebuild the image via
  `buildAgentGroupImage`, and kill the container so the host sweep respawns
  it on the new image.

## Dependency

Self-mod depends on the approvals default module for:
- `requestApproval()` to enqueue admin confirmation cards
- `registerApprovalHandler(action, handler)` to run orchestration on approve
- `notifyAgent()` to send failure feedback back to the requesting agent

It also calls core's `buildAgentGroupImage`, `killContainer`, and
`updateContainerConfig`.

## Removing the module

Delete `src/modules/self-mod/` and its import line in `src/modules/index.ts`.
The container's self-mod MCP tools will still write outbound system messages,
but core delivery will log `"Unknown system action"` and drop them — no
admin card, no container mutation.
