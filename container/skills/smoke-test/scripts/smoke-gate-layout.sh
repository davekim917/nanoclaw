# Sourced, never run: the one validator for an install's repository-layout
# prefixes. smoke-pr-gate.sh, smoke-develop-gate.sh, smoke-freeze-pr.sh and
# smoke-config-check.sh all read the prefixes through it, so a bad prefix is
# refused before any mode runs instead of mode by mode.
#
# A prefix is a repository-relative directory of plain segments ending in "/"
# (GitHub file names never start "/", "./" or "../"). Anything else silently
# breaks the gate: "api" also matches "api-archive/", "/api/" matches nothing,
# and an empty prefix matches every file (`startswith("")`).

LAYOUT_PREFIX_KEYS="FRONTEND_PREFIX BACKEND_PREFIX MIGRATIONS_PREFIX"
LAYOUT_PREFIX_RE='^([A-Za-z0-9_][A-Za-z0-9._-]*/)+$'

layout_prefix_ok() {  # <value> → status 0 when it is a usable layout prefix
  [[ "$1" =~ $LAYOUT_PREFIX_RE ]]
}

# " SMOKE_GATE_<KEY>" for each named key (default: all three) whose
# SMOKE_GATE_<KEY> environment value is unset, empty or not a usable prefix.
layout_prefix_problems() {  # [<KEY>...]
  local key var
  [ "$#" -gt 0 ] || set -- $LAYOUT_PREFIX_KEYS
  for key in "$@"; do
    var="SMOKE_GATE_$key"
    layout_prefix_ok "${!var:-}" || printf ' %s' "$var"
  done
}
