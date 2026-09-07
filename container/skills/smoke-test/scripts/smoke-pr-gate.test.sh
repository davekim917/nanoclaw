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
TEST_SHARED_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$STATE_DIR" "$STUB_BIN" "$TEST_SHARED_ROOT"; }
trap cleanup EXIT

cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -u
# Plain ${VAR:=default} mis-parses once the default itself contains braces
# and quotes (bash reads the embedded `{`/`}`/`"` as shell syntax, not text),
# so every JSON default here is set with an explicit is-it-set-at-all guard
# instead.
[ -n "${STUB_PR_LIST+x}" ] || STUB_PR_LIST='[]'
[ -n "${STUB_REPO_VIEW_EXIT+x}" ] || STUB_REPO_VIEW_EXIT=0
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
  repo)
    # Reachability probe. A repo that does not resolve 404s here even though
    # `pr list` answered it with a cheerful empty array.
    if [ "$STUB_REPO_VIEW_EXIT" = 0 ]; then echo '{"name":"repo"}'; fi
    exit "$STUB_REPO_VIEW_EXIT" ;;
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
    if printf '%s' "$P" | grep -qF '/actions/runs?'; then
      printf '%s' "$STUB_RUN_LIST"; exit "$STUB_RUN_LIST_EXIT"
    fi
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
  # State probe: snapshot the PR state file at the moment the artifact work
  # begins, so the caller can assert the slot is still HELD here (crash-safety
  # order) rather than already cleared.
  if [ -n "${STUB_STATE_PROBE:-}" ] && [ -n "${STUB_STATE_PROBE_FILE:-}" ]; then
    cat "$STUB_STATE_PROBE_FILE" > "$STUB_STATE_PROBE" 2>/dev/null || true
  fi
  # Stall long enough for an outer `timeout` to kill the gate here — a real
  # mid-flight container death, not a simulated one.
  [ -n "${STUB_SUSPEND_SLEEP:-}" ] && sleep "$STUB_SUSPEND_SLEEP"
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
cat > "$STUB_BIN/mountpoint" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-q" ] && [ "${2:-}" = "${SMOKE_GATE_SHARED_ROOT:-}" ]
STUB
chmod +x "$STUB_BIN/mountpoint"
export PATH="$STUB_BIN:$PATH"

reset_stubs() {
  unset STUB_PR_LIST STUB_PR_VIEW STUB_PR_FILES STUB_RUN_LIST STUB_RUN_LIST_EXIT STUB_PARENT_SHA \
        STUB_COMMIT_TREE STUB_BLOB_RESPONSE STUB_TREE_RESPONSE STUB_COMMIT_RESPONSE \
        STUB_REF_RESPONSE STUB_REF_EXIT STUB_BRANCH_EXISTS STUB_PR_LIST_EXIT \
        STUB_PR_FILES_EXIT STUB_PR_CREATE_EXIT STUB_NEW_PR_NUMBER STUB_SUSPEND_CODE \
        STUB_HEALTHZ_CODE STUB_SERVICES STUB_BACKEND_DEPLOYS STUB_FRONTEND_DEPLOYS \
        STUB_COMPARE_FILES STUB_COMPARE_EXIT STUB_LOCK_PROBE STUB_LOCK_PROBE_FILE \
        STUB_STATE_PROBE STUB_STATE_PROBE_FILE STUB_SUSPEND_SLEEP STUB_REPO_VIEW_EXIT \
        SMOKE_GATE_PUBLISH_FILE SMOKE_GATE_HOLD_FILE SMOKE_GATE_HANDOFF_LEDGER \
        SMOKE_GATE_OWNER SMOKE_GATE_LEASE_TTL_SECONDS 2>/dev/null || true
}

fresh_state() {
  STATE_DIR="$(mktemp -d)"
  export SMOKE_GATE_STATE_DIR="$STATE_DIR"
  export SMOKE_GATE_SHARED_ROOT="$TEST_SHARED_ROOT"
  export SMOKE_GATE_LEASE_DIR="$TEST_SHARED_ROOT/$(basename "$STATE_DIR")/leases"
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
POLL_OUT="$(bash "$GATE" poll)"
jq -e --arg sha "$HEAD_SHA" '
  .wakeAgent == true and .data.trigger == "pr_build_settled" and
  .data.pr == 42 and .data.sourceSha == $sha and
  .data.previewUrl == "https://xzo-dev-backend-pr-42.onrender.com" and
  .data.isFreezePr == false and .data.ciSha == $sha and
  .data.recovery == false and .data.abandonedActiveSha == null and
  (.data.runId | test("^smoke-pr42-")) and
  (.data.coordinatorOwnerToken | test("^owner-[0-9a-f]{64}$"))
' <<<"$POLL_OUT" >/dev/null
POLL_RUN="$(jq -r '.data.runId' <<<"$POLL_OUT")"
POLL_OWNER="$(jq -r '.data.coordinatorOwnerToken' <<<"$POLL_OUT")"
jq -e --arg sha "$HEAD_SHA" '
  .activeSha == $sha and .activeRunId != null and .activeLeaseOwner != null and .completedSha == null
' "$STATE_DIR/pr-42-state.json" >/dev/null
jq -e --arg owner "$POLL_OWNER" '.owner == $owner' "$SMOKE_GATE_LEASE_DIR/lease-$POLL_RUN.json" >/dev/null
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
# `pr_preflight_failed`, not `preflight_failed`: dispositions are keyed by
# trigger name and the develop gate owns the only `ack` verb, so a shared name
# let an ack from here destroy a live develop-gate silence. The fingerprint is
# gate-scoped for the same reason and must never be the bare reason.
PF_WAKE="$(bash "$GATE" poll)"
jq -e '
  .wakeAgent == true and .data.trigger == "pr_preflight_failed" and
  (.data.reason | test("could not be verified")) and
  (.data.fingerprint | startswith("pr|")) and
  (.data.fingerprint != .data.reason)
' <<<"$PF_WAKE" >/dev/null
[ ! -e "$STATE_DIR/pr-44-state.json" ] || jq -e '.activeRunId == null' "$STATE_DIR/pr-44-state.json" >/dev/null
unset SMOKE_GATE_PREFLIGHT_CMD

# --- 3c. INVARIANT 2, the PR-gate half: the re-arm throttle keys on the
# gate-computed FINGERPRINT, not the reason string.
#
# This suite had NO flap sequence at all — only single-failure and URL-routing
# preflight cases — so the develop gate's I2c latch mutant was killed on that
# side and SURVIVED here, in code carrying the identical latch. The sequence
# that separates the two keyings: alarm on reason A, throttle a CHANGED reason
# B inside the re-arm floor (the throttled branch persists `.preflightReason`
# but deliberately NOT `.preflightFingerprint`, so "last seen" and "last
# alarmed" diverge exactly here), age past the floor, then flap back to A.
# Keyed on the fingerprint, A is still the last thing we alarmed on and must
# stay silent. Keyed on the reason, A reads as news and wakes for an incident
# the operator was already told about, every time the text flaps back.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
HEAD_SHA="$(sha e)"
export STUB_PR_LIST="[{\"number\":45,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\"}]"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$HEAD_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-45\",\"name\":\"XZO-DEV-BACKEND PR #45\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-45.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$HEAD_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
FLAP_CTL="$STATE_DIR/control.json"
flap_poll() { SMOKE_GATE_PREFLIGHT_CMD="echo \"$1\"; exit 1" bash "$GATE" poll; }
# Push the last preflight wake back past the re-arm FLOOR (900s) but nowhere
# near the ALERT ceiling (21600s), which re-arms unconditionally and would make
# a fingerprint latch and a reason latch behave identically — i.e. would make
# this case unable to fail for the reason it claims.
flap_age() {
  local t; t="$(date -u -d '@'$(( $(date -u +%s) - 1000 )) +'%Y-%m-%dT%H:%M:%SZ')"
  jq --arg t "$t" '.preflightWakeAt=$t' "$FLAP_CTL" > "$FLAP_CTL.t" && mv "$FLAP_CTL.t" "$FLAP_CTL"
}
flap_poll "3 of 8 QA seats could not be verified" | jq -e '
  .wakeAgent == true and .data.trigger == "pr_preflight_failed"
' >/dev/null
# Changed reason inside the floor: throttled, but the new text IS recorded.
flap_poll "8 of 8 QA seats could not be verified" | jq -e '.wakeAgent == false' >/dev/null
jq -e '.preflightReason == "8 of 8 QA seats could not be verified"' "$FLAP_CTL" >/dev/null
# Past the floor, flapped BACK to the reason we last alarmed on: still silent.
flap_age
flap_poll "3 of 8 QA seats could not be verified" | jq -e '.wakeAgent == false' >/dev/null \
  || { echo "the pr-gate preflight throttle re-alarmed on a reason it had already alarmed on" >&2; exit 1; }
# ...and past the floor a genuinely NEW reason still re-arms — the floor delays
# news, it never suppresses it.
flap_age
flap_poll "6 of 8 QA seats could not be verified" | jq -e '
  .wakeAgent == true and (.data.reason | test("6 of 8"))
' >/dev/null
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
# reclaimable under its published run id — the recovery path this fix must not
# break and the run-id continuity rule requires.
export SMOKE_GATE_PROGRESS_STALE_SECONDS=0
bash "$GATE" claim run-rival 55 "$DUP_SHA" | jq -e '
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

# --- 10a. An empty PR list from an UNREACHABLE repo must not read as "nothing
# labeled". `gh pr list` goes through the search API, which answers a renamed
# repo or a rescoped token with HTTP 200 / `[]` / exit 0 — byte-identical to
# the healthy idle in scenario 2, which is why the reachability probe exists.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
export STUB_PR_LIST='[]' STUB_PR_LIST_EXIT=0 STUB_REPO_VIEW_EXIT=1
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "gate_fetch_failed"' >/dev/null
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "gate_fetch_failed"' >/dev/null
bash "$GATE" poll | jq -e '
  .wakeAgent == true and .data.trigger == "gate_fetch_failed" and .data.consecutiveFailures == 3
' >/dev/null
# And the probe must cost the healthy path nothing: a reachable repo with an
# empty list is still a quiet idle, not a strike.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
export STUB_PR_LIST='[]' STUB_REPO_VIEW_EXIT=0
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "waiting_for_candidates"' >/dev/null

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

LOCKFAIL_OUT="$(bash "$GATE" finish "$LOCKFAIL_HEAD" run-lockfail NO_GO 2>/dev/null || true)"
jq -e '
  .ok == false and .leaseReleased == false and
  (.error | test("terminal artifact write failed"))
' <<<"$LOCKFAIL_OUT" >/dev/null
# The hold/publish artifacts were still written correctly — only the
# ledger's own append failed.
jq -e --arg sha "$LOCKFAIL_TARGET" '.sha == $sha and .verdict == "NO_GO"' "$DEV_PUBLISH3" >/dev/null
jq -e --arg sha "$LOCKFAIL_TARGET" '.sha == $sha and .verdict == "NO_GO"' "$DEV_HOLD3" >/dev/null
[ ! -e "$BAD_LEDGER" ]
jq -e '.activeRunId == "run-lockfail" and .completedSha == null' "$STATE_DIR/pr-70-state.json" >/dev/null
[ -s "$SMOKE_GATE_LEASE_DIR/lease-run-lockfail.json" ]
# The held slot and lease make the failure retryable once storage is repaired.
export SMOKE_GATE_HANDOFF_LEDGER="$STATE_DIR/dev-gate3/handoff-ledger.jsonl"
bash "$GATE" finish "$LOCKFAIL_HEAD" run-lockfail NO_GO | jq -e '.ok == true and .leaseReleased == true' >/dev/null

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

# --- 18. finish holds its authority locks through terminal side effects ------
# The state and shared lifecycle locks fence the network and artifact window,
# so an expired predecessor cannot publish after a successor reclaims.
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
if [ "$(cat "$STUB_LOCK_PROBE" 2>/dev/null)" != "held" ]; then
  echo "expected finish to hold the PR state lock through the suspend POST, probe said: $(cat "$STUB_LOCK_PROBE" 2>/dev/null)" >&2
  exit 1
fi
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

# --- 20. finish is crash-safe: artifacts BEFORE the slot is cleared ---------
# Clearing the slot first made finish fail OPEN and permanently: a container
# death between the halves recorded NO_GO per-PR while the promotion hold was
# never raised and the ledger line never landed, and the retry was refused with
# "not the active run" because activeRunId was already null. The develop gate
# survives its identical window via its hold-integrity reconciler; the PR gate
# has none, so the ORDER is the whole contract.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
CRASH_TARGET="$(sha 9)"
CRASH_HEAD="$(sha a)"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$CRASH_TARGET"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-91\",\"name\":\"backend-preview PR #91\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://b.onrender.com\"}}]"
export STUB_SUSPEND_CODE=202
CRASH_PUBLISH="$STATE_DIR/crash/latest-verdict.json"
CRASH_HOLD="$STATE_DIR/crash/develop-hold.json"
CRASH_LEDGER="$STATE_DIR/crash/handoff-ledger.jsonl"
export SMOKE_GATE_PUBLISH_FILE="$CRASH_PUBLISH" SMOKE_GATE_HOLD_FILE="$CRASH_HOLD" \
  SMOKE_GATE_HANDOFF_LEDGER="$CRASH_LEDGER"
bash "$GATE" claim run-crash 91 "$CRASH_HEAD" >/dev/null

# The slot must still be held at the moment the artifact work starts.
export STUB_STATE_PROBE="$STATE_DIR/state-probe.json"
export STUB_STATE_PROBE_FILE="$STATE_DIR/pr-91-state.json"
# ...and a real death right there: the stub stalls past the outer timeout.
export STUB_SUSPEND_SLEEP=5
timeout 2 bash "$GATE" finish "$CRASH_HEAD" run-crash NO_GO >/dev/null 2>&1 || true
unset STUB_SUSPEND_SLEEP

jq -e '.activeRunId == "run-crash" and .completedSha == null' "$STUB_STATE_PROBE" >/dev/null || {
  echo "the slot was already cleared when the artifact work began: $(cat "$STUB_STATE_PROBE")" >&2
  exit 1; }
jq -e '.activeRunId == "run-crash" and .completedVerdict == null' "$STATE_DIR/pr-91-state.json" >/dev/null || {
  echo "a crash mid-finish left the slot cleared, so the retry can never complete: $(cat "$STATE_DIR/pr-91-state.json")" >&2
  exit 1; }
[ ! -e "$CRASH_HOLD" ] || { echo "fixture: the hold should not exist yet after the crash" >&2; exit 1; }

# The retry completes rather than being refused, and lands every artifact.
bash "$GATE" finish "$CRASH_HEAD" run-crash NO_GO | jq -e --arg t "$CRASH_TARGET" '
  .ok == true and .verdict == "NO_GO" and .handoff.written == true and .handoff.targetSha == $t
' >/dev/null || { echo "the retry after a mid-finish crash was refused" >&2; exit 1; }
jq -e --arg t "$CRASH_TARGET" '.sha == $t and .verdict == "NO_GO"' "$CRASH_HOLD" >/dev/null
jq -e --arg t "$CRASH_TARGET" '.sha == $t' "$CRASH_PUBLISH" >/dev/null
jq -e --arg t "$CRASH_TARGET" 'select(.targetSha == $t) | .runId == "run-crash"' "$CRASH_LEDGER" >/dev/null
jq -e --arg sha "$CRASH_HEAD" '.completedSha == $sha and .activeRunId == null' \
  "$STATE_DIR/pr-91-state.json" >/dev/null

# --- 21. a takeover cannot enter DURING the terminal artifact window --------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
TO_SHA="$(sha b)"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-92\",\"name\":\"backend-preview PR #92\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://b.onrender.com\"}}]"
export STUB_SUSPEND_CODE=202
bash "$GATE" claim run-old 92 "$TO_SHA" >/dev/null
# Simulate the successor claiming while this finish is on the network.
export STUB_SUSPEND_SLEEP=2
bash "$GATE" finish "$TO_SHA" run-old GO > "$STATE_DIR/takeover-out.json" 2>/dev/null &
FIN=$!
sleep 0.5
TO_CLAIM="$(SMOKE_GATE_LOCK_WAIT_SECONDS=1 bash "$GATE" claim run-new 92 "$TO_SHA" --takeover || true)"
wait "$FIN" || true
unset STUB_SUSPEND_SLEEP
jq -e '.ok == false and .retryable == true and (.error | test("gate_lock_busy"))' <<<"$TO_CLAIM" >/dev/null || {
  echo "expected the concurrent takeover to wait outside the terminal fence, got: $TO_CLAIM" >&2
  exit 1; }
jq -e '.ok == true and .runId == "run-old"' "$STATE_DIR/takeover-out.json" >/dev/null
jq -e '.activeRunId == null and .completedRunId == "run-old"' "$STATE_DIR/pr-92-state.json" >/dev/null
# Once the terminal transition is complete, a new claim may proceed normally.
bash "$GATE" claim run-new 92 "$TO_SHA" --takeover | jq -e '.ok == true and .runId == "run-new"' >/dev/null

# --- 22. P1 regression: `finish` must refuse a SHA that is not the one this
# run claimed. Live on 2026-08-25 (freeze PR #1211): the coordinator passed
# the TARGET develop sha instead of the freeze-marker sha it had claimed and
# tested. detect_freeze walks the supplied sha's first parent, so the walk
# landed one commit early and the hold, publish file and ledger line all went
# out naming PR #1199's commit — a build the campaign never examined — while
# `finish` exited ok:true. The gate already holds the claimed sha in
# activeSha; the whole fix is to compare against it before any side effect.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
CLAIMED="$(sha c)"
NOT_CLAIMED="$(sha d)"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$(sha e)"
DEV_PUBLISH4="$STATE_DIR/dev-gate4/latest-verdict.json"
DEV_HOLD4="$STATE_DIR/dev-gate4/develop-hold.json"
DEV_LEDGER4="$STATE_DIR/dev-gate4/handoff-ledger.jsonl"
export SMOKE_GATE_PUBLISH_FILE="$DEV_PUBLISH4" SMOKE_GATE_HOLD_FILE="$DEV_HOLD4" \
  SMOKE_GATE_HANDOFF_LEDGER="$DEV_LEDGER4"
bash "$GATE" claim run-wrongsha 93 "$CLAIMED" >/dev/null
# Exits 2, the same as the other malformed-invocation refusals, so capture
# before piping — `set -o pipefail` would otherwise read the refusal itself
# as the test failing.
WRONGSHA_OUT="$(bash "$GATE" finish "$NOT_CLAIMED" run-wrongsha NO_GO || true)"
jq -e --arg c "$CLAIMED" --arg w "$NOT_CLAIMED" '
  .ok == false and .claimedSha == $c and .suppliedSha == $w and
  (.error | test("does not match the sha this run claimed"))
' <<<"$WRONGSHA_OUT" >/dev/null || {
  echo "expected finish to refuse a sha this run never claimed, got: $WRONGSHA_OUT" >&2; exit 1; }
# Nothing was written and the slot was NOT released — the refusal is fully
# recoverable, unlike a verdict recorded against the wrong build.
[ ! -e "$DEV_HOLD4" ] && [ ! -e "$DEV_PUBLISH4" ] && [ ! -e "$DEV_LEDGER4" ] || {
  echo "a refused finish still wrote handoff artifacts" >&2; exit 1; }
jq -e '.activeRunId == "run-wrongsha" and .completedSha == null' "$STATE_DIR/pr-93-state.json" >/dev/null
[ ! -e "$STATE_DIR/pr-93-verdict.json" ]
# The retry named in the error text actually works.
bash "$GATE" finish "$CLAIMED" run-wrongsha NO_GO | jq -e '.ok == true and .handoff.written == true' >/dev/null

# --- 23. P1 regression: an artifact write that FAILS must be reported, and the
# resulting hold/ledger divergence must survive the next finish. Every
# publish/hold write was previously unchecked (`set -e` is not in effect), so
# an unwritable shared mount — the hold lives on the workgroup mount, the
# ledger does not — left handoff.written:true / reason:null while the ledger
# line landed anyway: a NO_GO whose promotion hold silently never went up.
# The divergence was then erased by the NEXT run's finish, which is why the
# 2026-08-18, -22 and -25 occurrences are all un-diagnosable.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
DIV_SHA="$(sha f)"
DIV_TARGET="$(sha 0)"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$DIV_TARGET"
SHARED="$STATE_DIR/shared-mount"
mkdir -p "$SHARED"
export SMOKE_GATE_PUBLISH_FILE="$SHARED/latest-verdict.json" \
  SMOKE_GATE_HOLD_FILE="$SHARED/develop-hold.json" \
  SMOKE_GATE_HANDOFF_LEDGER="$STATE_DIR/agent-mount/handoff-ledger.jsonl"
bash "$GATE" claim run-div-a 94 "$DIV_SHA" >/dev/null
bash "$GATE" finish "$DIV_SHA" run-div-a NO_GO | jq -e '.ok == true and .handoff.written == true' >/dev/null
# Now the shared mount goes unwritable mid-campaign; the ledger's mount is fine.
chmod 500 "$SHARED"
bash "$GATE" claim run-div-b 94 "$DIV_SHA" >/dev/null
DIV_OUT="$(bash "$GATE" finish "$DIV_SHA" run-div-b HUMAN_DECISION 2>/dev/null || true)"
chmod 700 "$SHARED"   # restore before asserting, so a failure still cleans up
jq -e '
  .ok == false and .leaseReleased == false and
  (.error | test("promotion is ungated"))
' <<<"$DIV_OUT" >/dev/null || {
  echo "a failed hold raise was reported as a successful handoff, got: $DIV_OUT" >&2; exit 1; }
# The prior hold and newly appended ledger line are divergent, while the failed
# owner keeps its slot and lease for an exact retry under the same fence.
jq -e '.runId == "run-div-a"' "$SMOKE_GATE_HOLD_FILE" >/dev/null
tail -1 "$SMOKE_GATE_HANDOFF_LEDGER" | jq -e '.runId == "run-div-b"' >/dev/null
jq -e '.activeRunId == "run-div-b" and .completedRunId == "run-div-a"' "$STATE_DIR/pr-94-state.json" >/dev/null
[ -s "$SMOKE_GATE_LEASE_DIR/lease-run-div-b.json" ]
REPAIRED="$(bash "$GATE" finish "$DIV_SHA" run-div-b HUMAN_DECISION)"
jq -e '.ok == true and .leaseReleased == true and .handoff.divergenceSnapshot != null' <<<"$REPAIRED" >/dev/null
jq -e '.runId == "run-div-b" and .verdict == "HUMAN_DECISION"' "$SMOKE_GATE_HOLD_FILE" >/dev/null
# A later successful finish observes the repaired, in-step records.
bash "$GATE" claim run-div-c 94 "$DIV_SHA" >/dev/null
bash "$GATE" finish "$DIV_SHA" run-div-c NO_GO | jq -e '.handoff.divergenceSnapshot == null' >/dev/null
# A BLOCKED verdict is NOT hold-affecting (it deliberately leaves the hold
# alone), so it must never be read as a divergence on the next finish.
bash "$GATE" claim run-div-d 94 "$DIV_SHA" >/dev/null
bash "$GATE" finish "$DIV_SHA" run-div-d BLOCKED >/dev/null
bash "$GATE" claim run-div-e 94 "$DIV_SHA" >/dev/null
bash "$GATE" finish "$DIV_SHA" run-div-e NO_GO | jq -e '.handoff.divergenceSnapshot == null' >/dev/null || {
  echo "a BLOCKED ledger line was mistaken for a hold divergence" >&2; exit 1; }

# --- 24. an unreadable PR diff during finish is not the same as "ordinary PR".
# detect_freeze collapses a failed files fetch to isFreezePr:false, which the
# handoff block treated identically to a non-freeze PR: nothing written, and
# handoff.reason null on an ok:true finish. If the PR really was a freeze PR
# its verdict was dropped silently. Reporting only — a genuine non-freeze PR
# (test 14 above) still reports reason:null.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
BLIND_SHA="$(sha 1)"
export SMOKE_GATE_PUBLISH_FILE="$STATE_DIR/blind/latest-verdict.json" \
  SMOKE_GATE_HOLD_FILE="$STATE_DIR/blind/develop-hold.json"
bash "$GATE" claim run-blind 95 "$BLIND_SHA" >/dev/null
export STUB_PR_FILES_EXIT=1
bash "$GATE" finish "$BLIND_SHA" run-blind NO_GO | jq -e '
  .ok == true and .handoff.written == false and
  (.handoff.reason | test("freeze-PR status is unknown"))
' >/dev/null || { echo "an unreadable diff during finish was reported as an ordinary PR" >&2; exit 1; }


# --- 25. Cross-target interleaving: the divergence check compares the hold
# against the newest hold-affecting ledger line for ANY target, deliberately
# NOT scoped to this run's targetSha. The hold file is a single mutable slot
# meaning "is develop gated right now", so the last decision about that slot
# is the right comparand no matter which freeze PR made it. Scoping the
# comparison to the current target would read a stale same-target line and
# report a divergence that does not exist — this pins the untargeted
# semantics, so that change fails here.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
ILV_SHARED="$STATE_DIR/interleave"
mkdir -p "$ILV_SHARED"
export SMOKE_GATE_PUBLISH_FILE="$ILV_SHARED/latest-verdict.json" \
  SMOKE_GATE_HOLD_FILE="$ILV_SHARED/develop-hold.json" \
  SMOKE_GATE_HANDOFF_LEDGER="$ILV_SHARED/handoff-ledger.jsonl"
ILV_T1="$(sha a)"
ILV_T2="$(sha b)"
ILV_HEAD1="$(sha c)"
ILV_HEAD2="$(sha d)"
# Freeze PR #96 gates target T1.
export STUB_PARENT_SHA="$ILV_T1"
bash "$GATE" claim run-ilv-1 96 "$ILV_HEAD1" >/dev/null
bash "$GATE" finish "$ILV_HEAD1" run-ilv-1 NO_GO | jq -e '.handoff.written == true' >/dev/null
# A DIFFERENT freeze PR #97, on a different target T2, takes the slot next.
export STUB_PARENT_SHA="$ILV_T2"
bash "$GATE" claim run-ilv-2 97 "$ILV_HEAD2" >/dev/null
bash "$GATE" finish "$ILV_HEAD2" run-ilv-2 NO_GO | jq -e '
  .handoff.written == true and .handoff.divergenceSnapshot == null
' >/dev/null || { echo "PR #97 read PR #96's in-step hold as a divergence" >&2; exit 1; }
jq -e --arg sha "$ILV_T2" '.sha == $sha and .runId == "run-ilv-2"' "$SMOKE_GATE_HOLD_FILE" >/dev/null
# Back to PR #96 / target T1. Hold and ledger are in step — both name
# run-ilv-2 — so there is NO divergence. Scoped to T1, the newest matching
# ledger line would be run-ilv-1 and this would falsely report "hold names a
# different run than the ledger".
export STUB_PARENT_SHA="$ILV_T1"
bash "$GATE" claim run-ilv-3 96 "$ILV_HEAD1" >/dev/null
bash "$GATE" finish "$ILV_HEAD1" run-ilv-3 NO_GO | jq -e '
  .handoff.written == true and .handoff.divergenceSnapshot == null
' >/dev/null || {
  echo "a cross-target hold was misread as a divergence — the comparison must NOT be scoped to targetSha" >&2
  exit 1; }
[ "$(ls "$STATE_DIR"/hold-divergence-* 2>/dev/null | wc -l)" -eq 0 ] || {
  echo "a divergence snapshot was written for an in-step cross-target hold" >&2; exit 1; }

# --- 26. P2 regression: the ledger APPEND itself must be verified, not just
# the lock. Test 15 covers a lock that cannot be taken; this is the other
# half — the lock succeeds (its file lives in a writable directory) and the
# `>>` fails at the FILE level (ENOSPC, chattr +i, a bad mode). That left
# handoff.written:true / reason:null with no ledger line at all: the develop
# gate blind to a NO_GO whose hold DID go up. Same read-back idiom as the
# publish/hold writes. Directory stays writable throughout — only the
# ledger file is unwritable.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
APPFAIL_TARGET="$(sha 3)"
APPFAIL_HEAD="$(sha 4)"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$APPFAIL_TARGET"
APPFAIL_DIR="$STATE_DIR/dev-gate4"
mkdir -p "$APPFAIL_DIR"
APPFAIL_LEDGER="$APPFAIL_DIR/handoff-ledger.jsonl"
: > "$APPFAIL_LEDGER"
chmod 400 "$APPFAIL_LEDGER"
export SMOKE_GATE_PUBLISH_FILE="$APPFAIL_DIR/latest-verdict.json" \
  SMOKE_GATE_HOLD_FILE="$APPFAIL_DIR/develop-hold.json" \
  SMOKE_GATE_HANDOFF_LEDGER="$APPFAIL_LEDGER"
bash "$GATE" claim run-appfail 98 "$APPFAIL_HEAD" >/dev/null
APPFAIL_OUT="$(bash "$GATE" finish "$APPFAIL_HEAD" run-appfail NO_GO 2>/dev/null || true)"
chmod 600 "$APPFAIL_LEDGER"   # restore before asserting, so a failure still cleans up
jq -e --arg target "$APPFAIL_TARGET" '
  .ok == false and .leaseReleased == false and
  (.error | test("handoff-ledger.jsonl"))
' <<<"$APPFAIL_OUT" >/dev/null || {
  echo "an unwritten ledger line was reported as a successful handoff, got: $APPFAIL_OUT" >&2; exit 1; }
[ "$(wc -c < "$APPFAIL_LEDGER")" -eq 0 ]
# The hold still went up — a ledger failure must never skip or undo it.
jq -e --arg sha "$APPFAIL_TARGET" '.sha == $sha and .runId == "run-appfail"' "$APPFAIL_DIR/develop-hold.json" >/dev/null
jq -e '.activeRunId == "run-appfail" and .completedSha == null' "$STATE_DIR/pr-98-state.json" >/dev/null
[ -s "$SMOKE_GATE_LEASE_DIR/lease-run-appfail.json" ]
bash "$GATE" finish "$APPFAIL_HEAD" run-appfail NO_GO | jq -e '.ok == true and .leaseReleased == true' >/dev/null
tail -1 "$APPFAIL_LEDGER" | jq -e '.runId == "run-appfail"' >/dev/null

# --- 27. one shared PR cannot have two live run ids across private roots -----
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base SMOKE_GATE_LEASE_TTL_SECONDS=30
PR_BASE="$STATE_DIR" PR_STATE_A="$PR_BASE/state-a" PR_STATE_B="$PR_BASE/state-b"
mkdir -p "$PR_STATE_A" "$PR_STATE_B"
PR_COMMON_LEASE="$TEST_SHARED_ROOT/same-pr-different-run/leases"
PR_BIND_SHA="$(sha a)"
SMOKE_GATE_STATE_DIR="$PR_STATE_A" SMOKE_GATE_LEASE_DIR="$PR_COMMON_LEASE" \
  bash "$GATE" claim run-pr-a 119 "$PR_BIND_SHA" owner-a | jq -e '.ok == true' >/dev/null
SECOND="$(SMOKE_GATE_STATE_DIR="$PR_STATE_B" SMOKE_GATE_LEASE_DIR="$PR_COMMON_LEASE" \
  bash "$GATE" claim run-pr-b 119 "$PR_BIND_SHA" owner-b || true)"
jq -e '.ok == false and .activeRunId == "run-pr-a" and (.error | test("shared coordinator registry"))' <<<"$SECOND" >/dev/null
jq -e '.runId == "run-pr-a" and .owner == "owner-a"' "$PR_COMMON_LEASE/pr-119-authority.json" >/dev/null
[ ! -e "$PR_COMMON_LEASE/lease-run-pr-b.json" ] && [ ! -e "$PR_STATE_B/pr-119-state.json" ]
# The existing explicit operator takeover remains the only live replacement.
SMOKE_GATE_STATE_DIR="$PR_STATE_B" SMOKE_GATE_LEASE_DIR="$PR_COMMON_LEASE" \
  bash "$GATE" claim run-pr-b 119 "$PR_BIND_SHA" owner-b --takeover | jq -e '.ok == true' >/dev/null
jq -e '.runId == "run-pr-b" and .owner == "owner-b"' "$PR_COMMON_LEASE/pr-119-authority.json" >/dev/null
SMOKE_GATE_STATE_DIR="$PR_STATE_B" SMOKE_GATE_LEASE_DIR="$PR_COMMON_LEASE" \
  bash "$GATE" release run-pr-b owner-b | jq -e '.ok == true' >/dev/null

# --- 28. stale owner A cannot act after B reclaims through another state root
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base SMOKE_GATE_LEASE_TTL_SECONDS=1
STALE_BASE="$STATE_DIR"
STATE_A="$STALE_BASE/private-a" STATE_B="$STALE_BASE/private-b"
mkdir -p "$STATE_A" "$STATE_B"
COMMON_LEASE="$TEST_SHARED_ROOT/stale-separate/leases"
STALE_SHA="$(sha 5)"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$(sha 4)"
export SMOKE_GATE_PUBLISH_FILE="$STALE_BASE/latest-verdict.json" \
  SMOKE_GATE_HOLD_FILE="$STALE_BASE/develop-hold.json" \
  SMOKE_GATE_HANDOFF_LEDGER="$STALE_BASE/handoff-ledger.jsonl"
SMOKE_GATE_STATE_DIR="$STATE_A" SMOKE_GATE_LEASE_DIR="$COMMON_LEASE" \
  bash "$GATE" claim run-shared-owner 120 "$STALE_SHA" owner-a | jq -e '.ok == true' >/dev/null
sleep 2
SMOKE_GATE_STATE_DIR="$STATE_B" SMOKE_GATE_LEASE_DIR="$COMMON_LEASE" SMOKE_GATE_LEASE_TTL_SECONDS=30 \
  bash "$GATE" claim run-shared-owner 120 "$STALE_SHA" owner-b | jq -e '.ok == true' >/dev/null
export SMOKE_GATE_LEASE_TTL_SECONDS=30
STALE_PROGRESS="$(SMOKE_GATE_STATE_DIR="$STATE_A" SMOKE_GATE_LEASE_DIR="$COMMON_LEASE" \
  bash "$GATE" progress run-shared-owner owner-a || true)"
jq -e '.ok == false and (.error | test("lease"))' <<<"$STALE_PROGRESS" >/dev/null
STALE_RELEASE="$(SMOKE_GATE_STATE_DIR="$STATE_A" SMOKE_GATE_LEASE_DIR="$COMMON_LEASE" \
  bash "$GATE" release run-shared-owner owner-a || true)"
jq -e '.ok == false and (.error | test("lease"))' <<<"$STALE_RELEASE" >/dev/null
STALE_FINISH="$(SMOKE_GATE_STATE_DIR="$STATE_A" SMOKE_GATE_LEASE_DIR="$COMMON_LEASE" \
  bash "$GATE" finish "$STALE_SHA" run-shared-owner NO_GO owner-a || true)"
jq -e '.ok == false and (.error | test("lease"))' <<<"$STALE_FINISH" >/dev/null
jq -e '.owner == "owner-b"' "$COMMON_LEASE/lease-run-shared-owner.json" >/dev/null
[ ! -e "$STATE_A/pr-120-verdict.json" ] && [ ! -e "$STATE_A/runs/run-shared-owner/verdict.json" ]
[ ! -e "$SMOKE_GATE_PUBLISH_FILE" ] && [ ! -e "$SMOKE_GATE_HOLD_FILE" ] && [ ! -e "$SMOKE_GATE_HANDOFF_LEDGER" ]
SMOKE_GATE_STATE_DIR="$STATE_B" SMOKE_GATE_LEASE_DIR="$COMMON_LEASE" \
  bash "$GATE" release run-shared-owner owner-b | jq -e '.ok == true and .leaseReleased == true' >/dev/null

# --- 29. stale owner cannot adopt B's token from the same mutable state ------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base SMOKE_GATE_LEASE_TTL_SECONDS=1
SAME_SHA="$(sha 6)"
bash "$GATE" claim run-same-state 121 "$SAME_SHA" owner-a | jq -e '.ok == true' >/dev/null
sleep 2
SMOKE_GATE_LEASE_TTL_SECONDS=30 bash "$GATE" claim run-same-state 121 "$SAME_SHA" owner-b | jq -e '.ok == true' >/dev/null
export SMOKE_GATE_LEASE_TTL_SECONDS=30
for verb in progress release; do
  OUT="$(SMOKE_GATE_OWNER=owner-a bash "$GATE" "$verb" run-same-state || true)"
  jq -e '.ok == false and (.error | test("caller owner"))' <<<"$OUT" >/dev/null
done
OUT="$(SMOKE_GATE_OWNER=owner-a bash "$GATE" finish "$SAME_SHA" run-same-state NO_GO || true)"
jq -e '.ok == false and (.error | test("caller owner"))' <<<"$OUT" >/dev/null
jq -e '.owner == "owner-b"' "$SMOKE_GATE_LEASE_DIR/lease-run-same-state.json" >/dev/null
[ ! -e "$STATE_DIR/pr-121-verdict.json" ] && [ ! -e "$STATE_DIR/runs/run-same-state/verdict.json" ]
# The forwarded token works from a different execution identity and progress
# renews the live lease instead of guessing authority from mutable PR state.
BEFORE_EXP="$(jq -r '.expiresAt' "$SMOKE_GATE_LEASE_DIR/lease-run-same-state.json")"
SMOKE_GATE_OWNER=unrelated bash "$GATE" progress run-same-state owner-b | jq -e '.ok == true and .leaseRenewed == true' >/dev/null
AFTER_EXP="$(jq -r '.expiresAt' "$SMOKE_GATE_LEASE_DIR/lease-run-same-state.json")"
[ "$(date -u -d "$AFTER_EXP" +%s)" -ge "$(date -u -d "$BEFORE_EXP" +%s)" ]
bash "$GATE" release run-same-state owner-b | jq -e '.ok == true and .leaseReleased == true' >/dev/null

# Expiry ends standalone renew/release authority. Recovery is the serialized
# same-run claim using the original token, never reviving an expired lease.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base SMOKE_GATE_LEASE_TTL_SECONDS=1
EXPIRED_SHA="$(sha b)"
bash "$GATE" claim run-expired-owner 127 "$EXPIRED_SHA" owner-a | jq -e '.ok == true' >/dev/null
sleep 2
for lease_verb in lease-renew lease-release; do
  OUT="$(bash "$GATE" "$lease_verb" run-expired-owner owner-a || true)"
  jq -e '.ok == false and (.error | test("expired")) and (.error | test("recover with claim"))' <<<"$OUT" >/dev/null
  [ -s "$SMOKE_GATE_LEASE_DIR/lease-run-expired-owner.json" ]
done
SMOKE_GATE_LEASE_TTL_SECONDS=30 bash "$GATE" claim run-expired-owner 127 "$EXPIRED_SHA" owner-a | jq -e '.ok == true' >/dev/null
bash "$GATE" release run-expired-owner owner-a | jq -e '.ok == true' >/dev/null

# --- 30. malformed and non-shared lease storage fail closed -----------------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
BAD_SHA="$(sha 7)"
mkdir -p "$SMOKE_GATE_LEASE_DIR"
printf '{broken\n' > "$SMOKE_GATE_LEASE_DIR/lease-run-malformed.json"
BAD="$(bash "$GATE" lease-status run-malformed 2>/dev/null || true)"
jq -e '.ok == false and (.error | test("malformed"))' <<<"$BAD" >/dev/null
BAD="$(bash "$GATE" claim run-malformed 122 "$BAD_SHA" owner-a 2>/dev/null || true)"
jq -e '.ok == false and (.error | test("malformed"))' <<<"$BAD" >/dev/null
grep -q '^{' "$SMOKE_GATE_LEASE_DIR/lease-run-malformed.json"
MISSING_ROOT="$STATE_DIR/no-such-shared-root"
BAD="$(SMOKE_GATE_SHARED_ROOT="$MISSING_ROOT" SMOKE_GATE_LEASE_DIR="$MISSING_ROOT/leases" \
  bash "$GATE" claim run-missing 123 "$BAD_SHA" owner-a 2>/dev/null || true)"
jq -e '.ok == false and (.error | test("missing"))' <<<"$BAD" >/dev/null
ln -s "$STATE_DIR" "$TEST_SHARED_ROOT/private-alias"
BAD="$(SMOKE_GATE_LEASE_DIR="$TEST_SHARED_ROOT/private-alias/leases" \
  bash "$GATE" claim run-private-alias 124 "$BAD_SHA" owner-a 2>/dev/null || true)"
jq -e '.ok == false and (.error | test("non-shared|outside shared"))' <<<"$BAD" >/dev/null
[ ! -e "$STATE_DIR/pr-123-state.json" ] && [ ! -e "$STATE_DIR/pr-124-state.json" ]

# A present binding whose referenced lease is corrupt or owner-inconsistent is
# unknown authority, never an expired slot available for replacement.
CORRUPT_A="$STATE_DIR/corrupt-a" CORRUPT_B="$STATE_DIR/corrupt-b"
mkdir -p "$CORRUPT_A" "$CORRUPT_B"
CORRUPT_LEASE="$TEST_SHARED_ROOT/corrupt-binding/leases"
SMOKE_GATE_STATE_DIR="$CORRUPT_A" SMOKE_GATE_LEASE_DIR="$CORRUPT_LEASE" \
  bash "$GATE" claim run-corrupt-a 128 "$BAD_SHA" owner-a | jq -e '.ok == true' >/dev/null
printf '{broken\n' > "$CORRUPT_LEASE/lease-run-corrupt-a.json"
BAD="$(SMOKE_GATE_STATE_DIR="$CORRUPT_B" SMOKE_GATE_LEASE_DIR="$CORRUPT_LEASE" \
  bash "$GATE" claim run-corrupt-b 128 "$BAD_SHA" owner-b --takeover 2>/dev/null || true)"
jq -e '.ok == false and (.error | test("malformed"))' <<<"$BAD" >/dev/null
jq -e '.runId == "run-corrupt-a" and .owner == "owner-a"' "$CORRUPT_LEASE/pr-128-authority.json" >/dev/null
[ ! -e "$CORRUPT_LEASE/lease-run-corrupt-b.json" ]

# A failed same-owner re-claim restores the preexisting live lease rather than
# deleting authority that another invocation still relies on.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
ROLL_SHA="$(sha 8)"
bash "$GATE" claim run-rollback 125 "$ROLL_SHA" owner-a | jq -e '.ok == true' >/dev/null
ROLL_BEFORE="$(cat "$SMOKE_GATE_LEASE_DIR/lease-run-rollback.json")"
ROLL_AUTH_BEFORE="$(cat "$SMOKE_GATE_LEASE_DIR/pr-125-authority.json")"
chmod 500 "$STATE_DIR"
ROLL_OUT="$(bash "$GATE" claim run-rollback 125 "$ROLL_SHA" owner-a 2>/dev/null || true)"
chmod 700 "$STATE_DIR"
jq -e '.ok == false and (.error | test("private PR slot"))' <<<"$ROLL_OUT" >/dev/null
[ "$(cat "$SMOKE_GATE_LEASE_DIR/lease-run-rollback.json")" = "$ROLL_BEFORE" ]
[ "$(cat "$SMOKE_GATE_LEASE_DIR/pr-125-authority.json")" = "$ROLL_AUTH_BEFORE" ]
bash "$GATE" release run-rollback owner-a | jq -e '.ok == true' >/dev/null

# Poll lease I/O failures retain the poll envelope and use the existing
# immediate-then-throttled alarm shape.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
POLL_FAIL_SHA="$(sha 9)"
export STUB_PR_LIST="[{\"number\":126,\"headRefOid\":\"$POLL_FAIL_SHA\",\"headRefName\":\"feature/y\"}]"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$POLL_FAIL_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES='[{"id":"backend-pr-126","name":"backend PR #126","serviceDetails":{"parentServer":{"id":"srv-backend-base"},"url":"https://preview.invalid"}}]'
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$POLL_FAIL_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
POLL_MISSING="$STATE_DIR/missing-shared"
for expected in true false; do
  OUT="$(SMOKE_GATE_SHARED_ROOT="$POLL_MISSING" SMOKE_GATE_LEASE_DIR="$POLL_MISSING/leases" bash "$GATE" poll)"
  jq -e --argjson expected "$expected" \
    '.ok == false and .wakeAgent == $expected and .data.trigger == "coordinator_lease_unavailable"' <<<"$OUT" >/dev/null
done

# --- INVARIANT 3: num_env rejects the classes it was built to stop --------
# Mirror of the develop suite's case-53 extension. "All digits" admitted three
# shapes, each a distinct silent failure: a leading zero is octal (or fatal) in
# `$(( ))` but DECIMAL in `[ -ge ]`, so the reported window and the effective
# window diverge; anything wider than int64 makes every `[ x -ge KNOB ]` an
# error, which in an `if` is false — a threshold that never fires; and
# set-but-empty took the default without being named.
fresh_state
unset SMOKE_GATE_REPO 2>/dev/null || true
for bad in 0900 0100 05900 99999999999999999999 "" abc; do
  SMOKE_GATE_WARMUP_TIMEOUT="$bad" bash "$GATE" poll | jq -e '
    .data.trigger == "gate_misconfigured" and
    (.data.missing | index("SMOKE_GATE_WARMUP_TIMEOUT") != null)
  ' >/dev/null || { echo "pr gate num_env admitted WARMUP_TIMEOUT='$bad'" >&2; exit 1; }
done
for ok in 0 1 600 999999999999999999; do
  SMOKE_GATE_WARMUP_TIMEOUT="$ok" bash "$GATE" poll | jq -e '
    .data.missing | index("SMOKE_GATE_WARMUP_TIMEOUT") == null
  ' >/dev/null || { echo "pr gate num_env rejected the legitimate WARMUP_TIMEOUT='$ok'" >&2; exit 1; }
done
bash "$GATE" poll | jq -e '.data.missing | index("SMOKE_GATE_WARMUP_TIMEOUT") == null' >/dev/null
export SMOKE_GATE_REPO=org/repo

echo "smoke pr gate tests passed"
