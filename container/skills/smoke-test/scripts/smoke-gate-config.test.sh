#!/usr/bin/env bash
# The gates' `config` verb: the go-time check an operator runs through each
# wrapper. It judges the environment the wrapper hands the gate, answers with
# key names only, and touches no state, lock or network. Fictional install.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAIL=0
fail() { echo "  FAIL $1" >&2; FAIL=1; }
ok() { echo "  ok   $1"; }

# Anything remote the gate could reach is a shim that records the call.
mkdir -p "$T/shim"
for tool in gh curl git; do
  printf '#!/usr/bin/env bash\necho "%s $*" >>"%s/remote-calls"\nexit 1\n' "$tool" "$T" >"$T/shim/$tool"
  chmod +x "$T/shim/$tool"
done

# A fake deployment root: a lease, the handoff files and a PR state dir exist
# and must stay byte-identical; the gate's own state dir does not exist yet and
# must not be created.
fixture() {
  rm -rf "$T/fx"; mkdir -p "$T/fx/shared/qa-coordinator/leases" "$T/fx/pr-state"
  echo '{"owner":"lane-a"}' >"$T/fx/shared/qa-coordinator/leases/develop.json"
  echo '{"activeRunId":null}' >"$T/fx/pr-state/pr-7-state.json"
  echo '{}' >"$T/fx/publish.json"; echo '{}' >"$T/fx/hold.json"; : >"$T/fx/ledger.jsonl"
}
snapshot() {
  (cd "$T/fx" && find . -printf '%p %y %s %m %T@\n' | sort && find . -type f -exec sha256sum {} + | sort)
}

# The PR gate's env file, which the develop gate reads as data and must agree with.
printf '%s\n' 'export SMOKE_GATE_FRONTEND_PREFIX=web/' 'export SMOKE_GATE_BACKEND_PREFIX=api/' \
  'export SMOKE_GATE_MIGRATIONS_PREFIX=api/migrations/' >"$T/controller-env.sh"
BASE_ENV=(
  SMOKE_CONTROLLER_ENV_FILE="$T/controller-env.sh"
  PATH="$T/shim:$PATH" HOME="$T"
  SMOKE_GATE_REPO=acme/widget SMOKE_GATE_BACKEND_SERVICE=srv-acme-api SMOKE_GATE_FRONTEND_SERVICE=srv-acme-web
  SMOKE_GATE_FRONTEND_PREFIX=web/ SMOKE_GATE_BACKEND_PREFIX=api/ SMOKE_GATE_MIGRATIONS_PREFIX=api/migrations/
  SMOKE_GATE_STATE_DIR="$T/fx/state" SMOKE_GATE_SHARED_ROOT="$T/fx/shared" SMOKE_GATE_PR_STATE_DIR="$T/fx/pr-state"
  SMOKE_GATE_PUBLISH_FILE="$T/fx/publish.json" SMOKE_GATE_HOLD_FILE="$T/fx/hold.json" SMOKE_GATE_HANDOFF_LEDGER="$T/fx/ledger.jsonl"
  SMOKE_GATE_DEV_URL=https://dev.acme.example SMOKE_GATE_FREEZE_HANDOFF=true SMOKE_GATE_FREEZE_HELPER="$SCRIPT_DIR/smoke-freeze-pr.sh"
)
run_config() { # <gate> [KEY=value...] -- env -i: nothing ambient reaches the gate
  local gate="$1"; shift
  env -i "${BASE_ENV[@]}" "$@" bash "$gate" config 2>/dev/null
}

for name in smoke-pr-gate.sh smoke-develop-gate.sh; do
  GATE="$SCRIPT_DIR/$name"
  echo "$name"

  # --- valid env: ok, exit 0, and nothing touched ------------------------------
  fixture; rm -f "$T/remote-calls"; BEFORE="$(snapshot)"
  OUT="$(run_config "$GATE")"; RC=$?
  [ "$RC" -eq 0 ] && jq -e '. == {ok:true}' <<<"$OUT" >/dev/null && ok "valid env: ok" || fail "$name valid: rc=$RC $OUT"
  [ "$(snapshot)" = "$BEFORE" ] && ok "state, lease and handoff files byte-identical; no state dir" \
    || fail "$name config changed the deployment state: $(diff <(echo "$BEFORE") <(snapshot) | head -5)"
  [ ! -e "$T/remote-calls" ] && ok "nothing remote called" || fail "$name config called: $(cat "$T/remote-calls")"

  # --- missing, invalid, unexported: exit 1 with the names, never a value ------
  OUT="$(run_config "$GATE" SMOKE_GATE_REPO=)"; RC=$?
  [ "$RC" -eq 1 ] && jq -e '.ok == false and .missing == ["SMOKE_GATE_REPO"]' <<<"$OUT" >/dev/null \
    && ok "missing key named" || fail "$name missing: rc=$RC $OUT"
  OUT="$(run_config "$GATE" SMOKE_GATE_BACKEND_PREFIX=../api/)"; RC=$?
  [ "$RC" -eq 1 ] && jq -e '.missing == ["SMOKE_GATE_BACKEND_PREFIX"]' <<<"$OUT" >/dev/null \
    && ok "invalid prefix named" || fail "$name invalid prefix: rc=$RC $OUT"
  OUT="$(run_config "$GATE" SMOKE_GATE_FRONTEND_PREFIX=api/)"; RC=$?
  [ "$RC" -eq 1 ] && jq -e '.missing == ["SMOKE_GATE_FRONTEND_PREFIX","SMOKE_GATE_BACKEND_PREFIX"]' <<<"$OUT" >/dev/null \
    && ok "equal prefixes named" || fail "$name equal prefixes: rc=$RC $OUT"
  OUT="$(run_config "$GATE" SMOKE_GATE_LOCK_WAIT_SECONDS=15s)"; RC=$?
  [ "$RC" -eq 1 ] && jq -e '.missing == ["SMOKE_GATE_LOCK_WAIT_SECONDS"]' <<<"$OUT" >/dev/null \
    && ok "non-numeric knob named" || fail "$name bad knob: rc=$RC $OUT"
  grep -q 'acme\|srv-\|15s' <<<"$OUT" && fail "$name output leaked a value: $OUT" || ok "names only"
  # Through a wrapper, as an operator runs it: a key the wrapper sets without
  # exporting never reaches the gate.
  printf 'set -u\nSMOKE_GATE_BACKEND_PREFIX=api/\nexec bash "%s" "$@"\n' "$GATE" >"$T/wrap-unexported.sh"
  OUT="$(env -i "${BASE_ENV[@]}" env -u SMOKE_GATE_BACKEND_PREFIX bash "$T/wrap-unexported.sh" config 2>/dev/null)"; RC=$?
  [ "$RC" -eq 1 ] && jq -e '.missing == ["SMOKE_GATE_BACKEND_PREFIX"]' <<<"$OUT" >/dev/null \
    && ok "unexported key named through the wrapper" || fail "$name unexported: rc=$RC $OUT"
  printf 'set -u\nexport SMOKE_GATE_BACKEND_PREFIX=api/\nexec bash "%s" "$@"\n' "$GATE" >"$T/wrap-exported.sh"
  OUT="$(env -i "${BASE_ENV[@]}" env -u SMOKE_GATE_BACKEND_PREFIX bash "$T/wrap-exported.sh" config 2>/dev/null)"; RC=$?
  [ "$RC" -eq 0 ] && ok "exported key accepted through the wrapper" || fail "$name exported: rc=$RC $OUT"
  fixture; BEFORE="$(snapshot)"; run_config "$GATE" SMOKE_GATE_REPO= >/dev/null
  [ "$(snapshot)" = "$BEFORE" ] && ok "a refusing config is side-effect-free too" || fail "$name refusing config changed state"

  # --- mutation: the same check catches config dispatched after state init -----
  rm -rf "$T/mut"; mkdir "$T/mut"
  for f in "$SCRIPT_DIR"/*; do ln -s "$f" "$T/mut/"; done
  rm "$T/mut/$name"
  python3 - "$GATE" "$T/mut/$name" <<'PY'
import sys
src, dst = sys.argv[1:3]
lines = open(src).read().split("\n")
dispatch = '[ "$COMMAND" != config ] || config_verb'
assert lines.count(dispatch) == 1, "config dispatch line not found"
lines.remove(dispatch)
lines.insert(lines.index('mkdir -p "$STATE_DIR"') + 1, dispatch)
open(dst, "w").write("\n".join(lines))
PY
  fixture; BEFORE="$(snapshot)"; run_config "$T/mut/$name" >/dev/null
  [ "$(snapshot)" != "$BEFORE" ] && ok "mutant dispatching config after state init is caught" \
    || fail "$name: the snapshot check cannot see config dispatched after state init"
done

# The PR gate's preview-provider keys are part of the same refusal list.
GATE="$SCRIPT_DIR/smoke-pr-gate.sh"
OUT="$(run_config "$GATE" SMOKE_PREVIEW_PROVIDER=elsewhere)"; RC=$?
[ "$RC" -eq 1 ] && jq -e '.missing == ["SMOKE_PREVIEW_PROVIDER"]' <<<"$OUT" >/dev/null \
  && ok "unknown preview provider named" || fail "unknown provider: rc=$RC $OUT"
OUT="$(run_config "$GATE" SMOKE_PREVIEW_PROVIDER=static)"; RC=$?
[ "$RC" -eq 1 ] && jq -e '.missing == ["SMOKE_GATE_FRONTEND_SERVICE","SMOKE_GATE_BACKEND_SERVICE"]' <<<"$OUT" >/dev/null \
  && ok "static provider without URL templates named" || fail "static no template: rc=$RC $OUT"
OUT="$(run_config "$GATE" SMOKE_PREVIEW_PROVIDER=static SMOKE_GATE_FRONTEND_SERVICE='https://web-pr-{pr}.acme.example' SMOKE_GATE_BACKEND_SERVICE=)"; RC=$?
[ "$RC" -eq 1 ] && jq -e '.missing == ["SMOKE_GATE_BACKEND_SERVICE"]' <<<"$OUT" >/dev/null \
  && ok "an empty template is named once" || fail "static empty: rc=$RC $OUT"
OUT="$(run_config "$GATE" SMOKE_PREVIEW_PROVIDER=static SMOKE_GATE_FRONTEND_SERVICE='https://web.acme.example/?pr={pr}&x=1' SMOKE_GATE_BACKEND_SERVICE='https://{branch}.api.acme.example')"; RC=$?
[ "$RC" -eq 1 ] && jq -e '.missing == ["SMOKE_GATE_FRONTEND_SERVICE"]' <<<"$OUT" >/dev/null \
  && ok "a template with a query or shell metacharacter named" || fail "static unsafe template: rc=$RC $OUT"
OUT="$(run_config "$GATE" SMOKE_PREVIEW_PROVIDER=static SMOKE_GATE_FRONTEND_SERVICE='https://web-pr-{pr}.acme.example' SMOKE_GATE_BACKEND_SERVICE='https://{branch}.api.acme.example')"; RC=$?
[ "$RC" -eq 0 ] && ok "static provider with templates ok" || fail "static ok: rc=$RC $OUT"

# The develop gate's config also enforces agreement with the PR gate's env file,
# and dropping that comparison is caught.
GATE="$SCRIPT_DIR/smoke-develop-gate.sh"
printf '%s\n' 'export SMOKE_GATE_FRONTEND_PREFIX=web/' 'export SMOKE_GATE_BACKEND_PREFIX=server/' \
  'export SMOKE_GATE_MIGRATIONS_PREFIX=api/migrations/' >"$T/controller-env-diverged.sh"
OUT="$(run_config "$GATE" SMOKE_CONTROLLER_ENV_FILE="$T/controller-env-diverged.sh")"; RC=$?
[ "$RC" -eq 1 ] && jq -e '.missing == ["SMOKE_GATE_BACKEND_PREFIX"]' <<<"$OUT" >/dev/null && ! grep -q 'server/' <<<"$OUT" \
  && ok "develop config names a prefix the PR gate's env file states differently" || fail "develop disagreement: rc=$RC $OUT"
rm -rf "$T/mut"; mkdir "$T/mut"
for f in "$SCRIPT_DIR"/*; do ln -s "$f" "$T/mut/"; done
rm "$T/mut/smoke-develop-gate.sh"
grep -v 'LAYOUT_MISSING="$LAYOUT_MISSING$(prefix_agreement_problems)"' "$GATE" >"$T/mut/smoke-develop-gate.sh"
! cmp -s "$GATE" "$T/mut/smoke-develop-gate.sh" || fail "mutation: the agreement line was not found to remove"
OUT="$(run_config "$T/mut/smoke-develop-gate.sh" SMOKE_CONTROLLER_ENV_FILE="$T/controller-env-diverged.sh")"; RC=$?
[ "$RC" -eq 0 ] && ok "mutant without the comparison accepts the divergence (so the check above is what refuses it)" \
  || fail "mutation not observable: rc=$RC $OUT"

[ "$FAIL" -eq 0 ] && echo "PASS smoke-gate-config.test.sh" || { echo "FAIL smoke-gate-config.test.sh" >&2; exit 1; }
