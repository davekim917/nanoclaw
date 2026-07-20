---
name: graphify
description: Query NanoClaw's automatic workgroup graph for prior decisions, knowledge work, architecture, lineage, and code relationships.
allowed-tools: Bash(ncl graphify:*)
---

# Graphify host workflow

Graphify is the first navigation aid for work that depends on relationships
across source files, canonical repository clones, conversation history, or
current worktree changes. On the host, select an agent group; the service maps
it to the trusted workgroup boundary:

```bash
ncl graphify query --query "What decisions shaped retention?" --group madison-reed
ncl graphify path --from "retention requirements" --to "customer_ltv.sql" --group madison-reed
ncl graphify explain --node "customer_ltv" --group madison-reed
ncl graphify affected --node "authorizeRequest" --group axie-dev
ncl graphify status --group madison-reed
```

Use the smallest useful read, then open the cited file or conversation
provenance. Graphify is advisory; source and tests are authoritative. Discovery
is automatic and includes tracked, untracked, and gitignored knowledge unless a
narrow `.graphifyignore` excludes it. Ordinary file changes reconcile as
transactional deltas; reads stay responsive on the latest complete generation
while maintenance rebuilds run. Use `status` to observe a newer in-flight
generation, and do not invent a project allowlist or manual freshness workflow.
