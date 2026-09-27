#!/usr/bin/env bash
# Names the required SMOKE_GATE_* keys an install's gate config files leave the
# gate without, and the required keys whose values differ between files that
# both set them. Each file is sourced the way its wrapper sources it — in a
# clean `env -i` shell that keeps only PATH — and judged by the gates' own
# checks (smoke-gate-layout.sh for the prefixes), so this check and the gate
# agree by construction. No value is ever printed — only names.
#
# Usage: smoke-config-check.sh [<file>...]
#   default files: /workspace/agent/smoke-gate-env.sh /workspace/agent/smoke-develop-gate.sh
#
# One JSON line: {ok, files:[{path, missing:[NAME...], malformed:[NAME...]}], mismatched:[NAME...]}
# A *_PREFIX that is not a relative dir of plain segments ending in "/", or equals another prefix, is malformed.
# Exit 0 every required key present, well-formed and agreeing everywhere · 2 a
# key missing, malformed or mismatched · 3 a file unreadable or failing to source · 4 usage.
set -u

# The gate's own `for k in …` required list (smoke-pr-gate.sh check/poll;
# smoke-config-check.test.sh pins the two equal). The layout prefixes are
# judged inside the probe by the validator the gates source.
GATE_REQUIRED="REPO BACKEND_SERVICE FRONTEND_SERVICE"
LAYOUT="$(dirname -- "${BASH_SOURCE[0]}")/smoke-gate-layout.sh"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 4
fi
if [ "$#" -eq 0 ]; then
  set -- /workspace/agent/smoke-gate-env.sh /workspace/agent/smoke-develop-gate.sh
fi

# Runs under `env -i`, with its findings on fd 3 and the sourced file's own
# output discarded. A wrapper hands off to its gate with a plain `exec`, so
# `exec` is shadowed by a function that reports and exits there: the gate never
# starts. A wrapper that reaches its gate another way (`builtin exec`, a plain
# call) WOULD start it, so point this only at env files and exec-ending wrappers.
PROBE='
. "$1"; FILE="$2"; NONCE="$3"; shift 3; GATE_REQUIRED="$*"
report() {
  local k var
  for k in $GATE_REQUIRED; do
    var="SMOKE_GATE_$k"; [ -n "${!var:-}" ] || echo "missing $var" >&3
  done
  for var in $(layout_prefix_problems); do
    if [ -n "${!var:-}" ]; then echo "malformed $var" >&3; else echo "missing $var" >&3; fi
  done
  for k in $GATE_REQUIRED $LAYOUT_PREFIX_KEYS; do
    var="SMOKE_GATE_$k"
    [ -z "${!var:-}" ] || echo "value $var $(printf "%s" "${!var}" | sha256sum | cut -d" " -f1)" >&3
  done
  echo "done $NONCE" >&3
  builtin exit 0
}
exec() { report; }
. "$FILE"
report
'

names_json() { printf '%s\n' "$@" | jq -Rsc 'split("\n") | map(select(length > 0))'; }

FILES_JSON='[]'
declare -A SEEN=()      # NAME -> value hash from the first file that set it
declare -A MISMATCH=()  # NAME -> 1 when a later file disagrees
ANY_MISSING=false
for f in "$@"; do
  if [ ! -f "$f" ] || [ ! -r "$f" ]; then
    jq -cn --arg p "$f" '{ok:false,error:"config file is missing or unreadable",path:$p}'
    exit 3
  fi
  NONCE="$RANDOM$RANDOM$RANDOM"
  RESULT="$(env -i PATH="$PATH" timeout 20 bash -c "$PROBE" probe "$LAYOUT" "$f" "$NONCE" $GATE_REQUIRED \
    3>&1 >/dev/null 2>/dev/null </dev/null)"
  if [ "$(tail -n 1 <<<"$RESULT")" != "done $NONCE" ]; then
    jq -cn --arg p "$f" '{ok:false,error:"config file failed to source",path:$p}'
    exit 3
  fi
  mapfile -t missing < <(sed -n 's/^missing //p' <<<"$RESULT")
  mapfile -t malformed < <(sed -n 's/^malformed //p' <<<"$RESULT")
  while read -r _ name hash; do
    if [ -n "${SEEN[$name]+x}" ]; then
      [ "${SEEN[$name]}" = "$hash" ] || MISMATCH[$name]=1
    else
      SEEN[$name]="$hash"
    fi
  done < <(grep '^value ' <<<"$RESULT")
  [ "${#missing[@]}" -eq 0 ] && [ "${#malformed[@]}" -eq 0 ] || ANY_MISSING=true
  FILES_JSON="$(jq -c --arg p "$f" --argjson m "$(names_json ${missing[@]+"${missing[@]}"})" \
    --argjson bad "$(names_json ${malformed[@]+"${malformed[@]}"})" \
    '. + [{path:$p, missing:$m, malformed:$bad}]' <<<"$FILES_JSON")"
done

MISMATCHED_JSON='[]'
if [ "${#MISMATCH[@]}" -gt 0 ]; then
  MISMATCHED_JSON="$(names_json "${!MISMATCH[@]}" | jq -c 'sort')"
fi
OK=true
if [ "$ANY_MISSING" = true ] || [ "$MISMATCHED_JSON" != '[]' ]; then OK=false; fi
jq -cn --argjson ok "$OK" --argjson files "$FILES_JSON" --argjson mismatched "$MISMATCHED_JSON" \
  '{ok:$ok, files:$files, mismatched:$mismatched}'
[ "$OK" = true ] && exit 0 || exit 2
