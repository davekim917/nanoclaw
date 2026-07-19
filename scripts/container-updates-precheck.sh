#!/usr/bin/env bash
# Deterministic pre-task gate for the weekly repository update advisory.
# The final stdout line must follow task-script.ts's {wakeAgent,data} protocol.
set -u

PROJECT_ROOT="${NANOCLAW_PROJECT_ROOT:-/workspace/project}"
OUTPUT="$(bun "$PROJECT_ROOT/scripts/container-updates.ts" audit --repo "$PROJECT_ROOT" --format task 2>&1)"
STATUS=$?

if [ "$STATUS" -eq 0 ] && printf '%s' "$OUTPUT" | jq -e '.wakeAgent | type == "boolean"' >/dev/null 2>&1; then
  printf '%s\n' "$OUTPUT"
  exit 0
fi

jq -cn --arg error "$OUTPUT" '{wakeAgent:true,data:{schemaVersion:1,error:(if ($error|length)>0 then $error else "container update audit failed without diagnostics" end)}}'
