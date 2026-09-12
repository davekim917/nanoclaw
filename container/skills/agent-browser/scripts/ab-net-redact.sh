#!/usr/bin/env bash
# ab-net-redact.sh v5 — fail-closed structural redaction for agent-browser
# network captures (harness security defect: raw network/HAR captures
# persisted bearer tokens to disk before redaction).
#
# This is the ONLY sanctioned way to persist agent-browser network evidence
# to disk. Never redirect `agent-browser network requests/request` output, or
# pass a shared/durable path straight to `agent-browser network har stop`,
# without going through this wrapper first — see SKILL.md.
#
# Usage:
#   ab-net-redact.sh requests [--session <name>] [other network-requests args] > file.json
#   ab-net-redact.sh request <requestId> [--session <name>] > file.json
#   ab-net-redact.sh har-stop <output-path> [--session <name>]
#   ab-net-redact.sh --stdin < raw.json > clean.json
#
# stderr is never merged into a capture; unparsable input is dropped
# (exit 2), never echoed. `har-stop` never leaves a raw HAR file behind and
# never leaves a partially-written output path on failure.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REDACTOR="$HERE/ab-net-redact.py"

if [ "${1:-}" = "--stdin" ]; then
  exec python3 "$REDACTOR"
fi

if [ "${1:-}" = "har-stop" ]; then
  shift
  OUT_PATH="${1:-}"
  if [ -z "$OUT_PATH" ]; then
    echo "ab-net-redact.sh har-stop: missing <output-path>" >&2
    exit 2
  fi
  shift || true

  TMP_HAR="$(mktemp "${TMPDIR:-/tmp}/ab-net-raw.XXXXXX.har")"
  TMP_OUT="$(mktemp "${TMPDIR:-/tmp}/ab-net-redacted.XXXXXX.json")"
  # Always shred the raw capture and the scratch output, on every exit path —
  # a raw HAR (bearer tokens, cookies, unredacted bodies) must never survive
  # this function, success or failure.
  cleanup() { rm -f "$TMP_HAR" "$TMP_OUT"; }
  trap cleanup EXIT

  if ! agent-browser network har stop "$TMP_HAR" "$@" 2>/dev/null; then
    echo "ab-net-redact.sh har-stop: agent-browser network har stop failed" >&2
    exit 1
  fi
  if [ ! -s "$TMP_HAR" ]; then
    echo "ab-net-redact.sh har-stop: no HAR captured (empty or missing)" >&2
    exit 1
  fi
  if ! python3 "$REDACTOR" < "$TMP_HAR" > "$TMP_OUT"; then
    echo "ab-net-redact.sh har-stop: redaction failed; raw HAR discarded, no output written" >&2
    exit 1
  fi
  # Only now, after the raw file is redacted end to end, does anything reach
  # the caller-chosen (possibly shared/durable) path — and via mv, never a
  # partial write visible mid-copy.
  mv "$TMP_OUT" "$OUT_PATH"
  exit 0
fi

if [ "${1:-}" = "request" ] || [ "${1:-}" = "requests" ]; then
  SUB="$1"
  shift
  HAS_JSON=0
  for a in "$@"; do [ "$a" = "--json" ] && HAS_JSON=1; done
  if [ "$HAS_JSON" -eq 1 ]; then
    agent-browser network "$SUB" "$@" 2>/dev/null | python3 "$REDACTOR"
  else
    agent-browser network "$SUB" "$@" --json 2>/dev/null | python3 "$REDACTOR"
  fi
  rc=("${PIPESTATUS[@]}")
  [ "${rc[0]}" -eq 0 ] && [ "${rc[1]}" -eq 0 ]
  exit $?
fi

echo "ab-net-redact.sh: unknown usage; expected 'requests', 'request <id>', 'har-stop <path>', or '--stdin'" >&2
exit 2
