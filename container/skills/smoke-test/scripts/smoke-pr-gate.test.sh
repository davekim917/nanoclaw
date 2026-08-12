#!/usr/bin/env bash
# Misconfig fail-closed wake, empty-label-set idle, the settle happy path,
# deploy-SHA mismatch, the freeze-PR parent-CI substitution, migrations
# refusal, claim/finish lifecycle, finish-suspends, and finish refused from a
# non-active run. gh and curl are stubbed via PATH so every scenario runs
# offline against fixtures, same pattern as smoke-develop-gate.test.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/smoke-pr-gate.sh"

STUB_BIN="$(mktemp -d)"
cleanup() { rm -rf "$STATE_DIR" "$STUB_BIN"; }
trap cleanup EXIT

cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -u
# Plain ${VAR:=default} mis-parses once the default itself contains braces
# and quotes (bash reads the embedded `{`/`}`/`"` as shell syntax, not text),
# so every JSON default here is set with an explicit is-it-set-at-all guard
# instead.
[ -n "${STUB_PR_LIST+x}" ] || STUB_PR_LIST='[]'
[ -n "${STUB_PR_VIEW+x}" ] || STUB_PR_VIEW='{}'
[ -n "${STUB_PR_FILES+x}" ] || STUB_PR_FILES='[]'
[ -n "${STUB_CHECK_RUNS+x}" ] || STUB_CHECK_RUNS='{"check_runs":[]}'
[ -n "${STUB_PARENT_SHA+x}" ] || STUB_PARENT_SHA=''
[ -n "${STUB_COMMIT_TREE+x}" ] || STUB_COMMIT_TREE='{"tree":{"sha":"tree-abc"}}'
[ -n "${STUB_BLOB_RESPONSE+x}" ] || STUB_BLOB_RESPONSE='{"sha":"blob-abc"}'
[ -n "${STUB_TREE_RESPONSE+x}" ] || STUB_TREE_RESPONSE='{"sha":"tree-new"}'
[ -n "${STUB_COMMIT_RESPONSE+x}" ] || STUB_COMMIT_RESPONSE='{"sha":"freeze-sha-abc"}'
[ -n "${STUB_REF_RESPONSE+x}" ] || STUB_REF_RESPONSE='{"ref":"refs/heads/x"}'
[ -n "${STUB_BRANCH_EXISTS+x}" ] || STUB_BRANCH_EXISTS=false
[ -n "${STUB_PR_LIST_EXIT+x}" ] || STUB_PR_LIST_EXIT=0
[ -n "${STUB_PR_FILES_EXIT+x}" ] || STUB_PR_FILES_EXIT=0

case "$1" in
  pr)
    case "$2" in
      list) printf '%s' "$STUB_PR_LIST"; exit "$STUB_PR_LIST_EXIT" ;;
      view) printf '%s' "$STUB_PR_VIEW"; exit 0 ;;
      create)
        if [ "${STUB_PR_CREATE_EXIT:-0}" = 0 ]; then
          echo "https://github.com/org/repo/pull/${STUB_NEW_PR_NUMBER:-1}"
        fi
        exit "${STUB_PR_CREATE_EXIT:-0}" ;;
      *) echo '{}'; exit 0 ;;
    esac ;;
  api)
    P="$2"
    # Parent-sha lookup for freeze PRs: smoke-pr-gate.sh queries the plain
    # (non-git) commits endpoint with this --jq expression; check it before
    # any path-based branch so it matches regardless of the exact endpoint.
    if printf '%s' "$*" | grep -qF '.parents[0].sha'; then
      printf '%s' "$STUB_PARENT_SHA"; exit 0
    fi
    if printf '%s' "$P" | grep -qF '/pulls/' && printf '%s' "$P" | grep -qF '/files'; then
      printf '%s' "$STUB_PR_FILES"; exit "$STUB_PR_FILES_EXIT"
    fi
    if printf '%s' "$P" | grep -qF '/check-runs'; then
      printf '%s' "$STUB_CHECK_RUNS"; exit 0
    fi
    if printf '%s' "$P" | grep -qF '/git/ref/heads/'; then
      if [ "$STUB_BRANCH_EXISTS" = true ]; then echo '{"ref":"exists"}'; exit 0; else exit 1; fi
    fi
    if printf '%s' "$P" | grep -qF '/git/commits/'; then
      if printf '%s' "$*" | grep -qF '.parents[0].sha'; then
        printf '%s' "$STUB_PARENT_SHA"; exit 0
      else
        printf '%s' "$STUB_COMMIT_TREE"; exit 0
      fi
    fi
    if printf '%s' "$P" | grep -qF '/git/blobs'; then
      cat >/dev/null; printf '%s' "$STUB_BLOB_RESPONSE"; exit 0
    fi
    if printf '%s' "$P" | grep -qF '/git/trees'; then
      cat >/dev/null; printf '%s' "$STUB_TREE_RESPONSE"; exit 0
    fi
    if printf '%s' "$P" | grep -qF '/git/refs'; then
      cat >/dev/null; printf '%s' "$STUB_REF_RESPONSE"; exit "${STUB_REF_EXIT:-0}"
    fi
    if printf '%s' "$P" | grep -qF '/git/commits'; then
      cat >/dev/null; printf '%s' "$STUB_COMMIT_RESPONSE"; exit 0
    fi
    echo '{}'; exit 0 ;;
  *) echo '{}'; exit 0 ;;
esac
STUB
cat > "$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
set -u
[ -n "${STUB_SUSPEND_CODE+x}" ] || STUB_SUSPEND_CODE=202
[ -n "${STUB_HEALTHZ_CODE+x}" ] || STUB_HEALTHZ_CODE=200
[ -n "${STUB_SERVICES+x}" ] || STUB_SERVICES='[]'
[ -n "${STUB_BACKEND_DEPLOYS+x}" ] || STUB_BACKEND_DEPLOYS='[]'
[ -n "${STUB_FRONTEND_DEPLOYS+x}" ] || STUB_FRONTEND_DEPLOYS='[]'
ARGS="$*"
if printf '%s' "$ARGS" | grep -qF '/suspend'; then
  printf '%s' "$STUB_SUSPEND_CODE"; exit 0
fi
if printf '%s' "$ARGS" | grep -qF '/healthz'; then
  if [ "$STUB_HEALTHZ_CODE" = "200" ]; then printf '200'; exit 0; else exit 22; fi
fi
if printf '%s' "$ARGS" | grep -qF '/deploys'; then
  if printf '%s' "$ARGS" | grep -qF 'backend-pr'; then
    printf '%s' "$STUB_BACKEND_DEPLOYS"
  else
    printf '%s' "$STUB_FRONTEND_DEPLOYS"
  fi
  exit 0
fi
if printf '%s' "$ARGS" | grep -qF '/services?limit'; then
  printf '%s' "$STUB_SERVICES"; exit 0
fi
echo '{}'; exit 0
STUB
chmod +x "$STUB_BIN/gh" "$STUB_BIN/curl"
export PATH="$STUB_BIN:$PATH"

reset_stubs() {
  unset STUB_PR_LIST STUB_PR_VIEW STUB_PR_FILES STUB_CHECK_RUNS STUB_PARENT_SHA \
        STUB_COMMIT_TREE STUB_BLOB_RESPONSE STUB_TREE_RESPONSE STUB_COMMIT_RESPONSE \
        STUB_REF_RESPONSE STUB_REF_EXIT STUB_BRANCH_EXISTS STUB_PR_LIST_EXIT \
        STUB_PR_FILES_EXIT STUB_PR_CREATE_EXIT STUB_NEW_PR_NUMBER STUB_SUSPEND_CODE \
        STUB_HEALTHZ_CODE STUB_SERVICES STUB_BACKEND_DEPLOYS STUB_FRONTEND_DEPLOYS 2>/dev/null || true
}

fresh_state() {
  STATE_DIR="$(mktemp -d)"
  export SMOKE_GATE_STATE_DIR="$STATE_DIR"
  reset_stubs
}
sha() { printf "$1%.0s" $(seq 40); }

# --- 1. Misconfig: fail-closed wake, throttled on the immediate next poll --
fresh_state
unset SMOKE_GATE_REPO SMOKE_GATE_BACKEND_SERVICE SMOKE_GATE_FRONTEND_SERVICE 2>/dev/null || true
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "gate_misconfigured" and
  (.data.missing | length == 3)
' >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "gate_misconfigured"' >/dev/null

# --- Common config for every scenario below ---------------------------------
export SMOKE_GATE_REPO=org/repo
export SMOKE_GATE_BACKEND_SERVICE=srv-backend-base
export SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base

# --- 2. No labeled open PRs: quiet idle, no wake ----------------------------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
export STUB_PR_LIST='[]'
bash "$GATE" poll | jq -e '
  .wakeAgent == false and .data.trigger == "waiting_for_candidates" and .data.labeledPrCount == 0
' >/dev/null

# --- 3. Settle happy path: poll claims the run and stamps state ------------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
HEAD_SHA="$(sha b)"
export STUB_PR_LIST="[{\"number\":42,\"headRefOid\":\"$HEAD_SHA\"}]"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_CHECK_RUNS='{"check_runs":[{"name":"CI","status":"completed","conclusion":"success"}]}'
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-42\",\"name\":\"XZO-DEV-BACKEND PR #42\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-42.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$HEAD_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
bash "$GATE" poll | jq -e --arg sha "$HEAD_SHA" '
  .wakeAgent == true and .data.trigger == "pr_build_settled" and
  .data.pr == 42 and .data.sourceSha == $sha and
  .data.previewUrl == "https://xzo-dev-backend-pr-42.onrender.com" and
  .data.isFreezePr == false and .data.ciSha == $sha and
  .data.recovery == false and .data.abandonedActiveSha == null and
  (.data.runId | test("^smoke-pr42-"))
' >/dev/null
jq -e --arg sha "$HEAD_SHA" '
  .activeSha == $sha and .activeRunId != null and .completedSha == null
' "$STATE_DIR/pr-42-state.json" >/dev/null
# Same head, immediately after claiming: already active, no re-wake.
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "waiting_for_candidates"' >/dev/null

# --- 4. Deploy-SHA mismatch: check reports not settled, not ready ----------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
HEAD_SHA="$(sha c)"
STALE_SHA="$(sha d)"
export STUB_PR_VIEW="{\"number\":7,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$HEAD_SHA\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_CHECK_RUNS='{"check_runs":[{"name":"CI","status":"completed","conclusion":"success"}]}'
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-7\",\"name\":\"XZO-DEV-BACKEND PR #7\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-7.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$STALE_SHA\"}}]"
bash "$GATE" check 7 | jq -e --arg head "$HEAD_SHA" --arg stale "$STALE_SHA" '
  .eligible == true and .settled == false and .backendReady == false and
  .backendDeploySha == $stale and .headSha == $head
' >/dev/null

# --- 5. Freeze-PR: CI checked on the PARENT sha, not the marker head -------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
PARENT_SHA="$(sha e)"
FREEZE_SHA="$(sha f)"
export STUB_PR_VIEW="{\"number\":9,\"state\":\"OPEN\",\"isDraft\":true,\"headRefOid\":\"$FREEZE_SHA\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$PARENT_SHA"
export STUB_CHECK_RUNS='{"check_runs":[{"name":"pr-title-check","status":"completed","conclusion":"success"}]}'
bash "$GATE" check 9 | jq -e --arg parent "$PARENT_SHA" --arg head "$FREEZE_SHA" '
  .isFreezePr == true and .ciSha == $parent and .ciReady == true and
  .migrationsTouched == false and .frontendTouched == true and .headSha == $head
' >/dev/null

# --- 6. Migrations refusal: never settles; one throttled alarm wake --------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
HEAD_SHA="$(sha 1)"
export STUB_PR_VIEW="{\"number\":11,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$HEAD_SHA\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/migrations/0099_add_col.sql"},{"filename":"XZO-BACKEND/src/foo.ts"}]'
bash "$GATE" check 11 | jq -e '.migrationsTouched == true and .settled == false' >/dev/null
# Same PR through poll: refuses with a throttled alarm, never a settle wake.
export STUB_PR_LIST="[{\"number\":11,\"headRefOid\":\"$HEAD_SHA\"}]"
bash "$GATE" poll | jq -e --arg sha "$HEAD_SHA" '
  .wakeAgent == true and .data.trigger == "pr_migrations_refused" and
  .data.pr == 11 and .data.sourceSha == $sha
' >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "waiting_for_candidates"' >/dev/null
[ ! -e "$STATE_DIR/pr-11-verdict.json" ]

# --- 7. claim/progress/release lifecycle ------------------------------------
fresh_state
CLAIM_SHA="$(sha 2)"
bash "$GATE" claim run-x 5 "$CLAIM_SHA" | jq -e '.ok == true and .pr == 5' >/dev/null
bash "$GATE" claim run-y 5 "$CLAIM_SHA" | jq -e '.ok == false' >/dev/null   # slot already owned
bash "$GATE" progress run-wrong | jq -e '.ok == false and .pr == null' >/dev/null
bash "$GATE" progress run-x | jq -e '.ok == true and .pr == 5' >/dev/null
jq -e '.activeProgressAt != null' "$STATE_DIR/pr-5-state.json" >/dev/null
bash "$GATE" release run-x | jq -e '.ok == true and .releasedRunId == "run-x"' >/dev/null
jq -e '.activeSha == null and .activeRunId == null' "$STATE_DIR/pr-5-state.json" >/dev/null

# --- 8. finish suspends the backend preview ---------------------------------
fresh_state
FINISH_SHA="$(sha 3)"
bash "$GATE" claim run-finish-1 42 "$FINISH_SHA" >/dev/null
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-42\",\"name\":\"XZO-DEV-BACKEND PR #42\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-42.onrender.com\"}}]"
export STUB_SUSPEND_CODE=202
bash "$GATE" finish "$FINISH_SHA" run-finish-1 GO | jq -e --arg sha "$FINISH_SHA" '
  .ok == true and .verdict == "GO" and .pr == 42 and .sha == $sha and
  .suspend.attempted == true and .suspend.ok == true and .suspend.httpStatus == 202
' >/dev/null
jq -e --arg sha "$FINISH_SHA" '
  .schemaVersion == 1 and .pr == 42 and .sha == $sha and .verdict == "GO" and
  .suspend.ok == true
' "$STATE_DIR/pr-42-verdict.json" >/dev/null
jq -e --arg sha "$FINISH_SHA" '
  .completedSha == $sha and .completedVerdict == "GO" and .activeSha == null
' "$STATE_DIR/pr-42-state.json" >/dev/null

# Suspend failure must not fail the finish — logged in the JSON, not thrown.
fresh_state
FINISH_SHA2="$(sha 4)"
bash "$GATE" claim run-finish-2 43 "$FINISH_SHA2" >/dev/null
export STUB_SERVICES='[]'   # preview already torn down
bash "$GATE" finish "$FINISH_SHA2" run-finish-2 NO_GO | jq -e '
  .ok == true and .verdict == "NO_GO" and
  .suspend.attempted == false and .suspend.ok == false and
  (.suspend.reason | test("not found"))
' >/dev/null

# --- 9. finish from a non-active run is refused, state untouched -----------
fresh_state
ORIG_SHA="$(sha 5)"
bash "$GATE" claim run-orig 44 "$ORIG_SHA" >/dev/null
# Simulate the run being superseded (reclaimed) without going through finish.
jq '.activeRunId="run-new"' "$STATE_DIR/pr-44-state.json" > "$STATE_DIR/pr-44-state.json.tmp"
mv "$STATE_DIR/pr-44-state.json.tmp" "$STATE_DIR/pr-44-state.json"
bash "$GATE" finish "$ORIG_SHA" run-orig GO | jq -e '
  .ok == false and (.error | test("not the active run")) and .pr == null
' >/dev/null
jq -e '.activeRunId == "run-new" and .completedSha == null' "$STATE_DIR/pr-44-state.json" >/dev/null
[ ! -e "$STATE_DIR/pr-44-verdict.json" ]

# finish also rejects malformed input the same way the develop gate does.
fresh_state
if bash "$GATE" finish abc123 run-1 GO | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "expected short SHA to be rejected" >&2; exit 1
fi
if bash "$GATE" finish "$(sha 6)" run-1 SHIP_IT | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "expected invalid verdict to be rejected" >&2; exit 1
fi

# --- 10. gh pr list fetch failure: throttled global alarm -------------------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
export STUB_PR_LIST_EXIT=1
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "gate_fetch_failed"' >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "gate_fetch_failed"' >/dev/null
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "gate_fetch_failed" and .data.consecutiveFailures == 3
' >/dev/null

# --- 11. P1 regression: run ids must be unique ACROSS PRs, not just within
# one PR's own state file. Before the fix, `claim` only checked collision
# against the TARGET pr's own state, so two different PRs could both claim
# the same caller-chosen run id. `finish`/`progress`/`release` then resolve a
# bare run id by scanning for the first matching state file
# (find_pr_for_run) — with two matches, the wrong PR wins by glob order, and
# `finish` could record one PR's verdict under a DIFFERENT PR's SHA while
# leaving the true owner a zombie forever "active".
fresh_state
SHA_A="$(sha 7)"
SHA_B="$(sha 8)"
bash "$GATE" claim shared-run 100 "$SHA_A" | jq -e '.ok == true' >/dev/null
bash "$GATE" claim shared-run 200 "$SHA_B" | jq -e '
  .ok == false and (.error | test("unique"))
' >/dev/null
# PR 100 still owns the run id untouched; PR 200 was never written at all.
jq -e --arg sha "$SHA_A" '
  .activeSha == $sha and .activeRunId == "shared-run"
' "$STATE_DIR/pr-100-state.json" >/dev/null
[ ! -e "$STATE_DIR/pr-200-state.json" ]
# finish resolves unambiguously to PR 100, with PR 100's own SHA — never
# PR 200's, and never both.
bash "$GATE" finish "$SHA_A" shared-run GO | jq -e --arg sha "$SHA_A" '
  .ok == true and .pr == 100 and .sha == $sha
' >/dev/null

# --- 12. P1 regression: `check` must never assert settled:true when a
# required fetch failed, even though CI/deploy/healthz are all otherwise
# green. Before the fix, the files-fetch failure branch left
# migrations_touched/frontend_touched computed as FALSE (fail-OPEN) instead
# of the promised fail-closed TRUE, so a human trusting `check` before a
# manual claim could freeze a migrations-carrying PR without ever seeing the
# refusal.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
HEAD_SHA="$(sha 9)"
export STUB_PR_VIEW="{\"number\":55,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$HEAD_SHA\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES_EXIT=1
export STUB_CHECK_RUNS='{"check_runs":[{"name":"CI","status":"completed","conclusion":"success"}]}'
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-55\",\"name\":\"XZO-DEV-BACKEND PR #55\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-55.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$HEAD_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
bash "$GATE" check 55 | jq -e '
  .fetchOk == false and .settled == false and
  .migrationsTouched == true and .frontendTouched == true
' >/dev/null

echo "smoke pr gate tests passed"
