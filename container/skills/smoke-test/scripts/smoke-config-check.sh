#!/usr/bin/env bash
# Names the required SMOKE_GATE_* keys an install's gate config files lack, and
# the required keys whose values differ between files that both set them. The
# files are read AS DATA with the controller renewer's literal grammar
# (`[export] NAME='v'` | `NAME="v"` with no $, backtick or backslash | bare
# token), never sourced, and no value is ever printed — only names.
#
# Usage: smoke-config-check.sh [<file>...]
#   default files: /workspace/agent/smoke-gate-env.sh /workspace/agent/smoke-develop-gate.sh
#
# One JSON line: {ok, files:[{path, missing:[NAME...]}], mismatched:[NAME...]}
# Exit 0 every required key present everywhere and agreeing · 2 a key missing
# or mismatched · 3 a file unreadable · 4 usage.
set -u

# The gates' own `for k in …` required list (smoke-pr-gate.sh check/poll);
# smoke-config-check.test.sh pins the two equal.
REQUIRED="REPO BACKEND_SERVICE FRONTEND_SERVICE FRONTEND_PREFIX BACKEND_PREFIX MIGRATIONS_PREFIX"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit 4
fi
if [ "$#" -eq 0 ]; then
  set -- /workspace/agent/smoke-gate-env.sh /workspace/agent/smoke-develop-gate.sh
fi

# "=<value>" for the last accepted literal assignment of $2 in $1, else empty.
env_value() {
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$2=('([^']*)'|\"([^\"\$\`\\\\]*)\"|([^[:space:]'\"\$\`\\\\;&|<>()]*))[[:space:]]*(#.*)?\$/=\3\4\5/p" \
    "$1" 2>/dev/null | tail -n 1
}

FILES_JSON='[]'
declare -A SEEN=()      # NAME -> first value seen
declare -A MISMATCH=()  # NAME -> 1 when a later file disagrees
ANY_MISSING=false
for f in "$@"; do
  if [ ! -f "$f" ] || [ ! -r "$f" ]; then
    jq -cn --arg p "$f" '{ok:false,error:"config file is missing or unreadable",path:$p}'
    exit 3
  fi
  missing=()
  for name in $REQUIRED; do
    v="$(env_value "$f" "SMOKE_GATE_$name")"
    if [ -z "$v" ] || [ "$v" = "=" ]; then
      missing+=("SMOKE_GATE_$name")
      continue
    fi
    if [ -n "${SEEN[$name]+x}" ]; then
      [ "${SEEN[$name]}" = "$v" ] || MISMATCH[$name]=1
    else
      SEEN[$name]="$v"
    fi
  done
  [ "${#missing[@]}" -eq 0 ] || ANY_MISSING=true
  FILES_JSON="$(jq -c --arg p "$f" --argjson m "$(printf '%s\n' ${missing[@]+"${missing[@]}"} | jq -Rsc 'split("\n") | map(select(length > 0))')" \
    '. + [{path:$p, missing:$m}]' <<<"$FILES_JSON")"
done

MISMATCHED_JSON='[]'
if [ "${#MISMATCH[@]}" -gt 0 ]; then
  MISMATCHED_JSON="$(printf 'SMOKE_GATE_%s\n' "${!MISMATCH[@]}" | jq -Rsc 'split("\n") | map(select(length > 0)) | sort')"
fi
OK=true
if [ "$ANY_MISSING" = true ] || [ "$MISMATCHED_JSON" != '[]' ]; then OK=false; fi
jq -cn --argjson ok "$OK" --argjson files "$FILES_JSON" --argjson mismatched "$MISMATCHED_JSON" \
  '{ok:$ok, files:$files, mismatched:$mismatched}'
[ "$OK" = true ] && exit 0 || exit 2
