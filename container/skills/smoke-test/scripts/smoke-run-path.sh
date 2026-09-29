# Sourced, never run. The one run-id grammar, and the one way to read a run
# directory's name or a resolved path back exactly. `$(...)` strips every
# trailing newline, so `$(basename "$RUN_DIR")` for a directory named
# `run<newline>` answers `run`, the name of its sibling.

# A run id names files under the state and lease dirs: 1-200 of
# [A-Za-z0-9._-], never `.` or `..`. `[[ =~ ]]` matches the whole string,
# where `grep` accepts a value if any one of its lines matches.
run_id_ok() { [[ ${1-} =~ ^[A-Za-z0-9._-]{1,200}$ && $1 != . && $1 != .. ]]; }

# path_base <var> <path>: the last component of <path>, as `basename` prints it.
path_base() { local _pb="${2%"${2##*[!/]}"}"; printf -v "$1" '%s' "${_pb##*/}"; }

# capture_exact <var> <command> [arg...]: the command's stdout minus only the
# one newline it ends with; fails when the command does.
capture_exact() {
  local _ce
  _ce="$("${@:2}" && printf x)" || return 1
  _ce="${_ce%x}"
  printf -v "$1" '%s' "${_ce%$'\n'}"
}
