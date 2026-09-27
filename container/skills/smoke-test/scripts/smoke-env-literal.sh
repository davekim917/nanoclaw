# Sourced, never run: reads an install env file AS DATA, never sourcing it, with
# one literal grammar: `[export] NAME='v'` | `NAME="v"` with no $, backtick or
# backslash | a bare token. smoke-controller-renew.sh builds its gate calls from
# it, and smoke-develop-gate.sh compares its layout prefixes against it.

controller_env_file() {  # → the env file the controller renewer reads and the PR gate wrapper sources
  printf '%s' "${SMOKE_CONTROLLER_ENV_FILE:-/workspace/agent/smoke-gate-env.sh}"
}

env_file_names() {  # <file> → every name the file assigns or unsets, first mention first
  [ -f "$1" ] || return 0
  {
    sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*$/\2/p' "$1"
    sed -n -E 's/^[[:space:]]*unset[[:space:]]+([A-Za-z_][A-Za-z0-9_[:space:]]*)$/\1/p' "$1" | tr -s '[:space:]' '\n'
  } 2>/dev/null | awk 'NF && !seen[$0]++'
}

env_literal_re() {  # <name> → the ERE for one literal assignment of <name>; groups 3-5 hold the value
  printf '%s' "^[[:space:]]*(export[[:space:]]+)?$1=('([^']*)'|\"([^\"\$\`\\\\]*)\"|([^[:space:]'\"\$\`\\\\;&|<>()]*))[[:space:]]*(#.*)?\$"
}

env_file_value() {  # <file> <name> → "=<value>" for the last accepted literal, else empty
  # The "=" prefix is what distinguishes an EMPTY literal (`FOO=`, which is a
  # value) from "no literal assignment at all".
  [ -f "$1" ] || return 0
  sed -n -E "s/$(env_literal_re "$2")/=\3\4\5/p" "$1" 2>/dev/null | tail -n 1
}

env_file_unsets() {  # <file> <name> → status 0 when the file unsets <name>
  grep -Eq "^[[:space:]]*unset[[:space:]]+([A-Za-z_][A-Za-z0-9_]*[[:space:]]+)*$2([[:space:]]|\$)" "$1" 2>/dev/null
}

env_file_nonliteral() {  # <file> <name> → status 0 when some assignment of <name> is not a literal
  local assigned literal
  assigned="$(grep -cE "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" 2>/dev/null)"
  literal="$(grep -cE "$(env_literal_re "$2")" "$1" 2>/dev/null)"
  [ "${assigned:-0}" -gt "${literal:-0}" ]
}
