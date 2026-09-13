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
  .data.campaignSize == "standard" and .data.sizeReason == "no sizing rules" and
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

# --- 3d. Settle payload carries campaignSize/sizeReason through for a LIGHT
# PR — the coordinator's run record for pr1792 read no campaignSize at all
# because this field never rode the pr_build_settled wake, even though the
# gate computed it into $facts; regression for that gap.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
SIZE_RULES="$STATE_DIR/sizing-3d.json"
cat > "$SIZE_RULES" <<'JSON'
{"full":["backend/migrations/**"],"lightAllowed":["frontend/**"],"lightDeny":["frontend/auth/**"]}
JSON
export SMOKE_SIZING_RULES="$SIZE_RULES"
HEAD_SHA="$(sha f)"
export STUB_PR_LIST="[{\"number\":46,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\"}]"
export STUB_PR_VIEW="{\"number\":46,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"frontend/a.css"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$HEAD_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-46\",\"name\":\"XZO-DEV-BACKEND PR #46\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-46.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$HEAD_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
CHECK_OUT="$(bash "$GATE" check 46)"
CHECK_SIZE="$(jq -r '.campaignSize' <<<"$CHECK_OUT")"
CHECK_REASON="$(jq -r '.sizeReason' <<<"$CHECK_OUT")"
[ "$CHECK_SIZE" = "light" ] || { echo "3d setup: expected the fixture itself to classify light, got $CHECK_SIZE" >&2; exit 1; }
POLL_OUT="$(bash "$GATE" poll)"
jq -e --arg size "$CHECK_SIZE" --arg reason "$CHECK_REASON" '
  .wakeAgent == true and .data.trigger == "pr_build_settled" and
  .data.campaignSize == $size and .data.sizeReason == $reason and
  .data.campaignSize == "light" and (.data.sizeReason | startswith("light:"))
' <<<"$POLL_OUT" >/dev/null \
  || { echo "3d: light campaignSize/sizeReason did not ride the settled wake: $POLL_OUT" >&2; exit 1; }
unset SMOKE_SIZING_RULES

# --- 3e. Same, for a FULL PR — the migrations-touching case, where campaign
# size matters most (this is exactly the sizing signal a coordinator needs to
# scale up review, not just the light-sizing happy path above).
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
SIZE_RULES="$STATE_DIR/sizing-3e.json"
cat > "$SIZE_RULES" <<'JSON'
{"full":["backend/migrations/**"],"lightAllowed":["frontend/**"],"lightDeny":["frontend/auth/**"]}
JSON
export SMOKE_SIZING_RULES="$SIZE_RULES"
HEAD_SHA="$(sha 9)"
export STUB_PR_LIST="[{\"number\":47,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\"}]"
export STUB_PR_VIEW="{\"number\":47,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"backend/migrations/0100_add_col.sql"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$HEAD_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[{\"id\":\"srv-backend-pr-47\",\"name\":\"XZO-DEV-BACKEND PR #47\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://xzo-dev-backend-pr-47.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$HEAD_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
CHECK_OUT="$(bash "$GATE" check 47)"
CHECK_SIZE="$(jq -r '.campaignSize' <<<"$CHECK_OUT")"
CHECK_REASON="$(jq -r '.sizeReason' <<<"$CHECK_OUT")"
[ "$CHECK_SIZE" = "full" ] || { echo "3e setup: expected the fixture itself to classify full, got $CHECK_SIZE" >&2; exit 1; }
POLL_OUT="$(bash "$GATE" poll)"
jq -e --arg size "$CHECK_SIZE" --arg reason "$CHECK_REASON" '
  .wakeAgent == true and .data.trigger == "pr_build_settled" and
  .data.campaignSize == $size and .data.sizeReason == $reason and
  .data.campaignSize == "full" and
  (.data.sizeReason | test("backend/migrations/0100_add_col.sql matched backend/migrations/\\*\\*"))
' <<<"$POLL_OUT" >/dev/null \
  || { echo "3e: full campaignSize/sizeReason did not ride the settled wake: $POLL_OUT" >&2; exit 1; }
unset SMOKE_SIZING_RULES

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
# Campaign-size classifier: present-but-broken sizing rules must fail closed,
# never collapse into "no sizing rules" (shadow-review #721). The caller's
# guard (smoke-pr-gate.sh:1221-1226) treats a non-zero classifier exit, or a
# stdout reply that isn't {campaignSize: string, sizeReason: string}, as
# "the classifier failed" and forces campaignSize=full -- so the fix is a
# non-zero exit with nothing meaningful on stdout, not a specific JSON shape.
# =============================================================================
fresh_state
CLASSIFY="$SCRIPT_DIR/campaign-size-classify.py"

# A directory in place of a file is unreadable regardless of container uid --
# deterministic across environments, unlike chmod 000 under root.
# NOTE: each check below uses `if OUT=$(...); then FAIL; fi` rather than a
# bare `OUT=$(...); CODE=$?` -- under this file's `set -e -o pipefail`, a bare
# assignment from a failing command substitution would abort the whole test
# script before the next line could inspect $?; putting it in the `if`
# condition is the standard exemption from errexit.
DIR_AS_RULES="$STATE_DIR/rules-is-a-dir.json"
mkdir -p "$DIR_AS_RULES"
if OUT="$(echo '[]' | python3 "$CLASSIFY" "$DIR_AS_RULES" 2>/dev/null)"; then
  echo "721: unreadable (directory) rules file exited 0 (stdout: $OUT)" >&2
  exit 1
fi
[ -z "$OUT" ] || { echo "721: unreadable rules file printed stdout instead of failing closed" >&2; exit 1; }

# Invalid JSON must fail closed, not read as "no sizing rules".
BAD_JSON_RULES="$STATE_DIR/bad-json-rules.json"
printf '{ not valid json' > "$BAD_JSON_RULES"
if OUT="$(echo '[]' | python3 "$CLASSIFY" "$BAD_JSON_RULES" 2>/dev/null)"; then
  echo "721: invalid-JSON rules file exited 0 (stdout: $OUT)" >&2
  exit 1
fi
[ -z "$OUT" ] || { echo "721: invalid-JSON rules file printed stdout instead of failing closed" >&2; exit 1; }

# A YAML document is not valid JSON -- same malformed-file direction, a
# different concrete shape of "the file parses as something, just not JSON".
YAML_RULES="$STATE_DIR/yaml-rules.yaml"
cat > "$YAML_RULES" <<'YAML'
full:
  - backend/migrations/**
YAML
if OUT="$(echo '[]' | python3 "$CLASSIFY" "$YAML_RULES" 2>/dev/null)"; then
  echo "721: YAML rules file exited 0 (stdout: $OUT)" >&2
  exit 1
fi
[ -z "$OUT" ] || { echo "721: YAML rules file printed stdout instead of failing closed" >&2; exit 1; }

# Valid JSON that isn't an object (a bare array) must fail closed too.
ARRAY_RULES="$STATE_DIR/array-rules.json"
echo '["full"]' > "$ARRAY_RULES"
if OUT="$(echo '[]' | python3 "$CLASSIFY" "$ARRAY_RULES" 2>/dev/null)"; then
  echo "721: non-dict rules document exited 0 (stdout: $OUT)" >&2
  exit 1
fi
[ -z "$OUT" ] || { echo "721: non-dict rules document printed stdout instead of failing closed" >&2; exit 1; }

# An ABSENT file is still the backward-compatible "no sizing rules" case,
# exit 0 -- must not regress alongside the above.
ABSENT_RULES="$STATE_DIR/absent-rules.json"
echo '[]' | python3 "$CLASSIFY" "$ABSENT_RULES" | jq -e '
  .campaignSize == "standard" and .sizeReason == "no sizing rules"
' >/dev/null

# End-to-end: the gate's own fail-closed guard (smoke-pr-gate.sh:1221-1226)
# fires off the classifier's non-zero exit for a present-but-malformed file,
# the same way it already does for a classifier crash.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
export SMOKE_SIZING_RULES="$STATE_DIR/bad-json-rules.json"
printf '{ not valid json' > "$SMOKE_SIZING_RULES"
HEAD_SHA="$(sha 9)"
export STUB_PR_VIEW="{\"number\":302,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$HEAD_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"frontend/a.css"}]'
bash "$GATE" check 302 | jq -e '
  .campaignSize == "full" and .sizeReason == "full: campaign size classifier failed"
' >/dev/null
unset SMOKE_SIZING_RULES

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

# --- 36b. #725: frontend ambiguity is RECORDED whether or not the frontend is
# required. A backend-only PR with two same-named frontend twins used to report
# previewAmbiguous:false and a null reason — the same facts as "the frontend
# preview is not created yet". It still settles on its backend (a frontend
# duplicate it never needed resolved does not hold it), but the refusal is
# stated and names both twins. The same twins on a PR that DOES require the
# frontend still block it, with fetchOk false.
fresh_state
export SMOKE_GATE_REPO=org/repo SMOKE_GATE_BACKEND_SERVICE=srv-backend-base \
  SMOKE_GATE_FRONTEND_SERVICE=srv-frontend-base
F_SHA="$(sha 6)"
# The one fixture path that must match the gate's hardcoded frontend prefix is
# built from the gate's own FRONTEND_PREFIX constant rather than restated here.
F_FRONTEND_PREFIX="$(sed -n 's/^FRONTEND_PREFIX="\(.*\)"$/\1/p' "$GATE")"
[ -n "$F_FRONTEND_PREFIX" ] || { echo "36b: could not read FRONTEND_PREFIX from the gate" >&2; exit 1; }
export STUB_PR_VIEW="{\"number\":84,\"state\":\"OPEN\",\"isDraft\":false,\"headRefOid\":\"$F_SHA\",\"headRefName\":\"feature/x\",\"baseRefName\":\"develop\",\"labels\":[{\"name\":\"render-preview\"}]}"
export STUB_PR_FILES='[{"filename":"backend/src/foo.ts"}]'
export STUB_RUN_LIST="[{\"headSha\":\"$F_SHA\",\"status\":\"completed\",\"conclusion\":\"success\",\"workflowName\":\"CI\"}]"
export STUB_SERVICES="[\
{\"id\":\"srv-frontend-pr-84-a\",\"name\":\"preview-frontend PR #84\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-frontend-base\"},\"url\":\"https://preview-frontend-pr-84-a.onrender.com\"}},\
{\"id\":\"srv-frontend-pr-84-b\",\"name\":\"preview-frontend PR #84\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-frontend-base\"},\"url\":\"https://preview-frontend-pr-84-b.onrender.com\"}},\
{\"id\":\"srv-backend-pr-84\",\"name\":\"preview-backend PR #84\",\"serviceDetails\":{\"parentServer\":{\"id\":\"srv-backend-base\"},\"url\":\"https://preview-backend-pr-84.onrender.com\"}}]"
export STUB_BACKEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$F_SHA\"}}]"
export STUB_FRONTEND_DEPLOYS="[{\"status\":\"live\",\"commit\":{\"id\":\"$F_SHA\"}}]"
export STUB_HEALTHZ_CODE=200
F_ERR="$STATE_DIR/f-check-stderr.txt"
F_CHECK="$(bash "$GATE" check 84 2>"$F_ERR")"
jq -e '
  .frontendRequired == false and .frontendSelectionMethod == "ambiguous" and
  .previewAmbiguous == true and
  (.previewAmbiguityReason | test("frontend preview for PR #84")) and
  (.previewAmbiguityReason | test("srv-frontend-pr-84-a")) and
  (.previewAmbiguityReason | test("srv-frontend-pr-84-b")) and
  .frontendPreviewId == null and .frontendPreviewUrl == null and .frontendEvidenceGap == true and
  .backendSelectionMethod == "single" and .backendReady == true and
  .settled == true and .fetchOk == true
' <<<"$F_CHECK" >/dev/null || { echo "36b: backend-only PR did not record its frontend twins as ambiguous: $F_CHECK" >&2; exit 1; }
grep -qF 'srv-frontend-pr-84-b' "$F_ERR" || { echo "36b: frontend ambiguity was not reported on stderr" >&2; cat "$F_ERR" >&2; exit 1; }
export STUB_PR_FILES="[{\"filename\":\"backend/src/foo.ts\"},{\"filename\":\"${F_FRONTEND_PREFIX}src/app.tsx\"}]"
F_REQ_CHECK="$(bash "$GATE" check 84 2>/dev/null)"
jq -e '
  .frontendRequired == true and .previewAmbiguous == true and
  (.previewAmbiguityReason | test("srv-frontend-pr-84-a")) and
  .frontendReady == false and .settled == false and .fetchOk == false
' <<<"$F_REQ_CHECK" >/dev/null || { echo "36b: a frontend-required PR with frontend twins was not held: $F_REQ_CHECK" >&2; exit 1; }

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

# --- Any top-level statement that mutates or rebinds the imported name,
# other than the single trusted literal assignment, must fail closed too
# (shadow-review #723) -- AugAssign, `.extend`/`.append`, a second
# (re)assignment, and `del` all silently kept only the first literal before
# this fix, so a partial policy classified `light` instead of `full`.

# `+=` after the initial assignment.
AUGASSIGN_MOD="$STATE_DIR/policy-augassign.py"
cat > "$AUGASSIGN_MOD" <<'PY'
SENSITIVE_GLOBS = ["backend/permissions/**"]
SENSITIVE_GLOBS += ["backend/billing/**"]
PY
FGF_AUGASSIGN="$STATE_DIR/fgf-augassign.json"
cat > "$FGF_AUGASSIGN" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$AUGASSIGN_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$FGF_AUGASSIGN" | jq -e '
  .campaignSize == "full" and (.sizeReason | test("AugAssign"))
' >/dev/null

# `.extend(...)` after the initial assignment.
EXTEND_MOD="$STATE_DIR/policy-extend.py"
cat > "$EXTEND_MOD" <<'PY'
SENSITIVE_GLOBS = ["backend/permissions/**"]
SENSITIVE_GLOBS.extend(["backend/billing/**"])
PY
FGF_EXTEND="$STATE_DIR/fgf-extend.json"
cat > "$FGF_EXTEND" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$EXTEND_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$FGF_EXTEND" | jq -e '
  .campaignSize == "full" and (.sizeReason | test("Expr"))
' >/dev/null

# `.append(...)` after the initial assignment.
APPEND_MOD="$STATE_DIR/policy-append.py"
cat > "$APPEND_MOD" <<'PY'
SENSITIVE_GLOBS = ["backend/permissions/**"]
SENSITIVE_GLOBS.append("backend/billing/**")
PY
FGF_APPEND="$STATE_DIR/fgf-append.json"
cat > "$FGF_APPEND" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$APPEND_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$FGF_APPEND" | jq -e '
  .campaignSize == "full" and (.sizeReason | test("Expr"))
' >/dev/null

# A second top-level (re)assignment -- even a plain literal one -- is no
# longer trustworthy either: nothing left in the file distinguishes intended
# shadowing from an accidental leftover first draft, so this must fail
# closed rather than silently keep only the last value.
REASSIGN_MOD="$STATE_DIR/policy-reassign.py"
cat > "$REASSIGN_MOD" <<'PY'
SENSITIVE_GLOBS = ["backend/permissions/**"]
SENSITIVE_GLOBS = ["backend/permissions/**", "backend/billing/**"]
PY
FGF_REASSIGN="$STATE_DIR/fgf-reassign.json"
cat > "$FGF_REASSIGN" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$REASSIGN_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$FGF_REASSIGN" | jq -e '
  .campaignSize == "full" and (.sizeReason | test("reassigned"))
' >/dev/null

# `del` after the initial assignment.
DEL_MOD="$STATE_DIR/policy-del.py"
cat > "$DEL_MOD" <<'PY'
SENSITIVE_GLOBS = ["backend/permissions/**", "backend/billing/**"]
del SENSITIVE_GLOBS
PY
FGF_DEL="$STATE_DIR/fgf-del.json"
cat > "$FGF_DEL" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$DEL_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$FGF_DEL" | jq -e '
  .campaignSize == "full" and (.sizeReason | test("Delete"))
' >/dev/null

# --- A REALISTIC policy file must classify exactly as the minimal one does
# (#736 round-1 P1). The first cut of the guard above refused any top-level
# statement that so much as READ the imported name, and a real policy file is
# one constant plus every line derived from it -- a compiled regex, a count, a
# wider list -- so the guard refused the only shape it would ever meet in
# production and sized every PR on that install `full`. A plain read leaves
# the assigned literal exactly as written; only a BINDING or MUTATING use may
# refuse. This fixture is the structural fix for that class: every derived
# read below is one the live policy file actually contains.
REALISTIC_MOD="$STATE_DIR/policy-realistic.py"
cat > "$REALISTIC_MOD" <<'PY'
"""A policy file shaped like a real one: a constant, then lines derived from it."""
import re

DEFAULT_SIZE = "standard"
SENSITIVE_GLOBS = ["backend/permissions/**", "backend/billing/**"]
SENSITIVE_RE = re.compile("|".join(g.replace("**", ".*") for g in SENSITIVE_GLOBS))
GLOB_COUNT = len(SENSITIVE_GLOBS)
ALL_GLOBS = SENSITIVE_GLOBS + ["backend/legacy/**"]
PY
FGF_REALISTIC="$STATE_DIR/fgf-realistic.json"
cat > "$FGF_REALISTIC" <<JSON
{"full":[],"lightAllowed":["frontend/**"],"lightDeny":[],
 "fullGlobsFrom":{"path":"$REALISTIC_MOD","name":"SENSITIVE_GLOBS"}}
JSON
# Identical sizes to the minimal-policy rules file (FGF_RULES, same globs),
# input for input -- the derived reads change nothing.
for SIZE_INPUT in '["backend/billing/charge.ts"]' '["backend/permissions/roles.ts"]' '["frontend/a.css"]' '["frontend/a.css","docs/x.md"]'; do
  MIN_OUT="$(echo "$SIZE_INPUT" | python3 "$CLASSIFY" "$FGF_RULES" | jq -r '.campaignSize')"
  REAL_OUT="$(echo "$SIZE_INPUT" | python3 "$CLASSIFY" "$FGF_REALISTIC" | jq -r '.campaignSize')"
  [ "$MIN_OUT" = "$REAL_OUT" ] ||
    { echo "736: derived reads changed the size for $SIZE_INPUT (minimal=$MIN_OUT realistic=$REAL_OUT)" >&2; exit 1; }
done
# ...and those sizes are the real ones, not `full` for everything: the
# equality above would also hold if BOTH files were refused.
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$FGF_REALISTIC" | jq -e '
  .campaignSize == "full" and
  .sizeReason == "full: backend/billing/charge.ts matched backend/billing/**"
' >/dev/null
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$FGF_REALISTIC" | jq -e '
  .campaignSize == "light"
' >/dev/null

# A bare annotation before the assignment binds nothing and must not refuse.
ANNOTATED_MOD="$STATE_DIR/policy-annotated.py"
cat > "$ANNOTATED_MOD" <<'PY'
SENSITIVE_GLOBS: list[str]
SENSITIVE_GLOBS = ["backend/permissions/**", "backend/billing/**"]
PY
FGF_ANNOTATED="$STATE_DIR/fgf-annotated.json"
cat > "$FGF_ANNOTATED" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$ANNOTATED_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$FGF_ANNOTATED" | jq -e '
  .campaignSize == "full" and
  .sizeReason == "full: backend/billing/charge.ts matched backend/billing/**"
' >/dev/null
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$FGF_ANNOTATED" | jq -e '
  .campaignSize == "light"
' >/dev/null

# --- Binding shapes that no ast.Name check can see (#736 round-1 P2-1).
# Every fixture below assigns ONLY the permissions glob at top level and then
# rebinds or mutates the name through some other route, so a guard that misses
# the route reads a PARTIAL policy and sizes a billing PR `light` -- exactly
# the #723 class. Each must fail closed to `full` instead.
assert_policy_refused() {
  # $1 = fixture basename, $2 = python source, $3 = expected reason regex
  local mod="$STATE_DIR/policy-$1.py" rules="$STATE_DIR/fgf-$1.json"
  printf '%s' "$2" > "$mod"
  cat > "$rules" <<JSON
{"full":[],"lightAllowed":["backend/**"],
 "fullGlobsFrom":{"path":"$mod","name":"SENSITIVE_GLOBS"}}
JSON
  echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$rules" | jq -e --arg rx "$3" '
    .campaignSize == "full" and (.sizeReason | test($rx))
  ' >/dev/null || { echo "736: policy fixture $1 did not fail closed (expected reason ~ $3)" >&2; exit 1; }
}

assert_runtime_widening_policy_refused() {
  # Prove both halves of the stale-literal failure: the reviewer-authored
  # fixture really widens the imported list at runtime, while the classifier
  # refuses that binding instead of reading the one-entry literal and calling
  # the billing change `light` under the backend/** light rule.
  local mod="$STATE_DIR/policy-$1.py" rules="$STATE_DIR/fgf-$1.json"
  printf '%s' "$2" > "$mod"
  python3 - "$mod" <<'PY'
import runpy
import sys

globs = runpy.run_path(sys.argv[1])["SENSITIVE_GLOBS"]
expected = ["backend/permissions/**", "backend/billing/**"]
if globs != expected:
    raise SystemExit("fixture did not widen the runtime policy: {!r}".format(globs))
PY
  cat > "$rules" <<JSON
{"full":[],"lightAllowed":["backend/**"],
 "fullGlobsFrom":{"path":"$mod","name":"SENSITIVE_GLOBS"}}
JSON
  echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$rules" | jq -e --arg rx "$3" '
    .campaignSize == "full" and (.sizeReason | test($rx))
  ' >/dev/null || { echo "769: runtime-widening fixture $1 did not fail closed (expected reason ~ $3)" >&2; exit 1; }
}

# `from x import NAME` rebinds the name to whatever that module holds.
assert_policy_refused from-import 'SENSITIVE_GLOBS = ["backend/permissions/**"]
from policy_extra import SENSITIVE_GLOBS
' 'ImportFrom'

# `import x as NAME`.
assert_policy_refused import-as 'SENSITIVE_GLOBS = ["backend/permissions/**"]
import policy_extra as SENSITIVE_GLOBS
' 'Import'

# A star import binds names this classifier cannot enumerate, so ANY star
# import in the policy file is refused, whatever the imported module is.
assert_policy_refused star-import 'SENSITIVE_GLOBS = ["backend/permissions/**"]
from policy_extra import *
' 'ImportFrom'

# `def NAME` / `class NAME` rebind the name to a function or a class.
assert_policy_refused def-over 'SENSITIVE_GLOBS = ["backend/permissions/**"]


def SENSITIVE_GLOBS():
    return ["backend/permissions/**", "backend/billing/**"]
' 'FunctionDef'

assert_policy_refused class-over 'SENSITIVE_GLOBS = ["backend/permissions/**"]


class SENSITIVE_GLOBS:
    pass
' 'ClassDef'

# `except ... as NAME` binds (and then deletes) the name.
assert_policy_refused except-as 'SENSITIVE_GLOBS = ["backend/permissions/**"]
try:
    pass
except ValueError as SENSITIVE_GLOBS:
    pass
' 'Try'

# `match` captures bind through a string field: MatchAs, MatchStar, and
# MatchMapping.rest. The reason alternative covers a pre-3.10 interpreter,
# where the statement does not parse at all -- still fail-closed, different
# reason.
assert_policy_refused match-as 'SENSITIVE_GLOBS = ["backend/permissions/**"]
match DEFAULT_SIZE:
    case SENSITIVE_GLOBS:
        pass
' 'Match|could not be parsed'

assert_policy_refused match-star 'SENSITIVE_GLOBS = ["backend/permissions/**"]
match DEFAULT_SIZE:
    case [*SENSITIVE_GLOBS]:
        pass
' 'Match|could not be parsed'

assert_policy_refused match-rest 'SENSITIVE_GLOBS = ["backend/permissions/**"]
match DEFAULT_SIZE:
    case {"a": 1, **SENSITIVE_GLOBS}:
        pass
' 'Match|could not be parsed'

# An alias shares the one list object, so a mutation through the OTHER name
# changes the policy while the literal above still reads complete.
assert_runtime_widening_policy_refused alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
ALIAS = SENSITIVE_GLOBS
ALIAS.append("backend/billing/**")
' 'Assign'

# #769: a trusted literal may have exactly one target.  Chained assignment
# makes the other target an alias of that literal, so it can widen the policy
# while the classifier would otherwise read only the original permissions
# glob and size this billing change `light`.
assert_runtime_widening_policy_refused chained-alias-append 'LEGACY = SENSITIVE_GLOBS = ["backend/permissions/**"]
LEGACY.append("backend/billing/**")
' 'Assign'

# An alias can also hide in a destructuring RHS; the direct-name-only check
# above must not treat this as the ordinary derived-list read below.
assert_runtime_widening_policy_refused tuple-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
LEGACY, UNUSED = (SENSITIVE_GLOBS, [])
LEGACY.append("backend/billing/**")
' 'aliases'

# Likewise, a conditional can bind the trusted list itself on one branch.
# The condition is true here so this also describes a real import-time
# widening, but the classifier must refuse any branch that can alias it.
assert_runtime_widening_policy_refused conditional-alias-append 'USE_LEGACY = True
SENSITIVE_GLOBS = ["backend/permissions/**"]
LEGACY = SENSITIVE_GLOBS if USE_LEGACY else []
LEGACY.append("backend/billing/**")
' 'aliases'

# A pure callee is only non-mutating; it does not promise a deep copy.  These
# wrappers retain the trusted list as an element, so either later mutation
# widens the imported policy even though direct `tuple(SENSITIVE_GLOBS)` and
# `list(SENSITIVE_GLOBS)` remain valid copies of the literal strings.
assert_runtime_widening_policy_refused tuple-wrapped-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
LEGACY, = tuple([SENSITIVE_GLOBS])
LEGACY.append("backend/billing/**")
' 'aliases'

assert_runtime_widening_policy_refused list-wrapped-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
LEGACY = list([SENSITIVE_GLOBS])
LEGACY[0].append("backend/billing/**")
' 'aliases'

# The wrapper's reference can also be extracted immediately, without a
# named intermediate container.  The binding guard must cover the expression
# that receives the alias, not only the wrapper assignment shape.
assert_runtime_widening_policy_refused subscript-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
LEGACY = (SENSITIVE_GLOBS,)[0]
LEGACY.append("backend/billing/**")
' 'aliases'

# A walrus binds at top level too.  It is not an Assign node, but it can make
# the same direct alias before a later mutation widens the imported policy.
assert_runtime_widening_policy_refused walrus-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
(LEGACY := SENSITIVE_GLOBS)
LEGACY.append("backend/billing/**")
' 'aliases'

# New outer containers do not prove a deep copy. Both bindings retain the
# policy list as element zero, then mutate that exact object at import time.
assert_runtime_widening_policy_refused list-plus-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
LEGACY = [SENSITIVE_GLOBS] + []
LEGACY[0].append("backend/billing/**")
' 'aliases'

assert_runtime_widening_policy_refused comprehension-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
LEGACY = [glob for glob in [SENSITIVE_GLOBS]]
LEGACY[0].append("backend/billing/**")
' 'aliases'

# The reference proof must cover BOTH operands of its one permitted derived
# list form.  The outer concatenation is new, but its right operand keeps the
# original list as an element and therefore still exposes it for mutation.
assert_runtime_widening_policy_refused derived-list-nested-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
LEGACY = SENSITIVE_GLOBS + [SENSITIVE_GLOBS]
LEGACY[-1].append("backend/billing/**")
' 'aliases'

# A call can retain a reference through its CALLEE, even when it has no
# arguments.  Looking only at call arguments accepts this immediately-invoked
# closure and leaves the classifier reading the stale literal.
assert_runtime_widening_policy_refused lambda-callee-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
LEGACY = (lambda: SENSITIVE_GLOBS)()
LEGACY.append("backend/billing/**")
' 'aliases'

# Module-level binders other than assignment must pass through the same
# reference-retention proof.  Each of these five reviewer-authored fixtures
# executes successfully and widens the real policy while leaving its literal
# assignment unchanged, so the real classifier CLI must fail closed.
assert_runtime_widening_policy_refused for-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
for LEGACY in [SENSITIVE_GLOBS]:
    LEGACY.append("backend/billing/**")
' 'aliases through an iterable binding'

assert_runtime_widening_policy_refused augassign-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
LEGACY = []
LEGACY += [SENSITIVE_GLOBS]
LEGACY[0].append("backend/billing/**")
' 'aliases through augmented assignment'

assert_runtime_widening_policy_refused match-capture-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
match SENSITIVE_GLOBS:
    case LEGACY:
        LEGACY.append("backend/billing/**")
' 'aliases through a match capture'

assert_runtime_widening_policy_refused for-destructured-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
for LEGACY, in [(SENSITIVE_GLOBS,)]:
    LEGACY.append("backend/billing/**")
' 'aliases through an iterable binding'

assert_runtime_widening_policy_refused match-nested-capture-alias-append 'SENSITIVE_GLOBS = ["backend/permissions/**"]
match [SENSITIVE_GLOBS]:
    case [LEGACY]:
        LEGACY.append("backend/billing/**")
' 'aliases through a match capture'

# A read is not an alias: `ALL = NAME + OTHER` builds a NEW list and leaves
# the constant alone, so the same file with a derived read still classifies.
# (Covered by the realistic fixture above; this is the one-line contrast.)

# --- Namespace reached by string (#736 round-1 P3-1): a constants file has
# no need for `globals`/`vars`/`setattr`/`exec`/`eval`/`__import__`/
# `sys.modules` at top level, and each of them can rebind the name in a way
# no name-level check can see.
assert_policy_refused globals-write 'SENSITIVE_GLOBS = ["backend/permissions/**"]
globals()["SENSITIVE_GLOBS"] = ["backend/billing/**"]
' 'globals'

assert_policy_refused sys-modules 'SENSITIVE_GLOBS = ["backend/permissions/**"]
import sys

sys.modules[__name__].SENSITIVE_GLOBS = ["backend/billing/**"]
' 'sys.modules'

# --- A top-level CALL runs at import time and can mutate the constant in
# place, leaving the literal this classifier reads a partial policy -- #723's
# class by a route no name-level check sees (#736 round-2). Three shapes, one
# cause: the constant handed to something that can mutate it.

# 1. A helper that mutates its parameter. The call site reads like a plain
#    use; only the callee knows.
assert_policy_refused widen-call 'def _widen(globs):
    globs.append("backend/billing/**")


SENSITIVE_GLOBS = ["backend/permissions/**"]
_widen(SENSITIVE_GLOBS)
' 'Expr'

# 2. The same cause with the constant as an argument to an unbound method --
#    `SENSITIVE_GLOBS.append(...)` is already refused, so this is the way
#    round it.
assert_policy_refused list-append-call 'SENSITIVE_GLOBS = ["backend/permissions/**"]
list.append(SENSITIVE_GLOBS, "backend/billing/**")
' 'Expr'

# 3. A helper whose BODY reaches the namespace by string, invoked at top
#    level: nothing at top level names either `setattr` or the constant, and
#    `_namespace_escape` does not scan function bodies, so only resolving the
#    callee finds it.
assert_policy_refused setattr-helper 'import sys


def _install(value):
    setattr(sys.modules[__name__], "SENSITIVE_GLOBS", value)


SENSITIVE_GLOBS = ["backend/permissions/**"]
_install(["backend/billing/**"])
' 'setattr|sys.modules'

# Read-only control: the constant passed to callees that CANNOT mutate it
# still classifies exactly as the minimal policy does. Refusing every call
# that takes the constant, or every top-level call to a module-level helper,
# would size every PR on a real install `full` -- round 1's regression.
CALLREAD_MOD="$STATE_DIR/policy-callread.py"
cat > "$CALLREAD_MOD" <<'PY'
SENSITIVE_GLOBS = ["backend/permissions/**", "backend/billing/**"]
GLOB_COUNT = len(SENSITIVE_GLOBS)
SORTED_GLOBS = sorted(SENSITIVE_GLOBS)
FROZEN_GLOBS = tuple(SENSITIVE_GLOBS)
COPIED_GLOBS = list(SENSITIVE_GLOBS)
UNIQUE_GLOBS = set(SENSITIVE_GLOBS)
HAS_ANY = any(SENSITIVE_GLOBS)
HAS_ALL = all(SENSITIVE_GLOBS)
EMPTY_COPY = list([])
GLOB_RE = "|".join(SENSITIVE_GLOBS)
ALL_GLOBS = SENSITIVE_GLOBS + ["backend/legacy/**"]
PY
CALLREAD_RULES="$STATE_DIR/fgf-callread.json"
cat > "$CALLREAD_RULES" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$CALLREAD_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$CALLREAD_RULES" | jq -e '
  .campaignSize == "full" and
  .sizeReason == "full: backend/billing/charge.ts matched backend/billing/**"
' >/dev/null
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$CALLREAD_RULES" | jq -e '
  .campaignSize == "light"
' >/dev/null

# Safe reference controls: direct list/tuple copies contain only the trusted
# list's immutable strings, `NAME + OTHER` creates a new outer list, and an
# unrelated `list([])` does not mention the policy at all.  Mutating the list
# copy at runtime must leave the source list unchanged, and the classifier
# must therefore keep a billing-only change `light` rather than over-sizing
# every policy file that uses these ordinary forms.
SAFE_COPY_MOD="$STATE_DIR/policy-safe-copy.py"
cat > "$SAFE_COPY_MOD" <<'PY'
SENSITIVE_GLOBS = ["backend/permissions/**"]
LIST_COPY = list(SENSITIVE_GLOBS)
TUPLE_COPY = tuple(SENSITIVE_GLOBS)
LIST_COPY.append("backend/billing/**")
UNRELATED = list([])
ALL_GLOBS = SENSITIVE_GLOBS + ["backend/legacy/**"]
DIRECT_ITERATION = []
for GLOB in SENSITIVE_GLOBS:
    DIRECT_ITERATION.append(GLOB)
COPY_ITERATION = []
for GLOB in list(SENSITIVE_GLOBS):
    COPY_ITERATION.append(GLOB)
PY
python3 - "$SAFE_COPY_MOD" <<'PY'
import runpy
import sys

policy = runpy.run_path(sys.argv[1])
if policy["SENSITIVE_GLOBS"] != ["backend/permissions/**"]:
    raise SystemExit("safe copy mutated the runtime policy")
if policy["LIST_COPY"] != ["backend/permissions/**", "backend/billing/**"]:
    raise SystemExit("safe copy control did not execute")
if policy["DIRECT_ITERATION"] != ["backend/permissions/**"]:
    raise SystemExit("safe scalar iteration did not execute")
if policy["COPY_ITERATION"] != ["backend/permissions/**"]:
    raise SystemExit("safe flat-copy iteration did not execute")
PY
SAFE_COPY_RULES="$STATE_DIR/fgf-safe-copy.json"
cat > "$SAFE_COPY_RULES" <<JSON
{"full":[],"lightAllowed":["backend/**"],
 "fullGlobsFrom":{"path":"$SAFE_COPY_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$SAFE_COPY_RULES" | jq -e '
  .campaignSize == "light" and
  .sizeReason == "light: all 1 changed file(s) matched lightAllowed"
' >/dev/null

# Read-only control 2: a policy file that CALLS its own helpers at top level
# classifies normally, as long as no reachable body escapes the namespace.
# The live policy does this 46 times; refusing it is the round-1 regression.
HELPERS_MOD="$STATE_DIR/policy-helpers.py"
cat > "$HELPERS_MOD" <<'PY'
import re


def _glob_re(glob):
    return glob.replace("**", ".*")


def _describe(count):
    return "{} sensitive globs".format(count)


SENSITIVE_GLOBS = ["backend/permissions/**", "backend/billing/**"]
SENSITIVE_RE = re.compile("|".join(_glob_re(g) for g in SENSITIVE_GLOBS))
SUMMARY = _describe(len(SENSITIVE_GLOBS))
PY
HELPERS_RULES="$STATE_DIR/fgf-helpers.json"
cat > "$HELPERS_RULES" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$HELPERS_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$HELPERS_RULES" | jq -e '
  .campaignSize == "full" and
  .sizeReason == "full: backend/billing/charge.ts matched backend/billing/**"
' >/dev/null
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$HELPERS_RULES" | jq -e '
  .campaignSize == "light"
' >/dev/null

# --- A pure-callee name the POLICY FILE ITSELF binds is not the builtin it
# spells (#736 round-3). The call-argument rule above matched its callee by
# NAME, so a module-level `def len(globs): globs.append(...)` scored its own
# `len(NAME)` a pure read: the classifier trusted the literal while the real
# import widened it -- #723's class, through the round-2 guard's own door.
#
# The rule is "this name is bound at module level", not a list of the forms
# that bind it, so there is one case per binder. Each fixture's literal holds
# ONLY the permissions glob, so a missed shadowing classifies a billing PR
# `light` instead of `full`. The two read-only controls directly above
# (policy-callread, policy-helpers) are the other half of this check: they
# must stay unmoved, or the rule has regressed into refusing every call --
# round 1 again.
assert_policy_refused shadow-def 'SENSITIVE_GLOBS = ["backend/permissions/**"]


def len(globs):
    globs.append("backend/billing/**")
    return 0


len(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-class 'SENSITIVE_GLOBS = ["backend/permissions/**"]


class sorted:
    pass


sorted(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-from-import 'SENSITIVE_GLOBS = ["backend/permissions/**"]
from policy_extra import tuple

tuple(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-import-as 'SENSITIVE_GLOBS = ["backend/permissions/**"]
import policy_extra as list

list(SENSITIVE_GLOBS)
' 'could mutate'

# The two import spellings that bind through a DIFFERENT alias field than the
# two above: a bare `import len` binds the first dotted segment of the module
# name, and `from x import foo as len` binds the asname. Neither names the
# constant, so the pre-existing import check walks straight past both and only
# the shadowing rule refuses them.
assert_policy_refused shadow-import-bare 'SENSITIVE_GLOBS = ["backend/permissions/**"]
import len

len(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-from-import-as 'SENSITIVE_GLOBS = ["backend/permissions/**"]
from policy_extra import widen as sorted

sorted(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-assign 'def _widen(globs):
    globs.append("backend/billing/**")
    return globs


SENSITIVE_GLOBS = ["backend/permissions/**"]
set = _widen
set(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-annassign 'def _widen(globs):
    globs.append("backend/billing/**")
    return globs


SENSITIVE_GLOBS = ["backend/permissions/**"]
any: object = _widen
any(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-for 'def _widen(globs):
    globs.append("backend/billing/**")
    return globs


SENSITIVE_GLOBS = ["backend/permissions/**"]
for all in (_widen,):
    pass

all(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-with 'SENSITIVE_GLOBS = ["backend/permissions/**"]
with open("policy_extra.py") as len:
    pass

len(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-except-as 'SENSITIVE_GLOBS = ["backend/permissions/**"]
try:
    pass
except ValueError as sorted:
    pass

sorted(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-walrus 'def _widen(globs):
    globs.append("backend/billing/**")
    return globs


SENSITIVE_GLOBS = ["backend/permissions/**"]
(tuple := _widen)
tuple(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-del 'SENSITIVE_GLOBS = ["backend/permissions/**"]
del len
len(SENSITIVE_GLOBS)
' 'could mutate'

assert_policy_refused shadow-global 'SENSITIVE_GLOBS = ["backend/permissions/**"]
global len
len(SENSITIVE_GLOBS)
' 'could mutate'

# A walrus in a DEFAULT ARGUMENT is evaluated at import and binds a module
# name, even though the function body around it is not top-level code.
assert_policy_refused shadow-default-walrus 'def _widen(globs):
    globs.append("backend/billing/**")
    return globs


SENSITIVE_GLOBS = ["backend/permissions/**"]


def _factory(widen=(len := _widen)):
    return widen


len(SENSITIVE_GLOBS)
' 'could mutate'

# A `match` capture binds through a string field. The reason alternative
# covers a pre-3.10 interpreter, where the statement does not parse at all --
# still fail-closed, different reason.
assert_policy_refused shadow-match 'SENSITIVE_GLOBS = ["backend/permissions/**"]
match SENSITIVE_GLOBS:
    case len:
        pass

len(SENSITIVE_GLOBS)
' 'aliases through a match capture|could mutate|could not be parsed'

# A star import binds names that cannot be enumerated, so no callee is
# provably the builtin. The star import itself already refuses the whole file
# (the `may rebind` reason above), which is why this asserts that reason and
# not the call-argument one: belt and braces, the same answer twice.
assert_policy_refused shadow-star-import 'SENSITIVE_GLOBS = ["backend/permissions/**"]
from policy_extra import *

len(SENSITIVE_GLOBS)
' 'may rebind'

# Control for the shadowing rule specifically: binding names that are NOT on
# the pure allowlist must not poison the genuine builtins beside them. This
# file defines two helpers, calls one, and still reads the constant with the
# real `len` and `"|".join` -- it must classify exactly as the minimal policy.
NEARMISS_MOD="$STATE_DIR/policy-nearmiss.py"
cat > "$NEARMISS_MOD" <<'PY'
def _describe(count):
    return "{} sensitive globs".format(count)


def _lengths(globs):
    return [len(g) for g in globs]


SENSITIVE_GLOBS = ["backend/permissions/**", "backend/billing/**"]
GLOB_COUNT = len(SENSITIVE_GLOBS)
SUMMARY = _describe(GLOB_COUNT)
GLOB_RE = "|".join(SENSITIVE_GLOBS)
PY
NEARMISS_RULES="$STATE_DIR/fgf-nearmiss.json"
cat > "$NEARMISS_RULES" <<JSON
{"full":[],"lightAllowed":["frontend/**"],
 "fullGlobsFrom":{"path":"$NEARMISS_MOD","name":"SENSITIVE_GLOBS"}}
JSON
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$NEARMISS_RULES" | jq -e '
  .campaignSize == "full" and
  .sizeReason == "full: backend/billing/charge.ts matched backend/billing/**"
' >/dev/null
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$NEARMISS_RULES" | jq -e '
  .campaignSize == "light"
' >/dev/null

# --- A DANGLING SYMLINK is present, not absent (#736 round-1 P2-2). open()
# raises FileNotFoundError for it exactly as it does for a path that was
# never created, so it used to collapse into "no sizing rules" -- #721's
# class. os.path.lexists() tells the two apart; the broken link fails closed.
DANGLING_RULES="$STATE_DIR/dangling-rules.json"
ln -s "$STATE_DIR/no-such-sizing-target.json" "$DANGLING_RULES"
if OUT="$(echo '[]' | python3 "$CLASSIFY" "$DANGLING_RULES" 2>/dev/null)"; then
  echo "736: dangling-symlink rules file exited 0 (stdout: $OUT)" >&2
  exit 1
fi
[ -z "$OUT" ] || { echo "736: dangling-symlink rules file printed stdout instead of failing closed" >&2; exit 1; }
# A symlink to a REAL rules file is still an ordinary readable file.
LINK_TARGET="$STATE_DIR/link-target-rules.json"
echo '{"full":["backend/**"],"lightAllowed":["frontend/**"]}' > "$LINK_TARGET"
LIVE_LINK="$STATE_DIR/live-link-rules.json"
ln -s "$LINK_TARGET" "$LIVE_LINK"
echo '["backend/billing/charge.ts"]' | python3 "$CLASSIFY" "$LIVE_LINK" | jq -e '
  .campaignSize == "full"
' >/dev/null

# --- RULE SHAPES (#736 round-1 P2-3). `list(rules.get(k) or [])` accepts any
# iterable, so a rule list written as a bare string became one glob per
# CHARACTER, none of which matches a path: `"full": "backend/**"` sized a
# sensitive PR `light`. Every wrong shape -- a string, a number, a list with a
# non-string in it, an explicit null, a non-object fullGlobsFrom -- exits
# non-zero with nothing meaningful on stdout, into the caller's guard.
SHAPE_N=0
for SHAPE_DOC in \
  '{"full":"backend/**","lightAllowed":["frontend/**"]}' \
  '{"full":7,"lightAllowed":["frontend/**"]}' \
  '{"full":null,"lightAllowed":["frontend/**"]}' \
  '{"full":["backend/**",7],"lightAllowed":["frontend/**"]}' \
  '{"full":[],"lightAllowed":"frontend/**"}' \
  '{"full":[],"lightAllowed":["frontend/**"],"lightDeny":"frontend/legacy/**"}' \
  '{"full":[],"lightAllowed":["frontend/**"],"lightDeny":null}' \
  '{"full":[],"lightAllowed":{"glob":"frontend/**"}}' \
  '{"full":[],"lightAllowed":["frontend/**"],"fullGlobsFrom":"policy.py"}' \
  '{"full":[],"lightAllowed":["frontend/**"],"fullGlobsFrom":null}' \
  ; do
  SHAPE_N=$((SHAPE_N + 1))
  SHAPE_RULES="$STATE_DIR/shape-$SHAPE_N-rules.json"
  printf '%s' "$SHAPE_DOC" > "$SHAPE_RULES"
  if OUT="$(echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$SHAPE_RULES" 2>/dev/null)"; then
    echo "736: malformed rule shape exited 0: $SHAPE_DOC (stdout: $OUT)" >&2
    exit 1
  fi
  [ -z "$OUT" ] || { echo "736: malformed rule shape printed stdout: $SHAPE_DOC" >&2; exit 1; }
done
# The well-shaped equivalents still classify normally -- the shape check must
# not refuse a legitimate rules file (an absent key is not a malformed one).
SHAPE_OK="$STATE_DIR/shape-ok-rules.json"
echo '{"lightAllowed":["frontend/**"]}' > "$SHAPE_OK"
echo '["frontend/a.css"]' | python3 "$CLASSIFY" "$SHAPE_OK" | jq -e '.campaignSize == "light"' >/dev/null
echo '{"full":["backend/**"],"lightAllowed":["frontend/**"],"lightDeny":[]}' > "$SHAPE_OK"
echo '["backend/x.ts"]' | python3 "$CLASSIFY" "$SHAPE_OK" | jq -e '.campaignSize == "full"' >/dev/null

# --- Task-scoped certification lease: claim/progress/release --------------
# A certification, re-verification or evidence-recovery run has no PR — this
# is the lifecycle smoke-run-scaffold.sh's begin_active_run_fence now accepts
# as a third active-slot shape.
fresh_state
TASK_SHA="$(sha 7)"
OTHER_TASK_SHA="$(sha 8)"

bash "$GATE" task-claim run-t1 "$TASK_SHA" | jq -e '.ok == true and .runId == "run-t1"' >/dev/null
jq -e --arg sha "$TASK_SHA" '.activeRunId == "run-t1" and .activeSha == $sha and .activeLeaseOwner != null' \
  "$STATE_DIR/task-run-t1-state.json" >/dev/null
jq -e --arg sha "$TASK_SHA" '.schemaVersion == 1 and .kind == "task" and .runId == "run-t1" and .deploySha == $sha' \
  "$SMOKE_GATE_LEASE_DIR/task-lease-run-t1.json" >/dev/null

# A different owner cannot claim a live task run without --takeover.
SMOKE_GATE_OWNER=owner-b bash "$GATE" task-claim run-t1 "$TASK_SHA" | jq -e '.ok == false' >/dev/null

# The same owner reclaiming keeps its original claimedAt.
ORIG_CLAIMED="$(jq -r '.claimedAt' "$SMOKE_GATE_LEASE_DIR/task-lease-run-t1.json")"
sleep 1
bash "$GATE" task-claim run-t1 "$TASK_SHA" | jq -e '.ok == true' >/dev/null
[ "$(jq -r '.claimedAt' "$SMOKE_GATE_LEASE_DIR/task-lease-run-t1.json")" = "$ORIG_CLAIMED" ] ||
  { echo "expected same-owner task reclaim to preserve claimedAt" >&2; exit 1; }

# A run id is permanently bound to its deploy SHA — no --takeover escape,
# unlike a PR's owner binding. A different build needs a different run id.
bash "$GATE" task-claim run-t1 "$OTHER_TASK_SHA" | jq -e '.ok == false and (.error | test("permanently bound"))' >/dev/null
bash "$GATE" task-claim run-t1 "$OTHER_TASK_SHA" --takeover | jq -e '.ok == false and (.error | test("permanently bound"))' >/dev/null

# Run ids are unique across the WHOLE gate: one already claimed by a PR
# campaign, or by the develop campaign, cannot also become a task run.
bash "$GATE" claim run-shared-pr 5 "$TASK_SHA" >/dev/null
bash "$GATE" task-claim run-shared-pr "$TASK_SHA" | jq -e '
  .ok == false and (.error | test("PR campaign"))
' >/dev/null
printf '{"schemaVersion":1,"activeRunId":"run-shared-dev","activeSha":"%s"}\n' "$TASK_SHA" \
  > "$STATE_DIR/develop-state.json"
bash "$GATE" task-claim run-shared-dev "$TASK_SHA" | jq -e '
  .ok == false and (.error | test("develop campaign"))
' >/dev/null
rm -f "$STATE_DIR/develop-state.json"

# task-progress renews the lease and stamps activeProgressAt; wrong owner and
# an unclaimed run are both refused.
BEFORE_EXPIRES="$(jq -r '.expiresAt' "$SMOKE_GATE_LEASE_DIR/task-lease-run-t1.json")"
sleep 1
bash "$GATE" task-progress run-t1 | jq -e '.ok == true and .leaseRenewed == true' >/dev/null
[ "$(jq -r '.expiresAt' "$SMOKE_GATE_LEASE_DIR/task-lease-run-t1.json")" != "$BEFORE_EXPIRES" ] ||
  { echo "expected task-progress to renew the lease expiry" >&2; exit 1; }
bash "$GATE" task-progress run-t1 owner-wrong | jq -e '.ok == false' >/dev/null
bash "$GATE" task-progress run-never-claimed | jq -e '.ok == false' >/dev/null

# task-release drops both the private slot and the shared lease; the run is
# then unclaimed and progress/release on it refuse as not-active.
bash "$GATE" task-release run-t1 | jq -e '.ok == true and .leaseReleased == true' >/dev/null
[ ! -e "$SMOKE_GATE_LEASE_DIR/task-lease-run-t1.json" ] ||
  { echo "expected task-release to remove the shared task lease" >&2; exit 1; }
jq -e '.activeRunId == null' "$STATE_DIR/task-run-t1-state.json" >/dev/null
bash "$GATE" task-progress run-t1 | jq -e '.ok == false' >/dev/null
bash "$GATE" task-release run-t1 | jq -e '.ok == false' >/dev/null

# After expiry (no takeover needed), a different owner may claim the same
# run id on the SAME deploy SHA.
bash "$GATE" task-claim run-t2 "$TASK_SHA" >/dev/null
expire_lease "$SMOKE_GATE_LEASE_DIR/task-lease-run-t2.json"
SMOKE_GATE_OWNER=owner-recovers bash "$GATE" task-claim run-t2 "$TASK_SHA" | jq -e '.ok == true' >/dev/null
jq -e '.owner == "owner-recovers"' "$SMOKE_GATE_LEASE_DIR/task-lease-run-t2.json" >/dev/null

# A live lease held by another owner IS overridable with --takeover (the
# owner binding, unlike the deploy-SHA binding, is not permanent).
bash "$GATE" task-claim run-t3 "$TASK_SHA" >/dev/null
SMOKE_GATE_OWNER=owner-force bash "$GATE" task-claim run-t3 "$TASK_SHA" --takeover | jq -e '.ok == true' >/dev/null
jq -e '.owner == "owner-force" and .deploySha == "'"$TASK_SHA"'"' "$SMOKE_GATE_LEASE_DIR/task-lease-run-t3.json" >/dev/null

# A malformed shared task lease fails every verb closed, never open.
bash "$GATE" task-claim run-t4 "$TASK_SHA" >/dev/null
printf 'not json' > "$SMOKE_GATE_LEASE_DIR/task-lease-run-t4.json"
bash "$GATE" task-claim run-t4 "$TASK_SHA" | jq -e '.ok == false and (.error | test("malformed"))' >/dev/null
bash "$GATE" task-progress run-t4 | jq -e '.ok == false' >/dev/null

# --- task-finish: the terminal step for a task-scoped run -------------------
# The run scaffold and barrier alone can never PUBLISH a certification's
# verdict — only this does, and only for the run's own lease owner on its own
# claimed deploy SHA.
fresh_state
FIN_SHA="$(sha 9)"

# No claim at all — refused, no verdict recorded.
bash "$GATE" task-finish run-fin-1 "$FIN_SHA" GO | jq -e '.ok == false' >/dev/null
[ ! -e "$STATE_DIR/runs/run-fin-1/verdict.json" ]

bash "$GATE" task-claim run-fin-1 "$FIN_SHA" >/dev/null

# Wrong owner is refused, no terminal effect.
bash "$GATE" task-finish run-fin-1 "$FIN_SHA" GO owner-wrong | jq -e '.ok == false and (.error | test("caller owner"))' >/dev/null
[ ! -e "$STATE_DIR/runs/run-fin-1/verdict.json" ]

# Wrong deploy SHA is refused. Exits 2, same as the argument refusals above
# it and `finish`'s own sha-mismatch check (smoke-pr-gate.sh's comment there:
# "bare ok:false, exit 2 — the invocation is wrong, not the world") — capture
# before piping, or `set -o pipefail` reads this refusal as the test failing.
WRONGSHA_OUT="$(bash "$GATE" task-finish run-fin-1 "$OTHER_TASK_SHA" GO || true)"
jq -e '.ok == false and (.error | test("does not match"))' <<<"$WRONGSHA_OUT" >/dev/null || {
  echo "expected task-finish to refuse a sha this run never claimed, got: $WRONGSHA_OUT" >&2; exit 1; }
[ ! -e "$STATE_DIR/runs/run-fin-1/verdict.json" ]

# Success records the verdict and releases the lease.
bash "$GATE" task-finish run-fin-1 "$FIN_SHA" GO | jq -e '.ok == true and .leaseReleased == true and .verdict == "GO"' >/dev/null
jq -e --arg sha "$FIN_SHA" '.sha == $sha and .runId == "run-fin-1" and .verdict == "GO"' \
  "$STATE_DIR/runs/run-fin-1/verdict.json" >/dev/null
[ ! -e "$SMOKE_GATE_LEASE_DIR/task-lease-run-fin-1.json" ] ||
  { echo "expected task-finish to remove the shared task lease" >&2; exit 1; }
jq -e '.activeRunId == null and .completedRunId == "run-fin-1" and .completedVerdict == "GO"' \
  "$STATE_DIR/task-run-fin-1-state.json" >/dev/null

# Repeating the SAME terminal facts is idempotent — nothing re-recorded.
bash "$GATE" task-finish run-fin-1 "$FIN_SHA" GO | jq -e '.ok == true and .idempotent == true' >/dev/null

# A second, DIFFERENT verdict for the same run is a reconciliation case, same
# shape as `finish`'s own refusal — the recorded verdict is never overwritten.
RECON_OUT="$(bash "$GATE" task-finish run-fin-1 "$FIN_SHA" NO_GO || true)"
jq -e '.ok == false and .gateStatus == "reconciliation_required"' <<<"$RECON_OUT" >/dev/null || {
  echo "expected a second, different task-finish to be refused as a reconciliation case, got: $RECON_OUT" >&2; exit 1; }
jq -e --arg sha "$FIN_SHA" '.sha == $sha and .verdict == "GO"' "$STATE_DIR/runs/run-fin-1/verdict.json" >/dev/null

# A run that was never claimed (or already finished and released) is refused
# as not-active, not silently treated as a fresh success.
bash "$GATE" task-finish run-fin-never "$FIN_SHA" GO | jq -e '.ok == false' >/dev/null

# --- #726 F1: a failed task-claim slot write puts back the lease it found ----
# The cleanup used to delete the shared task lease unconditionally — on a
# same-owner re-claim of a LIVE lease that destroyed a running coordinator's
# ownership record, and task-progress then refused it. `claim` and
# `task-release` both restore the prior lease; task-claim now does too.
fresh_state
F1_SHA="$(sha 7)"
bash "$GATE" task-claim run-f1 "$F1_SHA" owner-a | jq -e '.ok == true' >/dev/null
F1_BEFORE="$(cat "$SMOKE_GATE_LEASE_DIR/task-lease-run-f1.json")"
chmod 555 "$STATE_DIR"
F1_OUT="$(bash "$GATE" task-claim run-f1 "$F1_SHA" owner-a 2>/dev/null || true)"
chmod 700 "$STATE_DIR"   # restore before asserting, so a failure still cleans up
jq -e '.ok == false and (.error | test("private task slot")) and (.error | test("could not be") | not)' \
  <<<"$F1_OUT" >/dev/null || { echo "F1: expected a clean slot-write refusal, got: $F1_OUT" >&2; exit 1; }
[ "$(cat "$SMOKE_GATE_LEASE_DIR/task-lease-run-f1.json" 2>/dev/null)" = "$F1_BEFORE" ] ||
  { echo "F1: a failed same-owner re-claim did not leave the live lease exactly as it was" >&2; exit 1; }
jq -e '.owner == "owner-a"' "$SMOKE_GATE_LEASE_DIR/task-lease-run-f1.json" >/dev/null
bash "$GATE" task-progress run-f1 owner-a | jq -e '.ok == true' >/dev/null ||
  { echo "F1: the surviving owner could not progress after the failed re-claim" >&2; exit 1; }
# A failed --takeover gives the lease back to the owner it tried to displace.
F1_BEFORE="$(cat "$SMOKE_GATE_LEASE_DIR/task-lease-run-f1.json")"
chmod 555 "$STATE_DIR"
F1_TK_OUT="$(bash "$GATE" task-claim run-f1 "$F1_SHA" owner-b --takeover 2>/dev/null || true)"
chmod 700 "$STATE_DIR"
jq -e '.ok == false and (.error | test("private task slot"))' <<<"$F1_TK_OUT" >/dev/null ||
  { echo "F1: expected the takeover's slot write to fail, got: $F1_TK_OUT" >&2; exit 1; }
[ "$(cat "$SMOKE_GATE_LEASE_DIR/task-lease-run-f1.json" 2>/dev/null)" = "$F1_BEFORE" ] ||
  { echo "F1: a failed takeover left the lease with the displacing owner" >&2; exit 1; }
jq -e '.activeLeaseOwner == "owner-a"' "$STATE_DIR/task-run-f1-state.json" >/dev/null
# Only a lease the failed claim created from nothing is removed.
chmod 555 "$STATE_DIR"
F1_NEW_OUT="$(bash "$GATE" task-claim run-f1-new "$F1_SHA" 2>/dev/null || true)"
chmod 700 "$STATE_DIR"
jq -e '.ok == false and (.error | test("private task slot"))' <<<"$F1_NEW_OUT" >/dev/null
[ ! -e "$SMOKE_GATE_LEASE_DIR/task-lease-run-f1-new.json" ] ||
  { echo "F1: a failed first claim left an orphan task lease behind" >&2; exit 1; }

# --- #726 F1/F2: task-claim holds the shared task lease lock AND the gate
# control lock from lease acquisition through its private slot write. A
# PATH-local mktemp probe records, from a separate process, whether each lock
# is held at the instant the slot's temp file is created; it then runs the real
# mktemp. Releasing the lease lock before the slot write let two concurrent
# --takeover claims leave the lease owned by B and the slot naming A.
PROBE_BIN="$STUB_BIN/task-slot-probe"
mkdir -p "$PROBE_BIN"
cat > "$PROBE_BIN/mktemp" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  */.task-*-state.*)
    t=held; c=held
    ( flock -n 3 ) 3>"$PROBE_TASK_LOCK" && t=free
    ( flock -n 3 ) 3>"$PROBE_CONTROL_LOCK" && c=free
    printf 'task=%s control=%s\n' "$t" "$c" >> "$PROBE_OUT" ;;
esac
exec "$REAL_MKTEMP" "$@"
STUB
chmod +x "$PROBE_BIN/mktemp"
PROBE_OUT="$STATE_DIR/slot-probe.txt" \
PROBE_TASK_LOCK="$SMOKE_GATE_LEASE_DIR/task-lease-run-f1-probe.lock" \
PROBE_CONTROL_LOCK="$STATE_DIR/control.lock" \
REAL_MKTEMP="$(command -v mktemp)" PATH="$PROBE_BIN:$PATH" \
  bash "$GATE" task-claim run-f1-probe "$F1_SHA" | jq -e '.ok == true' >/dev/null
[ "$(cat "$STATE_DIR/slot-probe.txt" 2>/dev/null)" = "task=held control=held" ] || {
  echo "F1/F2: task-claim did not hold both locks through its slot write: $(cat "$STATE_DIR/slot-probe.txt" 2>/dev/null)" >&2; exit 1; }

# --- #726 F2: run-id uniqueness holds in BOTH directions ---------------------
# `task-claim` refused a run id a PR campaign held, but `claim` never looked at
# task-*-state.json: `task-claim run-b` then `claim run-b 5` returned ok:true,
# leaving two active slots that wedge both runs in begin_active_run_fence.
fresh_state
F2_SHA="$(sha 8)"
bash "$GATE" task-claim run-f2 "$F2_SHA" | jq -e '.ok == true' >/dev/null
F2_OUT="$(bash "$GATE" claim run-f2 5 "$F2_SHA")"
jq -e '.ok == false and .pr == 5 and (.error | test("task-scoped")) and (.error | test("unique"))' \
  <<<"$F2_OUT" >/dev/null || { echo "F2: claim took a run id an active task run holds: $F2_OUT" >&2; exit 1; }
[ ! -e "$STATE_DIR/pr-5-state.json" ] &&
  [ ! -e "$SMOKE_GATE_LEASE_DIR/lease-run-f2.json" ] &&
  [ ! -e "$SMOKE_GATE_LEASE_DIR/pr-5-authority.json" ] ||
  { echo "F2: the refused PR claim still wrote a slot, lease or authority" >&2; exit 1; }
bash "$GATE" task-progress run-f2 | jq -e '.ok == true' >/dev/null
# The other direction: a run id a PR campaign holds cannot become a task run.
bash "$GATE" claim run-f2-pr 6 "$F2_SHA" | jq -e '.ok == true' >/dev/null
bash "$GATE" task-claim run-f2-pr "$F2_SHA" | jq -e '.ok == false and (.error | test("PR campaign"))' >/dev/null ||
  { echo "F2: task-claim took a run id a PR campaign holds" >&2; exit 1; }
[ ! -e "$STATE_DIR/task-run-f2-pr-state.json" ] && [ ! -e "$SMOKE_GATE_LEASE_DIR/task-lease-run-f2-pr.json" ] ||
  { echo "F2: the refused task-claim still wrote a slot or lease" >&2; exit 1; }
bash "$GATE" progress run-f2-pr | jq -e '.ok == true and .pr == 6' >/dev/null
# A task state that exists but cannot be read fails the PR claim closed.
printf 'not json' > "$STATE_DIR/task-run-f2-bad-state.json"
bash "$GATE" claim run-f2-bad 7 "$F2_SHA" | jq -e '.ok == false and (.error | test("cannot be read"))' >/dev/null ||
  { echo "F2: claim read an unparseable task state as no task run" >&2; exit 1; }
[ ! -e "$STATE_DIR/pr-7-state.json" ]
# task-claim's scan runs under CONTROL_LOCK, the lock `claim` scans under, and
# fails closed (retryable) when it cannot get it — never the best-effort form.
F2_HELD="$STATE_DIR/control-held"
( flock -x 7; : > "$F2_HELD"; sleep 3 ) 7>"$STATE_DIR/control.lock" &
F2_BLOCKER=$!
for _ in $(seq 100); do [ -e "$F2_HELD" ] && break; sleep 0.05; done
[ -e "$F2_HELD" ] || { echo "F2: the control-lock holder never signalled that it held the lock" >&2; exit 1; }
F2_BUSY_OUT="$(SMOKE_GATE_LOCK_WAIT_SECONDS=1 bash "$GATE" task-claim run-f2-busy "$F2_SHA")"
wait "$F2_BLOCKER"
jq -e '.ok == false and .retryable == true and (.error | startswith("gate_lock_busy:"))' <<<"$F2_BUSY_OUT" >/dev/null ||
  { echo "F2: task-claim did not wait on the control lock: $F2_BUSY_OUT" >&2; exit 1; }
[ ! -e "$STATE_DIR/task-run-f2-busy-state.json" ] && [ ! -e "$SMOKE_GATE_LEASE_DIR/task-lease-run-f2-busy.json" ] ||
  { echo "F2: task-claim wrote a slot or lease without the control lock" >&2; exit 1; }

# --- #726 F3: a finished task run id is terminal ------------------------------
# task-finish removes the lease, the only record of the deploy-SHA binding, so
# `task-claim run-c <sha7>`, `task-finish GO`, `task-claim run-c <sha8>` used to
# return ok:true, null the completed fields, and leave task-finish <sha8>
# permanently reconciliation_required.
fresh_state
F3_SHA7="$(sha 7)"
F3_SHA8="$(sha 8)"
bash "$GATE" task-claim run-c "$F3_SHA7" | jq -e '.ok == true' >/dev/null
bash "$GATE" task-finish run-c "$F3_SHA7" GO | jq -e '.ok == true' >/dev/null
F3_STATE_BEFORE="$(cat "$STATE_DIR/task-run-c-state.json")"
F3_VERDICT_BEFORE="$(cat "$STATE_DIR/runs/run-c/verdict.json")"
F3_OUT="$(bash "$GATE" task-claim run-c "$F3_SHA8" || true)"
jq -e '.ok == false and .finished == true and (.error | test("already finished")) and
       (.error | test("start a new run id")) and .recordedVerdict.verdict == "GO"' \
  <<<"$F3_OUT" >/dev/null || { echo "F3: a finished task run was re-claimed on another build: $F3_OUT" >&2; exit 1; }
# The same build, even with --takeover, is no different: the run is over.
bash "$GATE" task-claim run-c "$F3_SHA7" --takeover | jq -e '.ok == false and .finished == true' >/dev/null ||
  { echo "F3: a finished task run was re-claimed on its own build" >&2; exit 1; }
[ "$(cat "$STATE_DIR/task-run-c-state.json")" = "$F3_STATE_BEFORE" ] &&
  [ "$(cat "$STATE_DIR/runs/run-c/verdict.json")" = "$F3_VERDICT_BEFORE" ] &&
  [ ! -e "$SMOKE_GATE_LEASE_DIR/task-lease-run-c.json" ] ||
  { echo "F3: a refused re-claim rewrote the terminal record or revived a lease" >&2; exit 1; }
jq -e '.completedRunId == "run-c" and .completedVerdict == "GO" and .completedAt != null' \
  "$STATE_DIR/task-run-c-state.json" >/dev/null
bash "$GATE" task-finish run-c "$F3_SHA7" GO | jq -e '.ok == true and .idempotent == true' >/dev/null
# The one verdict-bearing run that stays re-claimable, and only on its own
# build: a task-finish that died after its verdict write and lease removal but
# before its state commit. The run is then active with no lease, so task-finish
# cannot resume it until the owner re-claims on that SHA (the recovery
# task_lease_fence_begin's refusal names); refusing that too would strand it.
# The state commit is failed for real (read-only state dir, run dir already
# present); the lease removal it rolled back is then redone by hand.
bash "$GATE" task-claim run-r "$F3_SHA7" | jq -e '.ok == true' >/dev/null
mkdir -p "$STATE_DIR/runs/run-r"
chmod 555 "$STATE_DIR"
F3_R_OUT="$(bash "$GATE" task-finish run-r "$F3_SHA7" GO 2>/dev/null || true)"
chmod 700 "$STATE_DIR"
jq -e '.ok == false and (.error | test("terminal task state"))' <<<"$F3_R_OUT" >/dev/null ||
  { echo "F3: expected task-finish's state commit to fail, got: $F3_R_OUT" >&2; exit 1; }
F3_R_VERDICT="$(cat "$STATE_DIR/runs/run-r/verdict.json")"
jq -e '.activeRunId == "run-r" and .completedRunId == null' "$STATE_DIR/task-run-r-state.json" >/dev/null
rm -f "$SMOKE_GATE_LEASE_DIR/task-lease-run-r.json"
bash "$GATE" task-finish run-r "$F3_SHA7" GO | jq -e '.ok == false' >/dev/null
F3_R_OTHER="$(bash "$GATE" task-claim run-r "$F3_SHA8" || true)"
jq -e '.ok == false and .finished == false and (.error | test("different build"))' <<<"$F3_R_OTHER" >/dev/null ||
  { echo "F3: a half-finished run was re-claimed on another build: $F3_R_OTHER" >&2; exit 1; }
bash "$GATE" task-claim run-r "$F3_SHA7" | jq -e '.ok == true' >/dev/null ||
  { echo "F3: the same-build recovery re-claim of a half-finished run was refused" >&2; exit 1; }
bash "$GATE" task-finish run-r "$F3_SHA7" GO | jq -e '.ok == true and .verdict == "GO"' >/dev/null ||
  { echo "F3: task-finish did not resume after the recovery re-claim" >&2; exit 1; }
[ "$(cat "$STATE_DIR/runs/run-r/verdict.json")" = "$F3_R_VERDICT" ]
jq -e '.completedRunId == "run-r" and .activeRunId == null' "$STATE_DIR/task-run-r-state.json" >/dev/null

echo "smoke pr gate tests passed"
