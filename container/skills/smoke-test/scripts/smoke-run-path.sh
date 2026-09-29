# Sourced. `$(...)` strips every trailing newline, so an id or path read through
# it can name a sibling (`run<newline>` reads as `run`); these read exactly.
run_id_ok() { [[ ${1-} =~ ^[A-Za-z0-9._-]{1,200}$ && $1 != . && $1 != .. ]]; }

path_base() { local _pb="${2%"${2##*[!/]}"}"; printf -v "$1" '%s' "${_pb##*/}"; }

capture_exact() {
  local _ce
  _ce="$("${@:2}" && printf x)" || return 1
  _ce="${_ce%x}"
  printf -v "$1" '%s' "${_ce%$'\n'}"
}
