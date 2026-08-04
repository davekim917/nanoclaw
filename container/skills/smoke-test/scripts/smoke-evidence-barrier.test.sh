#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

mkdir -p "$FIXTURE_DIR/coordinator" "$FIXTURE_DIR/challenger"

cat >"$FIXTURE_DIR/completion-contract.json" <<'JSON'
{
  "schemaVersion": 1,
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "requiredLaneMarkers": [
    "coordinator/browser.complete.json",
    "challenger/challenge.complete.json"
  ]
}
JSON

if bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FIXTURE_DIR" lanes >/dev/null 2>&1; then
  echo "expected missing markers to block lanes phase" >&2
  exit 1
fi

cat >"$FIXTURE_DIR/coordinator/browser.complete.json" <<'JSON'
{
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "status": "blocked",
  "completedAt": "2026-08-04T20:00:00Z"
}
JSON

cat >"$FIXTURE_DIR/challenger/challenge.complete.json" <<'JSON'
{
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "status": "fail",
  "completedAt": "2026-08-04T20:01:00Z"
}
JSON

bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FIXTURE_DIR" lanes \
  | jq -e '.ready == true and .phase == "lanes"' >/dev/null

if bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FIXTURE_DIR" synthesis >/dev/null 2>&1; then
  echo "expected missing parent conclusions to block synthesis" >&2
  exit 1
fi

printf '%s\n' '# independent coordinator preliminary' >"$FIXTURE_DIR/coordinator/preliminary.md"
printf '%s\n' '# independent challenger disposition' >"$FIXTURE_DIR/challenger/disposition.md"

bash "$SCRIPT_DIR/smoke-evidence-barrier.sh" "$FIXTURE_DIR" synthesis \
  | jq -e '.ready == true and .phase == "synthesis"' >/dev/null

echo "smoke evidence barrier tests passed"
