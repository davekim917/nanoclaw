# Sourced by smoke-pr-gate.sh (GATE_VERB is set by the caller).
#
# The scheduled poll declares an observation on every line that does not wake
# (task-observation skill, W2). The helper prints and validates it; its
# observation is merged into the gate's own line, so every existing key stays
# and the live controller, which runs `poll` as its gate command, reads the
# same fields as before. Bound 30m: three */10 polls. A poll that could not
# read GitHub is unreadable; one refused its config, its preflight, its PR
# lock or a shared lease is blocked; waiting for a candidate, or a lease held
# by a live coordinator, is empty.
OBS_HELPER="${SMOKE_OBSERVATION_HELPER:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)/task-observation/task_observation.py}"
declare_quiet() { # <line> -- print it, with its observation when this is a quiet poll
  local line="$1" kind obs
  if [ "$GATE_VERB" != poll ] || [ "$(jq -r '.wakeAgent' <<<"$line" 2>/dev/null)" != false ]; then
    printf '%s\n' "$line"; return 0
  fi
  case "$(jq -r '.data.trigger // empty' <<<"$line")" in
    gate_fetch_failed) kind=unreadable ;;
    gate_misconfigured|pr_preflight_failed|gate_lock_failed) kind=blocked ;;
    coordinator_lease_unavailable)
      if jq -e '(.data.detail.leaseOwner // null) != null or .data.detail.retryable == true' <<<"$line" >/dev/null 2>&1
      then kind=empty; else kind=blocked; fi ;;
    *) kind=empty ;;
  esac
  obs="$(python3 "$OBS_HELPER" --kind "$kind" --bound 30m --evidence-json "$(jq -c '.data' <<<"$line")")" || return 1
  jq -c --argjson o "$obs" '. + {observation: $o.observation}' <<<"$line"
}
