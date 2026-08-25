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
[ -n "${STUB_RUN_LIST+x}" ] || STUB_RUN_LIST='[]'
[ -n "${STUB_RUN_LIST_EXIT+x}" ] || STUB_RUN_LIST_EXIT=0
[ -n "${STUB_PARENT_SHA+x}" ] || STUB_PARENT_SHA=''
[ -n "${STUB_COMMIT_TREE+x}" ] || STUB_COMMIT_TREE='{"tree":{"sha":"tree-abc"}}'
[ -n "${STUB_BLOB_RESPONSE+x}" ] || STUB_BLOB_RESPONSE='{"sha":"blob-abc"}'
[ -n "${STUB_TREE_RESPONSE+x}" ] || STUB_TREE_RESPONSE='{"sha":"tree-new"}'
[ -n "${STUB_COMMIT_RESPONSE+x}" ] || STUB_COMMIT_RESPONSE='{"sha":"freeze-sha-abc"}'
[ -n "${STUB_REF_RESPONSE+x}" ] || STUB_REF_RESPONSE='{"ref":"refs/heads/x"}'
[ -n "${STUB_BRANCH_EXISTS+x}" ] || STUB_BRANCH_EXISTS=false
[ -n "${STUB_PR_LIST_EXIT+x}" ] || STUB_PR_LIST_EXIT=0
[ -n "${STUB_PR_FILES_EXIT+x}" ] || STUB_PR_FILES_EXIT=0
[ -n "${STUB_COMPARE_FILES+x}" ] || STUB_COMPARE_FILES='{"files":[]}'
[ -n "${STUB_COMPARE_EXIT+x}" ] || STUB_COMPARE_EXIT=0

case "$1" in
  run)
    # CI facts now come from `gh run list --branch` (the check-runs REST
    # endpoint is invisible to the container's scoped token — see the gate).
    printf '%s' "$STUB_RUN_LIST"; exit "$STUB_RUN_LIST_EXIT" ;;
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
    # Freeze-PR target-tree diff (base branch vs. the marker's parent) — the
    # MG-1 fix: evaluate_pr no longer trusts a freeze PR's own two-marker
    # diff for migrations/frontend, it compares against this instead.
    if printf '%s' "$P" | grep -qF '/compare/'; then
      printf '%s' "$STUB_COMPARE_FILES"; exit "$STUB_COMPARE_EXIT"
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
  # Lock probe: `finish` must have RELEASED the PR state lock before it got
  # here, so a concurrent process can take it. Recorded free/held for the
  # caller to assert on.
  if [ -n "${STUB_LOCK_PROBE:-}" ] && [ -n "${STUB_LOCK_PROBE_FILE:-}" ]; then
    ( flock -n 6 && printf 'free' || printf 'held' ) \
      6>"$STUB_LOCK_PROBE_FILE" > "$STUB_LOCK_PROBE"
  fi
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
  unset STUB_PR_LIST STUB_PR_VIEW STUB_PR_FILES STUB_RUN_LIST STUB_RUN_LIST_EXIT STUB_PARENT_SHA \
        STUB_COMMIT_TREE STUB_BLOB_RESPONSE STUB_TREE_RESPONSE STUB_COMMIT_RESPONSE \
        STUB_REF_RESPONSE STUB_REF_EXIT STUB_BRANCH_EXISTS STUB_PR_LIST_EXIT \
        STUB_PR_FILES_EXIT STUB_PR_CREATE_EXIT STUB_NEW_PR_NUMBER STUB_SUSPEND_CODE \
        STUB_HEALTHZ_CODE STUB_SERVICES STUB_BACKEND_DEPLOYS STUB_FRONTEND_DEPLOYS \
        STUB_COMPARE_FILES STUB_COMPARE_EXIT STUB_LOCK_PROBE STUB_LOCK_PROBE_FILE \
        SMOKE_GATE_PUBLISH_FILE SMOKE_GATE_HOLD_FILE SMOKE_GATE_HANDOFF_LEDGER 2>/dev/null || true
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
export STUB_PR_LIST="[{\"number\":42,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\"}]"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$HEAD_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
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

# --- 3a. Target-aware preflight: the gate exports SMOKE_GATE_PREFLIGHT_TARGET_URL
# for THIS settle candidate's own preview before invoking PREFLIGHT_CMD — the
# whole point of routing the check to the right host instead of skipping it
# or checking a fixed default host, which would prove nothing about this PR's
# build.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
HEAD_SHA="$(sha c)"
export STUB_PR_LIST="[{\"number\":43,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\"}]"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$HEAD_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-43\",\"name\":\"XZO-DEV-BACKEND PR #43\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-43.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$HEAD_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
SEEN_URL_FILE="$STATE_DIR/seen-preflight-url.txt"
export SMOKE_GATE_PREFLIGHT_CMD="printf '%s' \"\$SMOKE_GATE_PREFLIGHT_TARGET_URL\" > $SEEN_URL_FILE"
bash "$GATE" poll | jq -e '.wakeAgent == true and .data.trigger == "pr_build_settled"' >/dev/null
[ "$(cat "$SEEN_URL_FILE")" = "https://xzo-dev-backend-pr-43.onrender.com" ] \
  || { echo "expected the preflight command to see this candidate's own preview URL" >&2; cat "$SEEN_URL_FILE" >&2; exit 1; }
unset SMOKE_GATE_PREFLIGHT_CMD

# --- 3b. A real preflight failure refuses the candidate and reports the
# command's own last line as the reason, WITHOUT claiming the PR.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
HEAD_SHA="$(sha d)"
export STUB_PR_LIST="[{\"number\":44,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\"}]"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$HEAD_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-44\",\"name\":\"XZO-DEV-BACKEND PR #44\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-44.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$HEAD_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
export SMOKE_GATE_PREFLIGHT_CMD='echo "seat qa-a@example.com could not be verified"; exit 1'
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "preflight_failed" and
  (.data.reason | test("could not be verified"))
' >/dev/null
[ ! -e "$STATE_DIR/pr-44-state.json" ] || jq -e '.activeRunId == null' "$STATE_DIR/pr-44-state.json" >/dev/null
unset SMOKE_GATE_PREFLIGHT_CMD

# --- 4. Deploy-SHA mismatch: check reports not settled, not ready ----------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
HEAD_SHA="$(sha c)"
STALE_SHA="$(sha d)"
export STUB_PR_VIEW="{\"number\":7,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$HEAD_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-7\",\"name\":\"XZO-DEV-BACKEND PR #7\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-7.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$STALE_SHA\"}}]"
bash "$GATE" check 7 | jq -e --arg head "$HEAD_SHA" --arg stale "$STALE_SHA" '
  .eligible == true and .settled == false and .backendReady == false and
  .backendDeploySha == $stale and .headSha == $head
' >/dev/null

# --- 5. Freeze-PR: CI checked on the PARENT sha, not the marker head -------
# STUB_COMPARE_FILES is the target-tree diff (base branch vs. the marker's
# parent) — evaluate_pr now judges migrations/frontend off THIS, never off
# the freeze PR's own two-marker diff (STUB_PR_FILES), since that diff is
# always exactly the two markers no matter what the target contains (MG-1,
# see tests 5a/5b below). Here the target only touched an unrelated backend
# file, so neither should be reported touched.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
PARENT_SHA="$(sha e)"
FREEZE_SHA="$(sha f)"
export STUB_PR_VIEW="{\"number\":9,\"state\":\"OPEN\",\"isDraft\":true,\"headRefOid\":\"$FREEZE_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$PARENT_SHA"
export STUB_COMPARE_FILES='{"status":"ahead","files":[{"filename":"XZO-BACKEND/src/other.ts"}]}'
export STUB_RUN_LIST="[{\"headSha\":\"$PARENT_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"pr-title-check\"}]"
bash "$GATE" check 9 | jq -e --arg parent "$PARENT_SHA" --arg head "$FREEZE_SHA" '
  .isFreezePr == true and .ciSha == $parent and .ciReady == true and
  .migrationsTouched == false and .frontendTouched == false and .headSha == $head and
  .migrationsDeterminable == true and .migrationFiles == []
' >/dev/null

# --- 5a. MG-1 fix: a freeze PR whose TARGET (not its own 2-marker diff)
# touches migrations must refuse to settle, exactly like PR #1188/migration
# 222 on 2026-08-24 — the freeze PR's own `pulls/.../files` is always just
# the two markers (STUB_PR_FILES below), so this can only be caught by
# reading STUB_COMPARE_FILES, which is the whole point of the fix.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
PARENT_SHA="$(sha e)"
FREEZE_SHA="$(sha f)"
export STUB_PR_VIEW="{\"number\":10,\"state\":\"OPEN\",\"isDraft\":true,\"headRefOid\":\"$FREEZE_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$PARENT_SHA"
export STUB_COMPARE_FILES='{"status":"ahead","files":[{"filename":"XZO-BACKEND/migrations/222_undo_edit_prior_actor.sql"},{"filename":"XZO-BACKEND/src/other.ts"}]}'
export STUB_RUN_LIST="[{\"headSha\":\"$PARENT_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"pr-title-check\"}]"
bash "$GATE" check 10 | jq -e '
  .isFreezePr == true and .migrationsTouched == true and .settled == false and
  .migrationsDeterminable == true and
  .migrationFiles == ["XZO-BACKEND/migrations/222_undo_edit_prior_actor.sql"]
' >/dev/null

# --- 5b. Fail closed when the target-tree compare itself is unreadable —
# never fall through to "no migrations" just because the check couldn't run.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
PARENT_SHA="$(sha e)"
FREEZE_SHA="$(sha f)"
export STUB_PR_VIEW="{\"number\":12,\"state\":\"OPEN\",\"isDraft\":true,\"headRefOid\":\"$FREEZE_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$PARENT_SHA"
export STUB_COMPARE_EXIT=1
export STUB_RUN_LIST="[{\"headSha\":\"$PARENT_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"pr-title-check\"}]"
bash "$GATE" check 12 | jq -e '
  .isFreezePr == true and .migrationsTouched == true and .frontendTouched == true and
  .settled == false and .migrationsDeterminable == false and .fetchOk == false
' >/dev/null

# --- 6. Migrations refusal: never settles; one throttled alarm wake --------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
HEAD_SHA="$(sha 1)"
export STUB_PR_VIEW="{\"number\":11,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/migrations/0099_add_col.sql"},{"filename":"XZO-BACKEND/src/foo.ts"}]'
bash "$GATE" check 11 | jq -e '.migrationsTouched == true and .settled == false' >/dev/null
# Same PR through poll: refuses with a throttled alarm, never a settle wake.
export STUB_PR_LIST="[{\"number\":11,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\"}]"
bash "$GATE" poll | jq -e --arg sha "$HEAD_SHA" '
  .wakeAgent == true and .data.trigger == "pr_migrations_refused" and
  .data.pr == 11 and .data.sourceSha == $sha
' >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "waiting_for_candidates"' >/dev/null
[ ! -e "$STATE_DIR/pr-11-verdict.json" ]

# --- 7. claim/progress/release lifecycle ------------------------------------
fresh_state
CLAIM_SHA="$(sha 2)"
bash "$GATE" claim run-x 5 "$CLAIM_SHA" | jq -e '.ok == true and .pr == 5 and .tookOverFrom == null' >/dev/null
bash "$GATE" claim run-y 5 "$CLAIM_SHA" | jq -e '.ok == false' >/dev/null   # slot already owned
bash "$GATE" progress run-wrong | jq -e '.ok == false and .pr == null' >/dev/null
bash "$GATE" progress run-x | jq -e '.ok == true and .pr == 5' >/dev/null
jq -e '.activeProgressAt != null' "$STATE_DIR/pr-5-state.json" >/dev/null
bash "$GATE" release run-x | jq -e '.ok == true and .releasedRunId == "run-x"' >/dev/null
jq -e '.activeSha == null and .activeRunId == null' "$STATE_DIR/pr-5-state.json" >/dev/null

# --- 7b. P1 regression: a stamping run keeps its slot past the age ceiling.
# ACTIVE_STALE_SECONDS used to be ANDed into liveness, so a coordinator that
# had stamped `progress` four minutes earlier went "not live" the instant it
# crossed 4h — and the next claim/poll started a SECOND coordinator on the
# same PR and the same frozen SHA with nothing telling the first. That is
# exactly how run …-20260822T023125Z was displaced at 4h00m03s, after which
# two coordinators drove the same seat for hours and no verdict was ever
# published. Simulated by setting the ceiling to 0, which makes every active
# run instantly "overrun".
fresh_state
DUP_SHA="$(sha 9)"
bash "$GATE" claim run-orig-live 55 "$DUP_SHA" | jq -e '.ok == true' >/dev/null
bash "$GATE" progress run-orig-live | jq -e '.ok == true' >/dev/null
export SMOKE_GATE_ACTIVE_STALE_SECONDS=0
# Same PR, same SHA, new run id — the rival's exact shape. Refused, and the
# refusal says how a human forces it rather than leaving them to guess.
bash "$GATE" claim run-rival 55 "$DUP_SHA" | jq -e '
  .ok == false and .pr == 55 and .activeRunId == "run-orig-live" and
  (.error | test("--takeover")) and .activeAgeSeconds >= 0
' >/dev/null
jq -e '.activeRunId == "run-orig-live"' "$STATE_DIR/pr-55-state.json" >/dev/null
# `poll` never takes over either: with the slot held, PR 55 is not a candidate.
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
export STUB_PR_LIST="[{\"number\":55,\"headRefOid\":\"$DUP_SHA\",\"headRefName\":\"feature/dup\"}]"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$DUP_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-55\",\"name\":\"XZO-DEV-BACKEND PR #55\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-55.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$DUP_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
# ...but the ceiling still RINGS. It was demoted from executioner to alarm, not
# deleted: a zombie stamper (heartbeat alive, work wedged in a retry loop or a
# hung browser) must not hold the slot in silence just because no rival happens
# to claim. One wake per overrun run, then latched.
bash "$GATE" poll | jq -e --arg sha "$DUP_SHA" '
  .wakeAgent == true and .data.trigger == "pr_run_overrun" and
  .data.pr == 55 and .data.runId == "run-orig-live" and
  .data.sourceSha == $sha and .data.activeAgeSeconds >= 0
' >/dev/null
jq -e '.overrunAlertRunId == "run-orig-live"' "$STATE_DIR/pr-55-state.json" >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "waiting_for_candidates"' >/dev/null
jq -e '.activeRunId == "run-orig-live"' "$STATE_DIR/pr-55-state.json" >/dev/null
# Control, so the assertion above cannot pass vacuously: this fixture IS a real
# settle candidate. Free the slot and the very same poll wakes and auto-claims.
bash "$GATE" release run-orig-live | jq -e '.ok == true' >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == true and .data.trigger == "pr_build_settled"' >/dev/null
POLL_RUN="$(jq -r '.activeRunId' "$STATE_DIR/pr-55-state.json")"
# An explicit human --takeover past the ceiling still works, and says so.
bash "$GATE" claim run-rival 55 "$DUP_SHA" --takeover | jq -e --arg prev "$POLL_RUN" '
  .ok == true and .runId == "run-rival" and .tookOverFrom == $prev
' >/dev/null
# The displacement is LOUD. A shell gate cannot kill the incumbent's container,
# so the displaced run's next gate verb is the only channel that reaches it —
# it must carry a stop instruction, not just "not the active run".
jq -e --arg prev "$POLL_RUN" '
  .displacedRunId == $prev and .displacedAt != null
' "$STATE_DIR/pr-55-state.json" >/dev/null
for VERB in progress release; do
  OUT="$(bash "$GATE" "$VERB" "$POLL_RUN")"
  jq -e '
    .ok == false and (.error | test("STOP THIS CAMPAIGN")) and
    (.error | test("--takeover")) and .pr == 55 and .activeRunId == "run-rival"
  ' <<<"$OUT" >/dev/null || { echo "expected $VERB to hand the displaced run a stop instruction, got: $OUT" >&2; exit 1; }
done
OUT="$(bash "$GATE" finish "$DUP_SHA" "$POLL_RUN" GO)"
jq -e '.ok == false and (.error | test("STOP THIS CAMPAIGN"))' <<<"$OUT" >/dev/null
[ ! -e "$STATE_DIR/pr-55-verdict.json" ]
# An unrelated stale run id still gets the ordinary refusal, not a stop order.
bash "$GATE" progress some-other-run | jq -e '
  .ok == false and .pr == null and (.error | test("STOP") | not)
' >/dev/null
# An ordinary (non-takeover) claim clears the name so it can never mis-accuse.
bash "$GATE" release run-rival >/dev/null
bash "$GATE" claim run-clean 55 "$DUP_SHA" >/dev/null
jq -e '.displacedRunId == null and .displacedAt == null' "$STATE_DIR/pr-55-state.json" >/dev/null
bash "$GATE" release run-clean >/dev/null
bash "$GATE" claim run-rival 55 "$DUP_SHA" >/dev/null
# An explicit --takeover works BELOW the ceiling too. This assertion was the
# reverse earlier in this same change; an adversarial review pointed out that
# gating the flag on the ceiling removed the operator's only lever during the
# first hours of a wedged campaign, while protecting against nothing a
# deliberate human flag does not already imply. A bare claim is still refused.
unset SMOKE_GATE_ACTIVE_STALE_SECONDS
bash "$GATE" claim run-third 55 "$DUP_SHA" --takeover | jq -e '
  .ok == true and .tookOverFrom == "run-rival"
' >/dev/null
bash "$GATE" release run-third >/dev/null
bash "$GATE" claim run-rival 55 "$DUP_SHA" >/dev/null
bash "$GATE" claim run-third 55 "$DUP_SHA" | jq -e '
  .ok == false and (.error | test("wait for it or ask its coordinator"))
' >/dev/null
# A genuinely dead run (no stamp inside the liveness window) is still
# reclaimed automatically — the recovery path this fix must not break.
export SMOKE_GATE_PROGRESS_STALE_SECONDS=0
bash "$GATE" claim run-fourth 55 "$DUP_SHA" | jq -e '
  .ok == true and .tookOverFrom == null
' >/dev/null
unset SMOKE_GATE_PROGRESS_STALE_SECONDS

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
export STUB_PR_VIEW="{\"number\":55,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES_EXIT=1
export STUB_RUN_LIST="[{\"headSha\":\"$HEAD_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-55\",\"name\":\"XZO-DEV-BACKEND PR #55\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-55.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$HEAD_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
bash "$GATE" check 55 | jq -e '
  .fetchOk == false and .settled == false and
  .migrationsTouched == true and .frontendTouched == true
' >/dev/null

# --- 12. Develop-freeze-handoff: finish on a FREEZE pr writes hold/publish/
# ledger keyed to the TARGET develop sha (the marker commit's parent), not
# the freeze marker sha itself.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
TARGET_SHA="$(sha 7)"
FREEZE_HEAD_SHA="$(sha 8)"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$TARGET_SHA"
bash "$GATE" claim run-freeze-1 60 "$FREEZE_HEAD_SHA" >/dev/null

DEV_PUBLISH="$STATE_DIR/dev-gate/latest-verdict.json"
DEV_HOLD="$STATE_DIR/dev-gate/develop-hold.json"
DEV_LEDGER="$STATE_DIR/dev-gate/handoff-ledger.jsonl"
export SMOKE_GATE_PUBLISH_FILE="$DEV_PUBLISH" SMOKE_GATE_HOLD_FILE="$DEV_HOLD" \
  SMOKE_GATE_HANDOFF_LEDGER="$DEV_LEDGER"

bash "$GATE" finish "$FREEZE_HEAD_SHA" run-freeze-1 NO_GO | jq -e --arg target "$TARGET_SHA" '
  .ok == true and .handoff.written == true and .handoff.targetSha == $target
' >/dev/null
jq -e --arg sha "$TARGET_SHA" '.sha == $sha and .verdict == "NO_GO"' "$DEV_PUBLISH" >/dev/null
jq -e --arg sha "$TARGET_SHA" '.sha == $sha and .verdict == "NO_GO" and .runId == "run-freeze-1"' "$DEV_HOLD" >/dev/null
jq -e --arg target "$TARGET_SHA" --arg freeze "$FREEZE_HEAD_SHA" --argjson pr 60 --arg run "run-freeze-1" '
  .targetSha == $target and .freezeSha == $freeze and .freezePr == $pr and
  .verdict == "NO_GO" and .runId == $run
' "$DEV_LEDGER" >/dev/null

# --- 12b. HUMAN_DECISION RAISES the hold (owner decision 2026-08-25). It used
# to leave the hold untouched — default-open — so a verdict whose literal
# meaning is "the system does not know whether this is safe" behaved as GO on
# precisely the cases flagged as needing judgment. `reason` distinguishes it
# from a defects hold. BLOCKED is deliberately unchanged.
bash "$GATE" claim run-freeze-hd 60 "$FREEZE_HEAD_SHA" >/dev/null
bash "$GATE" finish "$FREEZE_HEAD_SHA" run-freeze-hd HUMAN_DECISION | jq -e '.ok == true' >/dev/null
jq -e --arg sha "$TARGET_SHA" '
  .sha == $sha and .verdict == "HUMAN_DECISION" and .runId == "run-freeze-hd" and
  .reason == "needs_human_decision"
' "$DEV_HOLD" >/dev/null
# BLOCKED still leaves whatever hold is standing exactly as it was.
bash "$GATE" claim run-freeze-bl 60 "$FREEZE_HEAD_SHA" >/dev/null
bash "$GATE" finish "$FREEZE_HEAD_SHA" run-freeze-bl BLOCKED | jq -e '.ok == true' >/dev/null
jq -e '.runId == "run-freeze-hd" and .verdict == "HUMAN_DECISION"' "$DEV_HOLD" >/dev/null

# --- 13. GO clears the hold, keyed the same way.
bash "$GATE" claim run-freeze-2 60 "$FREEZE_HEAD_SHA" >/dev/null
bash "$GATE" finish "$FREEZE_HEAD_SHA" run-freeze-2 GO | jq -e --arg target "$TARGET_SHA" '
  .ok == true and .handoff.written == true and .handoff.targetSha == $target
' >/dev/null
[ ! -e "$DEV_HOLD" ]
# The ledger records BOTH outcomes (append-only) so the develop gate's dedup
# advance always reads the most recent one.
[ "$(wc -l < "$DEV_LEDGER")" -eq 4 ]

# --- 14. Non-freeze PRs never touch publish/hold/ledger, even when the
# wrapper has them configured — "never touch them" is unconditional, not
# dependent on the wrapper only enabling them for freeze deployments.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
NORMAL_SHA="$(sha 9)"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
bash "$GATE" claim run-normal-1 61 "$NORMAL_SHA" >/dev/null
DEV_HOLD2="$STATE_DIR/dev-gate2/develop-hold.json"
DEV_PUBLISH2="$STATE_DIR/dev-gate2/latest-verdict.json"
export SMOKE_GATE_PUBLISH_FILE="$DEV_PUBLISH2" SMOKE_GATE_HOLD_FILE="$DEV_HOLD2"
bash "$GATE" finish "$NORMAL_SHA" run-normal-1 NO_GO | jq -e '
  .ok == true and .handoff.written == false and .handoff.targetSha == null
' >/dev/null
[ ! -e "$DEV_HOLD2" ]
[ ! -e "$DEV_PUBLISH2" ]

# --- 15. P2 regression: a ledger append failure must be reported truthfully
# — handoff.written must be false (not true) with a reason, even though the
# hold/publish artifacts (written first, independently) succeeded. Forcing
# the failure: the lock's directory is a path component that is actually a
# regular file, so both bounded-retry attempts fail deterministically and
# fast (flock refuses a bad fd instantly — no timeout wait needed to
# reproduce this).
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
LOCKFAIL_TARGET="$(sha 1)"
LOCKFAIL_HEAD="$(sha 2)"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$LOCKFAIL_TARGET"
bash "$GATE" claim run-lockfail 70 "$LOCKFAIL_HEAD" >/dev/null

DEV_PUBLISH3="$STATE_DIR/dev-gate3/latest-verdict.json"
DEV_HOLD3="$STATE_DIR/dev-gate3/develop-hold.json"
BLOCKER="$STATE_DIR/dev-gate3-blocker"
: > "$BLOCKER"
BAD_LEDGER="$BLOCKER/subdir/handoff-ledger.jsonl"
export SMOKE_GATE_PUBLISH_FILE="$DEV_PUBLISH3" SMOKE_GATE_HOLD_FILE="$DEV_HOLD3" \
  SMOKE_GATE_HANDOFF_LEDGER="$BAD_LEDGER"

bash "$GATE" finish "$LOCKFAIL_HEAD" run-lockfail NO_GO | jq -e --arg target "$LOCKFAIL_TARGET" '
  .ok == true and .handoff.written == false and .handoff.targetSha == $target and
  (.handoff.reason | test("retry"))
' >/dev/null
# The hold/publish artifacts were still written correctly — only the
# ledger's own append failed.
jq -e --arg sha "$LOCKFAIL_TARGET" '.sha == $sha and .verdict == "NO_GO"' "$DEV_PUBLISH3" >/dev/null
jq -e --arg sha "$LOCKFAIL_TARGET" '.sha == $sha and .verdict == "NO_GO"' "$DEV_HOLD3" >/dev/null
[ ! -e "$BAD_LEDGER" ]

# --- 16. CI facts are filtered to the target SHA -------------------------
# `gh run list --branch` returns the branch's recent runs, not one commit's,
# so the SHA filter is the whole correctness of the port away from the
# check-runs endpoint. A branch whose recent runs are all for OTHER commits
# must read as "no CI for our head" (fail closed), never as green.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
HEAD_SHA="$(sha 1)"
OTHER_SHA="$(sha 2)"
export STUB_PR_VIEW="{\"number\":61,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$OTHER_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-61\",\"name\":\"XZO-DEV-BACKEND PR #61\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://b.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$HEAD_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
bash "$GATE" check 61 | jq -e '
  .ciTotal == 0 and .ciReady == false and .settled == false
' >/dev/null
# Same fixtures, but the branch listing now carries OUR sha: settles.
export STUB_RUN_LIST="[{\"headSha\":\"$OTHER_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"},{\"headSha\":\"$HEAD_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
bash "$GATE" check 61 | jq -e '
  .ciTotal == 1 and .ciReady == true and .settled == true
' >/dev/null

# --- 17. A PR that can never settle alarms instead of failing silently ----
# The 2026-08-12 outage in one test: freeze PR #786 was built, live and warm
# for 6.5h while its CI fetch returned nothing, and every poll skipped it
# without a word. Unfetchable facts must alarm once past the window.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
HEAD_SHA="$(sha 3)"
export STUB_PR_LIST="[{\"number\":77,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\"}]"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST_EXIT=1
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-77\",\"name\":\"XZO-DEV-BACKEND PR #77\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://b.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$HEAD_SHA\"}}]"
export STUB_HEALTHZ_CODE=200

# Inside the window: silent, but the stall is now RECORDED.
export SMOKE_GATE_FACTS_STUCK_SECONDS=3600
bash "$GATE" poll | jq -e '.wakeAgent == false' >/dev/null
jq -e --arg sha "$HEAD_SHA" '.factsStuckSha == $sha and .factsStuckSince != null' \
  "$STATE_DIR/pr-77-state.json" >/dev/null

# Past the window: one alarm, latched.
export SMOKE_GATE_FACTS_STUCK_SECONDS=0
bash "$GATE" poll | jq -e --arg sha "$HEAD_SHA" '
  .wakeAgent == true and .data.trigger == "pr_facts_unavailable" and
  .data.pr == 77 and .data.sourceSha == $sha
' >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == false' >/dev/null

# Facts recover: the latch clears, so a later stall alarms again.
unset STUB_RUN_LIST_EXIT
export STUB_RUN_LIST="[{\"headSha\":\"$HEAD_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
bash "$GATE" poll >/dev/null
jq -e '.factsStuckSha == null and .factsStuckAlertSha == null' "$STATE_DIR/pr-77-state.json" >/dev/null

# --- 18. finish DROPS the PR lock before its network work -------------------
# By the time the suspend POST runs, the verdict is already durable in the PR
# state file and activeRunId is null. Everything after that point is network
# (services list, suspend, detect_freeze's GitHub calls) or writes to OTHER
# files, so holding the per-PR lock across it only starved concurrent gate
# verbs — the PR-gate half of the starvation that made a coordinator's mandatory
# `progress` stamp read as "you lost the slot". The curl stub probes the lock
# from a separate process while the suspend call is in flight.
fresh_state
LOCKPROBE_SHA="$(sha 7)"
bash "$GATE" claim run-lockprobe 88 "$LOCKPROBE_SHA" >/dev/null
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-88\",\"name\":\"backend-preview PR #88\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://b.onrender.com\"}}]"
export STUB_SUSPEND_CODE=202
export STUB_LOCK_PROBE="$STATE_DIR/lock-probe.txt"
export STUB_LOCK_PROBE_FILE="$STATE_DIR/pr-88-state.lock"
bash "$GATE" finish "$LOCKPROBE_SHA" run-lockprobe GO | jq -e '
  .ok == true and .suspend.attempted == true and .suspend.ok == true
' >/dev/null
if [ "$(cat "$STUB_LOCK_PROBE" 2>/dev/null)" != "free" ]; then
  echo "expected finish to have released the PR state lock before the suspend POST, probe said: $(cat "$STUB_LOCK_PROBE" 2>/dev/null)" >&2
  exit 1
fi
# The verdict landed anyway — releasing the lock early loses nothing.
jq -e --arg sha "$LOCKPROBE_SHA" '.completedSha == $sha and .activeRunId == null' \
  "$STATE_DIR/pr-88-state.json" >/dev/null

# --- 19. a lock-busy refusal is RETRYABLE, not "you lost the slot" ----------
# Bare `ok:false` with no error field was indistinguishable from a reclaim, and
# the skill tells a coordinator to stop the campaign on exactly that.
fresh_state
BUSY_SHA="$(sha 8)"
bash "$GATE" claim run-busy 89 "$BUSY_SHA" >/dev/null
( flock -x 6; sleep 3 ) 6>"$STATE_DIR/pr-89-state.lock" &
BUSY_BLOCKER=$!
sleep 0.3
BUSY_OUT="$(SMOKE_GATE_LOCK_WAIT_SECONDS=1 bash "$GATE" progress run-busy)"
wait "$BUSY_BLOCKER"
jq -e '
  .ok == false and .retryable == true and .pr == 89 and .wakeAgent == false and
  (.error | startswith("gate_lock_busy:")) and
  (.error | test("do not stop the campaign"))
' <<<"$BUSY_OUT" >/dev/null || {
  echo "expected a retryable gate_lock_busy refusal, got: $BUSY_OUT" >&2; exit 1; }
# ...and the terminal refusal it must be told apart from carries neither field.
jq -e '.ok == false and (.retryable | not) and (.error | startswith("gate_lock_busy:") | not)' \
  <<<"$(bash "$GATE" progress run-nonexistent)" >/dev/null || {
  echo "expected a not-active refusal to carry no retryable flag" >&2; exit 1; }
# The slot survived the transient miss.
jq -e '.activeRunId == "run-busy"' "$STATE_DIR/pr-89-state.json" >/dev/null

echo "smoke pr gate tests passed"
