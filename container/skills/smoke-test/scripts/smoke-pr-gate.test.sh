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
# #1536 bundle-disambiguation oracle fixtures. Only exercised when the gate
# actually has 2+ backend candidates to disambiguate — every pre-existing
# scenario has 0 or 1, so these never fire outside the new tests below.
[ -n "${STUB_FRONTEND_HTML_EXIT+x}" ] || STUB_FRONTEND_HTML_EXIT=0
[ -n "${STUB_FRONTEND_HTML+x}" ] || STUB_FRONTEND_HTML='<html><body><script type="module" src="/assets/index-ABC123.js"></script></body></html>'
[ -n "${STUB_BUNDLE_EXIT+x}" ] || STUB_BUNDLE_EXIT=0
[ -n "${STUB_BUNDLE_JS+x}" ] || STUB_BUNDLE_JS=''
ARGS="$*"
if printf '%s' "$ARGS" | grep -qF '/suspend'; then
  # Receipt of every suspend POST that actually went out, so a test can
  # assert a refusal issued NONE rather than inferring it from a status field.
  if [ -n "${STUB_SUSPEND_LOG:-}" ]; then
    printf '%s\n' "$ARGS" >> "$STUB_SUSPEND_LOG"
  fi
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
# #1536: the bundle-disambiguation oracle's two fetches. Bundle path checked
# first (it also lives under the same onrender.com host as the frontend root).
if printf '%s' "$ARGS" | grep -qE '\.js($| )'; then
  [ "$STUB_BUNDLE_EXIT" = 0 ] || exit "$STUB_BUNDLE_EXIT"
  printf '%s' "$STUB_BUNDLE_JS"; exit 0
fi
if printf '%s' "$ARGS" | grep -qE 'onrender\.com/?( |$)'; then
  [ "$STUB_FRONTEND_HTML_EXIT" = 0 ] || exit "$STUB_FRONTEND_HTML_EXIT"
  printf '%s' "$STUB_FRONTEND_HTML"; exit 0
fi
echo '{}'; exit 0
STUB
chmod +x "$STUB_BIN/gh" "$STUB_BIN/curl"
cat > "$STUB_BIN/mountpoint" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-q" ] && [ "${2:-}" = "${SMOKE_GATE_SHARED_ROOT:-}" ]
STUB
chmod +x "$STUB_BIN/mountpoint"
REAL_JQ="$(command -v jq)"
export REAL_JQ
cat > "$STUB_BIN/jq" <<'STUB'
#!/usr/bin/env bash
# Narrowly model the jq 1.6 behavior behind the live failure: the ledger
# producer yields no bytes, then jq -e accepts the empty readback pipeline.
# Host jq 1.7 exits 4 on empty input, so both halves are needed for this
# regression to kill the old source outside the live container image.
if [ -n "${STUB_LEDGER_JQ_EMPTY_FILE:-}" ] &&
   printf '%s' "$*" | grep -qF 'targetSha:$target,freezeSha:$freeze,freezePr:$pr'; then
  printf 'attempt\n' >> "$STUB_LEDGER_JQ_EMPTY_FILE"
  exit 0
fi
if [ -n "${STUB_LEDGER_JQ_EMPTY_FILE:-}" ] &&
   printf '%s' "$*" | grep -qF '.runId == $run and .finishedAt == $now'; then
  STUB_JQ_INPUT="$(cat)"
  if [ -z "$STUB_JQ_INPUT" ]; then exit 0; fi
  printf '%s' "$STUB_JQ_INPUT" | "$REAL_JQ" "$@"
  exit $?
fi
exec "$REAL_JQ" "$@"
STUB
chmod +x "$STUB_BIN/jq"
export PATH="$STUB_BIN:$PATH"

reset_stubs() {
  unset STUB_PR_LIST STUB_PR_VIEW STUB_PR_FILES STUB_RUN_LIST STUB_RUN_LIST_EXIT STUB_PARENT_SHA \
        STUB_COMMIT_TREE STUB_BLOB_RESPONSE STUB_TREE_RESPONSE STUB_COMMIT_RESPONSE \
        STUB_REF_RESPONSE STUB_REF_EXIT STUB_BRANCH_EXISTS STUB_PR_LIST_EXIT \
        STUB_PR_FILES_EXIT STUB_PR_CREATE_EXIT STUB_NEW_PR_NUMBER STUB_SUSPEND_CODE \
        STUB_HEALTHZ_CODE STUB_SERVICES STUB_BACKEND_DEPLOYS STUB_FRONTEND_DEPLOYS \
        STUB_COMPARE_FILES STUB_COMPARE_EXIT STUB_LOCK_PROBE STUB_LOCK_PROBE_FILE \
        STUB_STATE_PROBE STUB_STATE_PROBE_FILE STUB_SUSPEND_SLEEP STUB_REPO_VIEW_EXIT \
        STUB_LEDGER_JQ_EMPTY_FILE STUB_SUSPEND_LOG \
        STUB_FRONTEND_HTML_EXIT STUB_FRONTEND_HTML STUB_BUNDLE_EXIT STUB_BUNDLE_JS \
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
expire_lease() { # <lease-file>; no writer is live in these test fixtures
  local lease_file="$1" tmp="${1}.expired"
  jq -c '.expiresAt="2000-01-01T00:00:00Z"' "$lease_file" > "$tmp"
  mv "$tmp" "$lease_file"
}

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
# gate blind to a NO_GO whose hold DID go up. A narrowly stubbed ledger-object
# jq returns success with no bytes and models jq 1.6 accepting the subsequent
# empty readback, which deterministically exercises the live bug on jq 1.7 too.
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
export STUB_LEDGER_JQ_EMPTY_FILE="$APPFAIL_DIR/empty-jq-attempts"
export SMOKE_GATE_PUBLISH_FILE="$APPFAIL_DIR/latest-verdict.json" \
  SMOKE_GATE_HOLD_FILE="$APPFAIL_DIR/develop-hold.json" \
  SMOKE_GATE_HANDOFF_LEDGER="$APPFAIL_LEDGER"
bash "$GATE" claim run-appfail 98 "$APPFAIL_HEAD" >/dev/null
APPFAIL_OUT="$(bash "$GATE" finish "$APPFAIL_HEAD" run-appfail NO_GO 2>/dev/null || true)"
unset STUB_LEDGER_JQ_EMPTY_FILE
jq -e --arg target "$APPFAIL_TARGET" '
  .ok == false and .leaseReleased == false and
  (.error | test("handoff-ledger.jsonl"))
' <<<"$APPFAIL_OUT" >/dev/null || {
  echo "an unwritten ledger line was reported as a successful handoff, got: $APPFAIL_OUT" >&2; exit 1; }
[ "$(wc -c < "$APPFAIL_LEDGER")" -eq 0 ]
[ "$(wc -l < "$APPFAIL_DIR/empty-jq-attempts")" -eq 2 ]
# The hold still went up — a ledger failure must never skip or undo it.
jq -e --arg sha "$APPFAIL_TARGET" '.sha == $sha and .runId == "run-appfail"' "$APPFAIL_DIR/develop-hold.json" >/dev/null
jq -e '.activeRunId == "run-appfail" and .completedSha == null' "$STATE_DIR/pr-98-state.json" >/dev/null
[ -s "$SMOKE_GATE_LEASE_DIR/lease-run-appfail.json" ]

# Exercise the reproduced filesystem failure too when permissions are
# enforceable. Root can append to mode 0400, so it runs the deterministic
# empty-output case above and skips only this permission-specific repetition.
if [ "$(id -u)" -ne 0 ]; then
  chmod 400 "$APPFAIL_LEDGER"
  APPFAIL_MODE_OUT="$(bash "$GATE" finish "$APPFAIL_HEAD" run-appfail NO_GO 2>/dev/null || true)"
  chmod 600 "$APPFAIL_LEDGER"
  jq -e '
    .ok == false and .leaseReleased == false and
    (.error | test("handoff-ledger.jsonl"))
  ' <<<"$APPFAIL_MODE_OUT" >/dev/null || {
    echo "mode-0400 ledger append failure was reported as success, got: $APPFAIL_MODE_OUT" >&2; exit 1; }
  [ "$(wc -c < "$APPFAIL_LEDGER")" -eq 0 ]
  jq -e '.activeRunId == "run-appfail" and .completedSha == null' "$STATE_DIR/pr-98-state.json" >/dev/null
  [ -s "$SMOKE_GATE_LEASE_DIR/lease-run-appfail.json" ]
fi

# Once storage is repaired, the same-run retry writes one receipt and only
# then completes the slot and releases shared ownership.
bash "$GATE" finish "$APPFAIL_HEAD" run-appfail NO_GO | jq -e '.ok == true and .leaseReleased == true' >/dev/null
tail -1 "$APPFAIL_LEDGER" | jq -e '.runId == "run-appfail"' >/dev/null
[ "$(wc -l < "$APPFAIL_LEDGER")" -eq 1 ]

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

# A run id is shared authority too: the same token cannot bind one live run id
# to different PRs merely because their private state roots cannot see each other.
RUN_STATE_A="$PR_BASE/run-state-a" RUN_STATE_B="$PR_BASE/run-state-b"
mkdir -p "$RUN_STATE_A" "$RUN_STATE_B"
SMOKE_GATE_STATE_DIR="$RUN_STATE_A" SMOKE_GATE_LEASE_DIR="$PR_COMMON_LEASE" \
  bash "$GATE" claim run-cross-pr 130 "$PR_BIND_SHA" shared-owner | jq -e '.ok == true' >/dev/null
RUN_COLLISION="$(SMOKE_GATE_STATE_DIR="$RUN_STATE_B" SMOKE_GATE_LEASE_DIR="$PR_COMMON_LEASE" \
  bash "$GATE" claim run-cross-pr 131 "$PR_BIND_SHA" shared-owner || true)"
jq -e '.ok == false and .leasePr == 130 and .requestedPr == 131 and (.error | test("permanently bound"))' <<<"$RUN_COLLISION" >/dev/null
jq -e '.pr == 130 and .owner == "shared-owner"' "$PR_COMMON_LEASE/lease-run-cross-pr.json" >/dev/null
[ ! -e "$PR_COMMON_LEASE/pr-131-authority.json" ] && [ ! -e "$RUN_STATE_B/pr-131-state.json" ]
SMOKE_GATE_STATE_DIR="$RUN_STATE_A" SMOKE_GATE_LEASE_DIR="$PR_COMMON_LEASE" \
  bash "$GATE" release run-cross-pr shared-owner | jq -e '.ok == true' >/dev/null

# Expiry permits a successor owner for the same PR, but never reassigns a run
# id to another PR and strands the original PR's authority pointer.
EXPIRED_PR_LEASE="$TEST_SHARED_ROOT/expired-cross-pr/leases"
SMOKE_GATE_STATE_DIR="$RUN_STATE_A" SMOKE_GATE_LEASE_DIR="$EXPIRED_PR_LEASE" SMOKE_GATE_LEASE_TTL_SECONDS=30 \
  bash "$GATE" claim run-expired-cross-pr 133 "$PR_BIND_SHA" owner-a | jq -e '.ok == true' >/dev/null
expire_lease "$EXPIRED_PR_LEASE/lease-run-expired-cross-pr.json"
RUN_COLLISION="$(SMOKE_GATE_STATE_DIR="$RUN_STATE_B" SMOKE_GATE_LEASE_DIR="$EXPIRED_PR_LEASE" SMOKE_GATE_LEASE_TTL_SECONDS=30 \
  bash "$GATE" claim run-expired-cross-pr 134 "$PR_BIND_SHA" owner-b || true)"
jq -e '.ok == false and .leasePr == 133 and .requestedPr == 134 and (.error | test("permanently bound"))' <<<"$RUN_COLLISION" >/dev/null
jq -e '.pr == 133 and .runId == "run-expired-cross-pr" and .owner == "owner-a"' \
  "$EXPIRED_PR_LEASE/pr-133-authority.json" >/dev/null
[ ! -e "$EXPIRED_PR_LEASE/pr-134-authority.json" ] && [ ! -e "$RUN_STATE_B/pr-134-state.json" ]
# Same-PR recovery under a successor is still allowed after expiry.
SMOKE_GATE_STATE_DIR="$RUN_STATE_A" SMOKE_GATE_LEASE_DIR="$EXPIRED_PR_LEASE" SMOKE_GATE_LEASE_TTL_SECONDS=30 \
  bash "$GATE" claim run-expired-cross-pr 133 "$PR_BIND_SHA" owner-b | jq -e '.ok == true and .lease.pr == 133 and .lease.owner == "owner-b"' >/dev/null
SMOKE_GATE_STATE_DIR="$RUN_STATE_A" SMOKE_GATE_LEASE_DIR="$EXPIRED_PR_LEASE" \
  bash "$GATE" release run-expired-cross-pr owner-b | jq -e '.ok == true' >/dev/null

# --- 28. stale owner A cannot act after B reclaims through another state root
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base SMOKE_GATE_LEASE_TTL_SECONDS=30
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
expire_lease "$COMMON_LEASE/lease-run-shared-owner.json"
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
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base SMOKE_GATE_LEASE_TTL_SECONDS=30
SAME_SHA="$(sha 6)"
SAME_CLAIM="$(bash "$GATE" claim run-same-state 121 "$SAME_SHA" owner-a || true)"
jq -e '.ok == true' <<<"$SAME_CLAIM" >/dev/null || { echo "initial same-state claim failed: $SAME_CLAIM" >&2; exit 1; }
expire_lease "$SMOKE_GATE_LEASE_DIR/lease-run-same-state.json"
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
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base SMOKE_GATE_LEASE_TTL_SECONDS=30
EXPIRED_SHA="$(sha b)"
bash "$GATE" claim run-expired-owner 127 "$EXPIRED_SHA" owner-a | jq -e '.ok == true' >/dev/null
expire_lease "$SMOKE_GATE_LEASE_DIR/lease-run-expired-owner.json"
for lease_verb in lease-renew lease-release; do
  OUT="$(bash "$GATE" "$lease_verb" run-expired-owner owner-a || true)"
  jq -e '.ok == false and (.error | test("expired")) and (.error | test("recover with claim"))' <<<"$OUT" >/dev/null
  [ -s "$SMOKE_GATE_LEASE_DIR/lease-run-expired-owner.json" ]
done
SMOKE_GATE_LEASE_TTL_SECONDS=30 bash "$GATE" claim run-expired-owner 127 "$EXPIRED_SHA" owner-a | jq -e '.ok == true' >/dev/null
jq -e '.pr == 127 and .runId == "run-expired-owner" and .owner == "owner-a"' "$SMOKE_GATE_LEASE_DIR/pr-127-authority.json" >/dev/null
bash "$GATE" release run-expired-owner owner-a | jq -e '.ok == true' >/dev/null

# Standalone lease-claim requires a PR for a new run id, while a same-owner
# renewal may infer and preserve the PR already bound into a valid live lease.
OUT="$(bash "$GATE" lease-claim run-standalone-new owner-a || true)"
jq -e '.ok == false and (.error | test("requires the PR number"))' <<<"$OUT" >/dev/null
for bad_pr in 0 007; do
  OUT="$(bash "$GATE" claim "run-bad-pr-$bad_pr" "$bad_pr" "$EXPIRED_SHA" owner-a || true)"
  jq -e '.ok == false and (.error | test("requires a PR number"))' <<<"$OUT" >/dev/null
  [ ! -e "$SMOKE_GATE_LEASE_DIR/lease-run-bad-pr-$bad_pr.json" ]
done
bash "$GATE" claim run-standalone-bound 132 "$EXPIRED_SHA" owner-a | jq -e '.ok == true' >/dev/null
STANDALONE_AUTH="$(cat "$SMOKE_GATE_LEASE_DIR/pr-132-authority.json")"
bash "$GATE" lease-claim run-standalone-bound owner-a | jq -e '.ok == true and .lease.pr == 132' >/dev/null
[ "$(cat "$SMOKE_GATE_LEASE_DIR/pr-132-authority.json")" = "$STANDALONE_AUTH" ]
bash "$GATE" release run-standalone-bound owner-a | jq -e '.ok == true' >/dev/null

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
# Syntactically valid JSON with an unparsable UTC timestamp is malformed too;
# it may not be treated as an expired lease available for overwrite.
printf '{"schemaVersion":1,"pr":122,"owner":"owner-a","claimedAt":"2026-09-07T00:00:00Z","renewedAt":"2026-09-07T00:00:00Z","expiresAt":"not-a-timestamp"}\n' \
  > "$SMOKE_GATE_LEASE_DIR/lease-run-bad-time.json"
BAD_TIME_BEFORE="$(cat "$SMOKE_GATE_LEASE_DIR/lease-run-bad-time.json")"
BAD="$(bash "$GATE" lease-status run-bad-time 2>/dev/null || true)"
jq -e '.ok == false and (.error | test("malformed"))' <<<"$BAD" >/dev/null
BAD="$(bash "$GATE" claim run-bad-time 122 "$BAD_SHA" owner-b 2>/dev/null || true)"
jq -e '.ok == false and (.error | test("malformed"))' <<<"$BAD" >/dev/null
[ "$(cat "$SMOKE_GATE_LEASE_DIR/lease-run-bad-time.json")" = "$BAD_TIME_BEFORE" ]
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
# Force the post-bind fence to miss once. Poll must restore the pre-claim
# absence instead of leaving a live owner token that no wake ever delivered.
ROLLBACK_POLL="$(SMOKE_GATE_LOCK_WAIT_SECONDS=1 \
  SMOKE_GATE_TEST_HOLD_RUN_LOCK_AFTER_BIND_SECONDS=1.5 bash "$GATE" poll)"
jq -e '.wakeAgent == false and .data.trigger == "coordinator_lease_unavailable"' <<<"$ROLLBACK_POLL" >/dev/null
[ ! -e "$SMOKE_GATE_LEASE_DIR/pr-126-authority.json" ]
[ "$(find "$SMOKE_GATE_LEASE_DIR" -maxdepth 1 -name 'lease-smoke-pr126-*.json' -type f | wc -l)" -eq 0 ]
# Readiness/debounce history may already exist, but no coordinator slot may.
jq -e '.activeRunId == null and .activeLeaseOwner == null' "$STATE_DIR/pr-126-state.json" >/dev/null
# With the transient lock gone, the next poll claims and delivers its token.
NEXT_POLL="$(bash "$GATE" poll || true)"
jq -e '.wakeAgent == true and .data.trigger == "pr_build_settled" and (.data.coordinatorOwnerToken | length > 0)' <<<"$NEXT_POLL" >/dev/null || {
  echo "poll after ownership rollback did not reacquire: $NEXT_POLL" >&2
  exit 1
}

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

# =============================================================================
# Campaign-size classification (mechanical, install-rules-driven, fail-closed)
# =============================================================================

# --- 23. No rules file at all: standard, backward compatible ---------------
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
export SMOKE_SIZING_RULES="$STATE_DIR/does-not-exist.json"
HEAD_SHA="$(sha 3)"
export STUB_PR_VIEW="{\"number\":300,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"frontend/a.css"}]'
bash "$GATE" check 300 | jq -e '
  .campaignSize == "standard" and .sizeReason == "no sizing rules"
' >/dev/null

RULES="$STATE_DIR/sizing.json"
cat > "$RULES" <<'JSON'
{"full":["backend/migrations/**"],"lightAllowed":["frontend/**"],"lightDeny":["frontend/auth/**"]}
JSON
export SMOKE_SIZING_RULES="$RULES"

# --- 24. UI-only PR: light --------------------------------------------------
export STUB_PR_FILES='[{"filename":"frontend/a.css"},{"filename":"frontend/sub/b.tsx"}]'
bash "$GATE" check 300 | jq -e '
  .campaignSize == "light" and (.sizeReason | startswith("light:"))
' >/dev/null

# --- 25. A UI file under lightDeny forces standard --------------------------
export STUB_PR_FILES='[{"filename":"frontend/auth/login.tsx"}]'
bash "$GATE" check 300 | jq -e '
  .campaignSize == "standard" and
  .sizeReason == "standard: frontend/auth/login.tsx matched frontend/auth/**"
' >/dev/null

# --- 26. One backend file under a `full` glob: full -------------------------
export STUB_PR_FILES='[{"filename":"backend/migrations/0099_add_col.sql"}]'
bash "$GATE" check 300 | jq -e '
  .campaignSize == "full" and
  .sizeReason == "full: backend/migrations/0099_add_col.sql matched backend/migrations/**"
' >/dev/null

# --- 27. Mixed UI + ordinary backend file (matches neither lightAllowed nor
# lightDeny): standard, never light just because most files were UI ---------
export STUB_PR_FILES='[{"filename":"frontend/a.css"},{"filename":"backend/service/handler.ts"}]'
bash "$GATE" check 300 | jq -e '
  .campaignSize == "standard" and
  .sizeReason == "standard: backend/service/handler.ts not matched by lightAllowed"
' >/dev/null

# --- 27a. A rename out of a `full` path is sized off BOTH paths: previous
# path matches `full`, new path matches `lightAllowed` -- must still be full.
export STUB_PR_FILES='[{"filename":"frontend/moved.tsx","previous_filename":"backend/migrations/1_x.sql","status":"renamed"}]'
bash "$GATE" check 300 | jq -e '
  .campaignSize == "full" and
  .sizeReason == "full: backend/migrations/1_x.sql matched backend/migrations/**"
' >/dev/null

# --- 28. Own-diff fetch failure: fails closed to full, independent of rules -
export STUB_PR_FILES_EXIT=1
bash "$GATE" check 300 | jq -e '
  .campaignSize == "full" and .sizeReason == "full: the PR file list could not be fetched"
' >/dev/null
export STUB_PR_FILES_EXIT=0

# --- 29. >=100 changed files: truncated listing fails closed to full -------
export STUB_PR_FILES="$(python3 -c 'import json; print(json.dumps([{"filename": f"backend/f{i}.ts"} for i in range(100)]))')"
bash "$GATE" check 300 | jq -e '
  .campaignSize == "full" and .sizeReason == "full: the PR file list is truncated (>=100 files)"
' >/dev/null

# --- 30. Freeze PR: sized from the develop-compare target diff, never the
# freeze PR's own two-marker diff (same MG-1 rule migrationsTouched follows).
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
export SMOKE_SIZING_RULES="$RULES"
PARENT_SHA="$(sha e)"
FREEZE_SHA="$(sha f)"
export STUB_PR_VIEW="{\"number\":301,\"state\":\"OPEN\",\"isDraft\":true,\"headRefOid\":\"$FREEZE_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/.render-freeze"},{"filename":"XZO-FRONTEND/.render-freeze"}]'
export STUB_PARENT_SHA="$PARENT_SHA"
export STUB_COMPARE_FILES='{"status":"ahead","files":[{"filename":"backend/migrations/1_x.sql"}]}'
export STUB_RUN_LIST="[{\"headSha\":\"$PARENT_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"pr-title-check\"}]"
bash "$GATE" check 301 | jq -e '
  .isFreezePr == true and .campaignSize == "full" and
  .sizeReason == "full: backend/migrations/1_x.sql matched backend/migrations/**"
' >/dev/null
unset STUB_PARENT_SHA STUB_COMPARE_FILES SMOKE_SIZING_RULES

# =============================================================================
# #1536 / #1603 — preview-identity disambiguation and the post-finish warm-up
# false alarm. Render has twice provisioned two services sharing one display
# name under the same parent (PR #1533, PR #1637); the gate used to take
# whichever the API listed first. These fixtures pin: candidate enumeration,
# bundle-based backend disambiguation, unconditional refusal (never a guess)
# when disambiguation cannot resolve to exactly one candidate, the frontend
# evidence-gap field, the SAME resolution at the mutating `finish`/suspend
# site, and that a preview this gate itself suspended after finishing never
# re-alarms as a stuck warm-up.

# --- 33. Backend disambiguated via the served frontend bundle: exactly one
# candidate's host is referenced, so it is preferred over the other and
# settling proceeds normally — no ambiguity recorded.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
D_SHA="$(sha 2)"
export STUB_PR_VIEW="{\"number\":80,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$D_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$D_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[\
{\"id\":\"srv-frontend-pr-80\",\"name\":\"XZO-DEV-FRONTEND PR #80\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-frontend-base\"},\"url\":\"https://xzo-dev-frontend-pr-80.onrender.com\"}},\
{\"id\":\"srv-backend-pr-80-a\",\"name\":\"XZO-DEV-BACKEND PR #80\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-80-a.onrender.com\"}},\
{\"id\":\"srv-backend-pr-80-b\",\"name\":\"XZO-DEV-BACKEND PR #80\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-80-b.onrender.com\"}}]"
export STUB_FRONTEND_HTML='<html><body><script type="module" src="/assets/index-Cg8w-v89.js"></script></body></html>'
export STUB_BUNDLE_JS='fetch("https://xzo-dev-backend-pr-80-b.onrender.com/api")'
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$D_SHA\"}}]"
export STUB_FRONTEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$D_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
D_CHECK="$(bash "$GATE" check 80)"
jq -e '
  .previewAmbiguous == false and .previewAmbiguityReason == null and
  .backendSelectionMethod == "bundle-disambiguated" and
  .backendPreviewId == "srv-backend-pr-80-b" and
  .backendPreviewUrl == "https://xzo-dev-backend-pr-80-b.onrender.com" and
  (.backendCandidates | length) == 2 and
  .frontendEvidenceGap == false and .settled == true
' <<<"$D_CHECK" >/dev/null || { echo "33: bundle disambiguation did not prefer the referenced host: $D_CHECK" >&2; exit 1; }

# --- 34. Backend still ambiguous: the served bundle references NEITHER
# candidate host. Refused, not guessed — no id/url selected, fetchOk false so
# the stall is loud (routes through the existing facts-stuck alarm) rather
# than silently retried forever, and the reason names both candidates.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
N_SHA="$(sha 3)"
export STUB_PR_VIEW="{\"number\":81,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$N_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$N_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[\
{\"id\":\"srv-frontend-pr-81\",\"name\":\"XZO-DEV-FRONTEND PR #81\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-frontend-base\"},\"url\":\"https://xzo-dev-frontend-pr-81.onrender.com\"}},\
{\"id\":\"srv-backend-pr-81-a\",\"name\":\"XZO-DEV-BACKEND PR #81\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-81-a.onrender.com\"}},\
{\"id\":\"srv-backend-pr-81-b\",\"name\":\"XZO-DEV-BACKEND PR #81\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-81-b.onrender.com\"}}]"
export STUB_FRONTEND_HTML='<html><body><script type="module" src="/assets/index-Cg8w-v89.js"></script></body></html>'
export STUB_BUNDLE_JS='fetch("/api/local")'
N_ERR="$STATE_DIR/n-check-stderr.txt"
N_CHECK="$(bash "$GATE" check 81 2>"$N_ERR")"
jq -e '
  .previewAmbiguous == true and .backendSelectionMethod == "ambiguous" and
  (.previewAmbiguityReason | test("PR #81")) and
  (.previewAmbiguityReason | test("srv-backend-pr-81-a")) and
  (.previewAmbiguityReason | test("srv-backend-pr-81-b")) and
  (.previewAmbiguityReason | test("none of the candidate backend hosts")) and
  .backendPreviewId == null and .backendPreviewUrl == null and
  .backendReady == false and .settled == false and .fetchOk == false
' <<<"$N_CHECK" >/dev/null || { echo "34: bundle-referencing-neither did not refuse: $N_CHECK" >&2; exit 1; }
grep -qF 'srv-backend-pr-81-a' "$N_ERR" || { echo "34: refusal was not reported on stderr" >&2; cat "$N_ERR" >&2; exit 1; }
# ...and this stall is LOUD: with the facts-stall window at zero, it alarms as
# pr_facts_unavailable rather than silently retrying forever. Two calls, same
# shape as test 17 above: the first records factsStuckSince (no alarm — the
# window has not elapsed by wall-clock yet), the second's elapsed-time check
# (NOW_EPOCH - factsStuckSince >= 0) is then measured strictly after that
# timestamp was written, never racing it within one invocation.
export STUB_PR_LIST="[{\"number\":81,\"headRefOid\":\"$N_SHA\",\"headRefName\":\"feature/x\"}]"
SMOKE_GATE_FACTS_STUCK_SECONDS=3600 bash "$GATE" poll 2>/dev/null | jq -e '.wakeAgent == false' >/dev/null \
  || { echo "34-poll: expected the first stall to be silent (inside the window)" >&2; exit 1; }
SMOKE_GATE_FACTS_STUCK_SECONDS=0 bash "$GATE" poll 2>/dev/null | jq -e '
  .wakeAgent == true and .data.trigger == "pr_facts_unavailable" and .data.pr == 81
' >/dev/null || { echo "34-poll: ambiguity did not surface as an alarm" >&2; exit 1; }

# --- 35. Backend ambiguous with NO frontend preview to disambiguate against —
# the frontend evidence gap and the backend ambiguity are BOTH recorded, and
# the reason names the missing oracle rather than silently doing nothing.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
G_SHA="$(sha 4)"
export STUB_PR_VIEW="{\"number\":82,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$G_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$G_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[\
{\"id\":\"srv-backend-pr-82-a\",\"name\":\"XZO-DEV-BACKEND PR #82\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-82-a.onrender.com\"}},\
{\"id\":\"srv-backend-pr-82-b\",\"name\":\"XZO-DEV-BACKEND PR #82\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-82-b.onrender.com\"}}]"
G_CHECK="$(bash "$GATE" check 82 2>/dev/null)"
jq -e '
  .previewAmbiguous == true and
  (.previewAmbiguityReason | test("no healthy frontend preview URL")) and
  .frontendEvidenceGap == true and .frontendPreviewUrl == null and
  .backendPreviewId == null and .settled == false
' <<<"$G_CHECK" >/dev/null || { echo "35: missing-oracle case did not record both gaps: $G_CHECK" >&2; exit 1; }

# --- 36. Frontend evidence gap on an ordinary backend-only PR: a single,
# unambiguous backend still settles normally, but the ABSENCE of any frontend
# preview for this PR is now stated explicitly rather than left to be
# inferred from "not required".
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
E_SHA="$(sha 5)"
export STUB_PR_VIEW="{\"number\":83,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$E_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$E_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-83\",\"name\":\"XZO-DEV-BACKEND PR #83\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-83.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$E_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
E_CHECK="$(bash "$GATE" check 83 2>/dev/null)"
jq -e '
  .frontendRequired == false and .frontendEvidenceGap == true and
  .frontendPreviewUrl == null and .previewAmbiguous == false and
  .backendSelectionMethod == "single" and .settled == true and .fetchOk == true
' <<<"$E_CHECK" >/dev/null || { echo "36: backend-only PR did not record the frontend evidence gap: $E_CHECK" >&2; exit 1; }

# --- 37. THE mutating site: `finish` refuses to suspend an ambiguous backend
# (same bundle-oracle resolution as evaluate_pr, applied at the suspend call
# site). No suspend POST is issued at all, the reason is written into the
# durable verdict receipt, and finish still completes rather than stranding
# the run.
fresh_state
F_SHA="$(sha 6)"
export STUB_SUSPEND_LOG="$STATE_DIR/suspend-posts-37.log"
: > "$STUB_SUSPEND_LOG"
bash "$GATE" claim run-amb-finish 84 "$F_SHA" >/dev/null
export STUB_SERVICES="[\
{\"id\":\"srv-frontend-pr-84\",\"name\":\"XZO-DEV-FRONTEND PR #84\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-frontend-base\"},\"url\":\"https://xzo-dev-frontend-pr-84.onrender.com\"}},\
{\"id\":\"srv-backend-pr-84-a\",\"name\":\"XZO-DEV-BACKEND PR #84\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-84-a.onrender.com\"}},\
{\"id\":\"srv-backend-pr-84-b\",\"name\":\"XZO-DEV-BACKEND PR #84\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-84-b.onrender.com\"}}]"
export STUB_FRONTEND_HTML='<html><body>no module script here</body></html>'
export STUB_SUSPEND_CODE=202
F_ERR="$STATE_DIR/f-finish-stderr.txt"
bash "$GATE" finish "$F_SHA" run-amb-finish GO 2>"$F_ERR" | jq -e --arg sha "$F_SHA" '
  .ok == true and .verdict == "GO" and .pr == 84 and .sha == $sha and
  .suspend.attempted == false and .suspend.ok == false and
  .suspend.httpStatus == null and
  (.suspend.reason | test("PR #84")) and
  (.suspend.reason | test("srv-backend-pr-84-a")) and
  (.suspend.reason | test("srv-backend-pr-84-b")) and
  (.suspend.reason | test("could not extract a JS bundle path"))
' >/dev/null || { echo "37: finish did not refuse the ambiguous suspend" >&2; exit 1; }
[ ! -s "$STUB_SUSPEND_LOG" ] || { echo "37: a suspend POST was issued against an ambiguous preview:" >&2; cat "$STUB_SUSPEND_LOG" >&2; exit 1; }
jq -e '.suspend.attempted == false and (.suspend.reason | test("srv-backend-pr-84-a"))' \
  "$STATE_DIR/pr-84-verdict.json" >/dev/null \
  || { echo "37: the durable verdict receipt did not record the refusal" >&2; exit 1; }
jq -e --arg sha "$F_SHA" '.completedSha == $sha and .activeSha == null' "$STATE_DIR/pr-84-state.json" >/dev/null \
  || { echo "37: the refusal stranded the run instead of completing it" >&2; exit 1; }
grep -qF 'srv-backend-pr-84-a' "$F_ERR" || { echo "37: suspend refusal was not reported on stderr" >&2; cat "$F_ERR" >&2; exit 1; }

# --- 38. THE mutating site, positive case: `finish` disambiguates via the
# bundle and suspends the CORRECT twin — a real POST hits the wire, targeting
# the candidate the served frontend actually calls, not whichever the API
# happened to list first.
fresh_state
S_SHA="$(sha 7)"
export STUB_SUSPEND_LOG="$STATE_DIR/suspend-posts-38.log"
: > "$STUB_SUSPEND_LOG"
bash "$GATE" claim run-disambig-finish 85 "$S_SHA" >/dev/null
export STUB_SERVICES="[\
{\"id\":\"srv-frontend-pr-85\",\"name\":\"XZO-DEV-FRONTEND PR #85\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-frontend-base\"},\"url\":\"https://xzo-dev-frontend-pr-85.onrender.com\"}},\
{\"id\":\"srv-backend-pr-85-a\",\"name\":\"XZO-DEV-BACKEND PR #85\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-85-a.onrender.com\"}},\
{\"id\":\"srv-backend-pr-85-b\",\"name\":\"XZO-DEV-BACKEND PR #85\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-85-b.onrender.com\"}}]"
export STUB_FRONTEND_HTML='<html><body><script type="module" src="/assets/index-Dw8AA3y4.js"></script></body></html>'
export STUB_BUNDLE_JS='fetch("https://xzo-dev-backend-pr-85-a.onrender.com/api")'
export STUB_SUSPEND_CODE=202
bash "$GATE" finish "$S_SHA" run-disambig-finish GO | jq -e '
  .ok == true and .suspend.attempted == true and .suspend.ok == true and
  .suspend.httpStatus == 202 and .suspend.reason == null
' >/dev/null || { echo "38: bundle-disambiguated finish did not suspend" >&2; exit 1; }
[ "$(wc -l < "$STUB_SUSPEND_LOG")" -eq 1 ] || { echo "38: expected exactly one suspend POST, got $(wc -l < "$STUB_SUSPEND_LOG")" >&2; exit 1; }
grep -qF 'srv-backend-pr-85-a/suspend' "$STUB_SUSPEND_LOG" \
  || { echo "38: the suspend POST did not target the bundle-referenced twin:" >&2; cat "$STUB_SUSPEND_LOG" >&2; exit 1; }

# --- 39. #1603: a preview THIS GATE ITSELF SUSPENDED after finishing never
# re-alarms as pr_warmup_stuck. Real completedSha==headSha state, produced by
# an actual finish call (not hand-crafted), then a poll cycle whose facts show
# backendReady:true (deploy sha still matches) and healthzReady:false (503
# Service Suspended — by design). Four consecutive campaigns (#1560, #1600,
# #1617, #1644) burned a wake and a container spawn each on exactly this.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
W_SHA="$(sha 8)"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-86\",\"name\":\"XZO-DEV-BACKEND PR #86\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-86.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$W_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
bash "$GATE" claim run-warmup-finish 86 "$W_SHA" >/dev/null
export STUB_SUSPEND_CODE=202
bash "$GATE" finish "$W_SHA" run-warmup-finish GO | jq -e '.ok == true and .suspend.ok == true' >/dev/null \
  || { echo "39: setup finish call failed" >&2; exit 1; }
jq -e --arg sha "$W_SHA" '.completedSha == $sha and .activeRunId == null' "$STATE_DIR/pr-86-state.json" >/dev/null \
  || { echo "39: setup did not leave the expected completed state" >&2; exit 1; }
# The suspended preview now 503s. Same headSha, same STUB_PR_FILES/RUN_LIST
# (evaluate_pr re-fetches them fresh every poll) as a plain settled PR would
# use, but healthz now reports the suspension.
export STUB_PR_FILES='[{"filename":"XZO-BACKEND/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$W_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_HEALTHZ_CODE=503
export STUB_PR_LIST="[{\"number\":86,\"headRefOid\":\"$W_SHA\",\"headRefName\":\"feature/x\"}]"
# First poll: records deployLiveSince (freshly, as "now") — same reason test
# 34-poll above needs two calls, so the warm-up window has actually elapsed
# by wall-clock before the second poll checks it, rather than racing within
# one invocation.
bash "$GATE" poll >/dev/null
SMOKE_GATE_WARMUP_TIMEOUT=0 bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger != "pr_warmup_stuck"' >/dev/null \
  || { echo "39: a gate-suspended preview re-alarmed as pr_warmup_stuck" >&2; exit 1; }

# --- 31. Glob-translation unit cases: **, {a,b}, and a single * that does not
# cross `/`. Exercised directly against campaign-size-classify.py so a glob
# regression is caught even if no gate-level scenario happens to hit it.
CLASSIFY="$SCRIPT_DIR/campaign-size-classify.py"
GLOB_RULES="$STATE_DIR/glob-rules.json"
cat > "$GLOB_RULES" <<'JSON'
{"full":["backend/migrations/**"],"lightAllowed":["frontend/**/*.{css,tsx}"],"lightDeny":[]}
JSON
# `**` crosses directories: a nested migration file still matches `backend/migrations/**`.
echo '["backend/migrations/nested/deep/2_y.sql"]' | python3 "$CLASSIFY" "$GLOB_RULES" | jq -e '
  .campaignSize == "full"
' >/dev/null
# `{a,b}` alternation: both extensions in the brace group are individually allowed.
echo '["frontend/a.css","frontend/sub/b.tsx"]' | python3 "$CLASSIFY" "$GLOB_RULES" | jq -e '
  .campaignSize == "light"
' >/dev/null
# a bare `*` does not cross `/`: `frontend/*.css` must not match a file one
# directory deeper.
STAR_RULES="$STATE_DIR/star-rules.json"
cat > "$STAR_RULES" <<'JSON'
{"full":[],"lightAllowed":["frontend/*.css"],"lightDeny":[]}
JSON
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$STAR_RULES" | jq -e '.campaignSize == "light"' >/dev/null
echo '["frontend/sub/a.css"]' | python3 "$CLASSIFY" "$STAR_RULES" | jq -e '
  .campaignSize == "standard" and .sizeReason == "standard: frontend/sub/a.css not matched by lightAllowed"
' >/dev/null

# --- 32. `fullGlobsFrom`: read the named constant out of the install's own
# release-policy file via ast.literal_eval, instead of keeping a second copy
# of its sensitive-path list in the rules file -- and instead of importing
# the file as a module, which would execute it. Every failure mode here
# (unreadable file, unparseable file, absent variable, a non-literal value,
# or a mistyped value) fails closed to `full` -- exercised directly against
# campaign-size-classify.py, same as the glob unit cases above.
POLICY_MOD="$STATE_DIR/policy.py"
cat > "$POLICY_MOD" <<'PY'
SENSITIVE_GLOBS = ["backend/permissions/**", "backend/billing/**"]
PY

FGF_RULES="$STATE_DIR/fgf-rules.json"
cat > "$FGF_RULES" <<JSON
{"full":[],"lightAllowed":["frontend/**"],"lightDeny":[],
 "fullGlobsFrom":{"path":"$POLICY_MOD","name":"SENSITIVE_GLOBS"}}
JSON
# A file matching the imported policy's own glob: full.
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$FGF_RULES" | jq -e '
  .campaignSize == "full" and
  .sizeReason == "full: backend/billing/charge.ts matched backend/billing/**"
' >/dev/null
# No match against the imported globs: falls through to the ordinary
# light/standard rules exactly as if fullGlobsFrom were absent.
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$FGF_RULES" | jq -e '
  .campaignSize == "light"
' >/dev/null

# A policy file whose first line imports a module that doesn't exist still
# classifies correctly off its globs -- proof the file is read as data (ast),
# never executed as code.
NOEXEC_MOD="$STATE_DIR/policy-noexec.py"
cat > "$NOEXEC_MOD" <<'PY'
import module_that_does_not_exist_anywhere
SENSITIVE_GLOBS = ["backend/permissions/**", "backend/billing/**"]
PY
FGF_NOEXEC="$STATE_DIR/fgf-noexec.json"
cat > "$FGF_NOEXEC" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$NOEXEC_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$FGF_NOEXEC" | jq -e '
  .campaignSize == "full" and
  .sizeReason == "full: backend/billing/charge.ts matched backend/billing/**"
' >/dev/null

# A computed value (not a literal): fails closed to full, reason says so.
COMPUTED_MOD="$STATE_DIR/policy-computed.py"
cat > "$COMPUTED_MOD" <<'PY'
BASE = ["backend/permissions/**"]
EXTRA = ["backend/billing/**"]
SENSITIVE_GLOBS = BASE + EXTRA
PY
FGF_COMPUTED="$STATE_DIR/fgf-computed.json"
cat > "$FGF_COMPUTED" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$COMPUTED_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$FGF_COMPUTED" | jq -e '
  .campaignSize == "full" and (.sizeReason | test("is not a literal"))
' >/dev/null

# An unparseable file: fails closed to full.
UNPARSEABLE_MOD="$STATE_DIR/policy-unparseable.py"
cat > "$UNPARSEABLE_MOD" <<'PY'
SENSITIVE_GLOBS = [
PY
FGF_UNPARSEABLE="$STATE_DIR/fgf-unparseable.json"
cat > "$FGF_UNPARSEABLE" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$UNPARSEABLE_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$FGF_UNPARSEABLE" | jq -e '
  .campaignSize == "full" and (.sizeReason | test("could not be parsed"))
' >/dev/null

# Unreadable file (does not exist): fails closed to full, names the path.
FGF_MISSING="$STATE_DIR/fgf-missing.json"
cat > "$FGF_MISSING" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$STATE_DIR/does-not-exist.py","name":"X"}}
JSON
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$FGF_MISSING" | jq -e '
  .campaignSize == "full" and (.sizeReason | startswith("full: fullGlobsFrom.path"))
' >/dev/null

# Wrong type (a string instead of a list): fails closed to full.
BAD_TYPE_MOD="$STATE_DIR/policy-bad-type.py"
cat > "$BAD_TYPE_MOD" <<'PY'
SENSITIVE_GLOBS = "backend/permissions/**"
PY
FGF_BADTYPE="$STATE_DIR/fgf-badtype.json"
cat > "$FGF_BADTYPE" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$BAD_TYPE_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$FGF_BADTYPE" | jq -e '
  .campaignSize == "full" and (.sizeReason | test("is not a list of strings"))
' >/dev/null

# Absent variable: fails closed to full.
FGF_MISSINGVAR="$STATE_DIR/fgf-missingvar.json"
cat > "$FGF_MISSINGVAR" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$POLICY_MOD","name":"NOT_THERE"}}
JSON
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$FGF_MISSINGVAR" | jq -e '
  .campaignSize == "full" and (.sizeReason | test("not found at top level in"))
' >/dev/null

# Local `full` globs and imported globs are unioned, not one replacing the
# other -- a file matching either must classify full.
FGF_UNION="$STATE_DIR/fgf-union.json"
cat > "$FGF_UNION" <<JSON
{"full":["frontend/auth/**"],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$POLICY_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["frontend/auth/login.tsx"]' | python3 "$CLASSIFY" "$FGF_UNION" | jq -e '
  .campaignSize == "full" and (.sizeReason | test("matched frontend/auth"))
' >/dev/null
echo '["backend/permissions/roles.ts"]' | python3 "$CLASSIFY" "$FGF_UNION" | jq -e '
  .campaignSize == "full" and (.sizeReason | test("matched backend/permissions"))
' >/dev/null

echo "smoke pr gate tests passed"
