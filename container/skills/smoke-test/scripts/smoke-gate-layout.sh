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
#
# SMOKE_GATE_MIGRATIONS_PREFIX alone may list several trees, comma-separated
# (`api/migrations/,data/migrations/`): each element is checked like a single
# prefix and against every other element and prefix. The frontend and backend
# prefixes stay single values, because each names exactly one freeze marker.

LAYOUT_PREFIX_KEYS="FRONTEND_PREFIX BACKEND_PREFIX MIGRATIONS_PREFIX"
LAYOUT_PREFIX_RE='^([A-Za-z0-9_][A-Za-z0-9._-]*/)+$'

layout_prefix_ok() {  # <value> → status 0 when it is a usable layout prefix
  [[ "$1" =~ $LAYOUT_PREFIX_RE ]]
}

# The prefixes <KEY>'s <value> holds, one per line. Empty elements are kept, so
# "a/,,b/" and a trailing comma are refused rather than skipped.
layout_prefix_elements() {  # <KEY> <value>
  if [ "$1" = MIGRATIONS_PREFIX ]; then printf '%s\n' "$2" | tr ',' '\n'; else printf '%s\n' "$2"; fi
}

# <value> as a canonical comma list (sorted, one of each), so two files that
# list the same migrations trees in a different order compare equal.
layout_prefix_normalize() {  # <KEY> <value>
  layout_prefix_elements "$1" "$2" | sort -u | paste -sd, -
}

# " SMOKE_GATE_<KEY>" for each named key (default: all three) whose
# SMOKE_GATE_<KEY> environment value is unset, empty or not a usable prefix,
# holds an element equal to another element or another named key's prefix,
# in key order. A collision names both keys.
layout_prefix_problems() {  # [<KEY>...]
  local key var el other bad=" " seen=""
  [ "$#" -gt 0 ] || set -- $LAYOUT_PREFIX_KEYS
  for key in "$@"; do
    var="SMOKE_GATE_$key"
    while IFS= read -r el; do
      layout_prefix_ok "$el" || { bad="$bad$var "; continue; }
      other="$(printf '%s' "$seen" | awk -F '\t' -v e="$el" '$1 == e { print $2; exit }')"
      if [ -n "$other" ]; then bad="$bad$var $other "; else seen="$seen$el	$var
"; fi
    done < <(layout_prefix_elements "$key" "${!var:-}")
  done
  for key in "$@"; do
    case "$bad" in *" SMOKE_GATE_$key "*) printf ' SMOKE_GATE_%s' "$key" ;; esac
  done
}
