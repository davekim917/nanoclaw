# Sourced, never run: the one validator for an install's repository-layout
# prefixes. smoke-pr-gate.sh, smoke-develop-gate.sh and smoke-freeze-pr.sh all
# read the prefixes through it, so a bad prefix is refused before any mode runs
# instead of mode by mode, and each gate's `config` verb reports the same names.
#
# A prefix is a repository-relative directory of plain segments ending in "/"
# (GitHub file names never start "/", "./" or "../"). Anything else silently
# breaks the gate: "api" also matches "api-archive/", "/api/" matches nothing,
# and an empty prefix matches every file (`startswith("")`). The prefixes are
# also pairwise distinct: equal backend and frontend prefixes collapse the two
# freeze markers into one path, and a migrations prefix equal to either service
# prefix classes every file under it as a migration. Nesting (migrations under
# the backend) is the normal layout and stays allowed.

LAYOUT_PREFIX_KEYS="FRONTEND_PREFIX BACKEND_PREFIX MIGRATIONS_PREFIX"
LAYOUT_PREFIX_RE='^([A-Za-z0-9_][A-Za-z0-9._-]*/)+$'

layout_prefix_ok() {  # <value> → status 0 when it is a usable layout prefix
  [[ "$1" =~ $LAYOUT_PREFIX_RE ]]
}

# " SMOKE_GATE_<KEY>" for each named key (default: all three) whose
# SMOKE_GATE_<KEY> environment value is unset, empty, not a usable prefix, or
# equal to another named key's, in key order.
layout_prefix_problems() {  # [<KEY>...]
  local key other var bad=" "
  [ "$#" -gt 0 ] || set -- $LAYOUT_PREFIX_KEYS
  for key in "$@"; do
    var="SMOKE_GATE_$key"
    layout_prefix_ok "${!var:-}" || { bad="$bad$var "; continue; }
    for other in "$@"; do
      other="SMOKE_GATE_$other"
      if [ "$other" != "$var" ] && [ "${!other:-}" = "${!var}" ]; then bad="$bad$var "; break; fi
    done
  done
  for key in "$@"; do
    case "$bad" in *" SMOKE_GATE_$key "*) printf ' SMOKE_GATE_%s' "$key" ;; esac
  done
}
