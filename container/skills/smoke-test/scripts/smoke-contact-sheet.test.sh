#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/smoke-contact-sheet.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# Stub agent-browser: records every invocation to $AGENT_BROWSER_STUB_LOG and
# simulates the daemon closely enough for this script's own logic (it never
# inspects screenshot bytes — only existence and non-emptiness — so a tiny
# real PNG is enough). Failures are opt-in via magic substrings so each test
# case controls exactly which command fails, matching how the real CLI fails
# closed with a non-zero exit and an error line rather than throwing.
#
#   open <url>            containing FAIL-OPEN   -> exit 1
#   click <selector>       containing FAIL-CLICK  -> exit 1
#   screenshot --full <p>  path containing FAIL-SHOT -> exit 1
#   eval <js>               always prints a fixed stub build sha
# Every other verb (state, set, find, wait, close) always succeeds.
# ---------------------------------------------------------------------------
STUB_BIN="$WORK/bin"
mkdir -p "$STUB_BIN"
STUB_LOG="$WORK/agent-browser-calls.log"
: >"$STUB_LOG"

# A minimal valid 1x1 PNG, so "-s" (nonempty regular file) checks are
# satisfied with real image bytes rather than an arbitrary placeholder.
TINY_PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

cat >"$STUB_BIN/agent-browser" <<STUBEOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$STUB_LOG"

if [ "\$1" = "--session" ]; then shift 2; fi
VERB="\${1:-}"
shift || true

case "\$VERB" in
  state)
    exit 0
    ;;
  open)
    case "\${1:-}" in
      *FAIL-OPEN*) echo "stub: navigation failed" >&2; exit 1 ;;
      *) echo "✓ stub open"; exit 0 ;;
    esac
    ;;
  eval)
    echo "stub-build-sha-123"
    exit 0
    ;;
  set)
    exit 0
    ;;
  screenshot)
    DEST=""
    for a in "\$@"; do
      case "\$a" in --*) ;; *) DEST="\$a" ;; esac
    done
    case "\$DEST" in
      *FAIL-SHOT*) echo "stub: screenshot failed" >&2; exit 1 ;;
      *)
        printf '%s' "$TINY_PNG_B64" | base64 -d >"\$DEST"
        echo "✓ Screenshot saved to \$DEST"
        exit 0
        ;;
    esac
    ;;
  find)
    exit 0
    ;;
  click)
    case "\${1:-}" in
      *FAIL-CLICK*) echo "stub: element not found" >&2; exit 1 ;;
      *) exit 0 ;;
    esac
    ;;
  wait)
    exit 0
    ;;
  close)
    echo "✓ Browser closed"
    exit 0
    ;;
  *)
    echo "stub: unhandled verb '\$VERB'" >&2
    exit 1
    ;;
esac
STUBEOF
chmod +x "$STUB_BIN/agent-browser"

export PATH="$STUB_BIN:$PATH"
export AGENT_BROWSER_STUB_LOG="$STUB_LOG"

fresh_run_dir() {
  local d="$WORK/run-$1"
  mkdir -p "$d/contact-sheet"
  printf '%s' "$d"
}

AUTH_STATE="$WORK/auth-state.json"
printf '{"cookies":[],"origins":[]}' >"$AUTH_STATE"

# --- 1. Happy path -----------------------------------------------------------
RUN1="$(fresh_run_dir happy)"
cat >"$RUN1/contact-sheet/shots.json" <<'JSON'
[
  { "name": "home", "path": "/", "steps": ["click text=Get started", "wait 200"] },
  { "name": "settings-pricing", "path": "/settings" }
]
JSON

: >"$STUB_LOG"
RESULT="$(bash "$SCRIPT" "$RUN1" "https://example.test" "$AUTH_STATE")"
echo "$RESULT" | jq -e '.ok == true and .captured == 2 and .failed == 0 and .requested == 2 and .capped == false' \
  >/dev/null || { echo "happy path: unexpected result: $RESULT" >&2; exit 1; }

[ -s "$RUN1/contact-sheet/manifest.json" ] || { echo "happy path: manifest.json missing" >&2; exit 1; }
jq -e '.screens | length == 2' "$RUN1/contact-sheet/manifest.json" >/dev/null \
  || { echo "happy path: expected 2 screens in manifest" >&2; exit 1; }
jq -e '.buildSha == "stub-build-sha-123"' "$RUN1/contact-sheet/manifest.json" >/dev/null \
  || { echo "happy path: expected build sha read from the stub eval call" >&2; exit 1; }
jq -e '.screens[0].status == "captured" and .screens[0].desktop.captured == true and .screens[0].mobile.captured == true' \
  "$RUN1/contact-sheet/manifest.json" >/dev/null \
  || { echo "happy path: expected screen 0 fully captured" >&2; exit 1; }

[ -s "$RUN1/contact-sheet/shots/00-home-1280.png" ] || { echo "happy path: missing desktop shot" >&2; exit 1; }
[ -s "$RUN1/contact-sheet/shots/00-home-390.png" ] || { echo "happy path: missing mobile shot" >&2; exit 1; }
[ -s "$RUN1/contact-sheet/sheet.png" ] || { echo "happy path: sheet.png missing or empty" >&2; exit 1; }
grep -q '<img class="desktop" src="shots/00-home-1280.png">' "$RUN1/contact-sheet/grid.html" \
  || { echo "happy path: grid.html does not reference the desktop shot" >&2; exit 1; }

# One session for the whole run: every call must carry the same --session value.
SESSIONS_USED="$(grep -o '^--session [^ ]*' "$STUB_LOG" | sort -u | wc -l)"
[ "$SESSIONS_USED" -eq 1 ] || { echo "happy path: expected exactly one session, saw $SESSIONS_USED" >&2; exit 1; }

# state load must run before the first open (auth lease, never a fresh login).
FIRST_STATE_LINE="$(grep -n ' state load ' "$STUB_LOG" | head -1 | cut -d: -f1)"
FIRST_OPEN_LINE="$(grep -n ' open ' "$STUB_LOG" | head -1 | cut -d: -f1)"
[ -n "$FIRST_STATE_LINE" ] && [ -n "$FIRST_OPEN_LINE" ] && [ "$FIRST_STATE_LINE" -lt "$FIRST_OPEN_LINE" ] \
  || { echo "happy path: expected state load before the first open" >&2; exit 1; }

# the click step's text= shorthand must translate to find text ... click, not
# a raw `click "text=..."` call agent-browser does not understand.
grep -q ' find text Get started click' "$STUB_LOG" \
  || { echo "happy path: expected the text= step to use find text ... click" >&2; exit 1; }
grep -q ' click text=' "$STUB_LOG" \
  && { echo "happy path: text= step must never be passed straight to click" >&2; exit 1; }

echo "1/9 happy path ok"

# --- 2. A failed screen stays as a placeholder, never silently dropped ------
RUN2="$(fresh_run_dir failed-screen)"
cat >"$RUN2/contact-sheet/shots.json" <<'JSON'
[
  { "name": "home", "path": "/" },
  { "name": "broken", "path": "/FAIL-OPEN-this-route" }
]
JSON

RESULT="$(bash "$SCRIPT" "$RUN2" "https://example.test" "$AUTH_STATE")"
echo "$RESULT" | jq -e '.ok == true and .captured == 1 and .failed == 1' >/dev/null \
  || { echo "failed screen: unexpected result: $RESULT" >&2; exit 1; }

jq -e '.screens[1].name == "broken" and .screens[1].status == "failed" and
       .screens[1].desktop.captured == false and (.screens[1].desktop.reason | length > 0) and
       .screens[1].mobile.captured == false and (.screens[1].mobile.reason | length > 0)' \
  "$RUN2/contact-sheet/manifest.json" >/dev/null \
  || { echo "failed screen: expected screen 1 recorded failed with reasons, not dropped" >&2; exit 1; }

[ ! -e "$RUN2/contact-sheet/shots/01-broken-1280.png" ] \
  || { echo "failed screen: no screenshot should exist for a failed open" >&2; exit 1; }

grep -q 'FAILED' "$RUN2/contact-sheet/grid.html" \
  || { echo "failed screen: expected a FAILED placeholder tile in the grid" >&2; exit 1; }
grep -q 'class="desktop placeholder"' "$RUN2/contact-sheet/grid.html" \
  || { echo "failed screen: expected a desktop placeholder div" >&2; exit 1; }

echo "2/9 failed screen stays a placeholder ok"

# --- 3. The 8-screen cap ------------------------------------------------------
RUN3="$(fresh_run_dir cap)"
python3 - "$RUN3/contact-sheet/shots.json" <<'PY'
import json, sys
shots = [{"name": f"screen-{i}", "path": f"/s{i}"} for i in range(10)]
json.dump(shots, open(sys.argv[1], "w"))
PY

RESULT="$(bash "$SCRIPT" "$RUN3" "https://example.test" "$AUTH_STATE")"
echo "$RESULT" | jq -e '.ok == true and .requested == 10 and .capped == true and (.captured + .failed) == 8' \
  >/dev/null || { echo "cap: unexpected result: $RESULT" >&2; exit 1; }
jq -e '.requested == 10 and .capped == true and (.screens | length) == 8' "$RUN3/contact-sheet/manifest.json" \
  >/dev/null || { echo "cap: manifest did not record the 8-screen cap correctly" >&2; exit 1; }

echo "3/9 8-screen cap ok"

# --- 4. Missing auth state: refuse, never touch the browser ------------------
RUN4="$(fresh_run_dir no-auth)"
cat >"$RUN4/contact-sheet/shots.json" <<'JSON'
[{ "name": "home", "path": "/" }]
JSON

: >"$STUB_LOG"
set +e
RESULT="$(bash "$SCRIPT" "$RUN4" "https://example.test" "$WORK/does-not-exist.json" 2>&1)"
EC=$?
set -e
[ "$EC" -eq 2 ] || { echo "missing auth state: expected exit 2, got $EC" >&2; exit 1; }
echo "$RESULT" | jq -e '.ok == false and (.error | test("auth state"))' >/dev/null \
  || { echo "missing auth state: expected a refusal naming the auth state: $RESULT" >&2; exit 1; }
[ ! -s "$STUB_LOG" ] || { echo "missing auth state: agent-browser must never be invoked" >&2; exit 1; }

echo "4/9 missing auth state refuses before touching the browser ok"

# --- 5. Empty shots file: refuse -----------------------------------------------
RUN5="$(fresh_run_dir empty-shots)"
printf '[]' >"$RUN5/contact-sheet/shots.json"

: >"$STUB_LOG"
set +e
RESULT="$(bash "$SCRIPT" "$RUN5" "https://example.test" "$AUTH_STATE" 2>&1)"
EC=$?
set -e
[ "$EC" -eq 2 ] || { echo "empty shots: expected exit 2, got $EC" >&2; exit 1; }
echo "$RESULT" | jq -e '.ok == false and (.error | test("shots"))' >/dev/null \
  || { echo "empty shots: expected a refusal naming the shots file: $RESULT" >&2; exit 1; }
[ ! -s "$STUB_LOG" ] || { echo "empty shots: agent-browser must never be invoked" >&2; exit 1; }

# Missing shots.json entirely must refuse the same way.
RUN5B="$(fresh_run_dir missing-shots)"
set +e
RESULT="$(bash "$SCRIPT" "$RUN5B" "https://example.test" "$AUTH_STATE" 2>&1)"
EC=$?
set -e
[ "$EC" -eq 2 ] || { echo "missing shots file: expected exit 2, got $EC" >&2; exit 1; }
echo "$RESULT" | jq -e '.ok == false' >/dev/null \
  || { echo "missing shots file: expected a refusal: $RESULT" >&2; exit 1; }

echo "5/9 empty/missing shots file refuses ok"

# --- 6. Auth state inside the run dir: refuse ---------------------------------
# The auth state file holds a live session token; the run dir is a shared,
# durable evidence tree (and eventually posted/reviewed) — exactly where a
# QA-token leak has happened before.
RUN6="$(fresh_run_dir auth-in-rundir)"
cat >"$RUN6/contact-sheet/shots.json" <<'JSON'
[{ "name": "home", "path": "/" }]
JSON
AUTH_IN_RUNDIR="$RUN6/contact-sheet/auth-state.json"
printf '{"cookies":[],"origins":[]}' >"$AUTH_IN_RUNDIR"

: >"$STUB_LOG"
set +e
RESULT="$(bash "$SCRIPT" "$RUN6" "https://example.test" "$AUTH_IN_RUNDIR" 2>&1)"
EC=$?
set -e
[ "$EC" -eq 2 ] || { echo "auth in run dir: expected exit 2, got $EC" >&2; exit 1; }
echo "$RESULT" | jq -e '.ok == false and (.error | test("run dir"))' >/dev/null \
  || { echo "auth in run dir: expected a refusal naming the run dir: $RESULT" >&2; exit 1; }
[ ! -s "$STUB_LOG" ] || { echo "auth in run dir: agent-browser must never be invoked" >&2; exit 1; }

echo "6/9 auth state inside the run dir refuses ok"

# --- 7. Auth state under the shared workgroup tree: refuse --------------------
# Override the workgroup root so the test never depends on /workspace/workgroup
# actually existing on the host running this suite.
RUN7="$(fresh_run_dir auth-in-workgroup)"
cat >"$RUN7/contact-sheet/shots.json" <<'JSON'
[{ "name": "home", "path": "/" }]
JSON
FAKE_WORKGROUP_ROOT="$WORK/fake-workgroup"
mkdir -p "$FAKE_WORKGROUP_ROOT/qa-smoke"
AUTH_IN_WORKGROUP="$FAKE_WORKGROUP_ROOT/qa-smoke/auth-state.json"
printf '{"cookies":[],"origins":[]}' >"$AUTH_IN_WORKGROUP"

: >"$STUB_LOG"
set +e
RESULT="$(SMOKE_WORKGROUP_ROOT="$FAKE_WORKGROUP_ROOT" \
  bash "$SCRIPT" "$RUN7" "https://example.test" "$AUTH_IN_WORKGROUP" 2>&1)"
EC=$?
set -e
[ "$EC" -eq 2 ] || { echo "auth under workgroup root: expected exit 2, got $EC" >&2; exit 1; }
echo "$RESULT" | jq -e '.ok == false and (.error | test("workgroup"))' >/dev/null \
  || { echo "auth under workgroup root: expected a refusal naming the workgroup tree: $RESULT" >&2; exit 1; }
[ ! -s "$STUB_LOG" ] || { echo "auth under workgroup root: agent-browser must never be invoked" >&2; exit 1; }

# A private path outside both trees must still work fine even with the
# override set — the check is about containment, not the env var's mere
# presence.
: >"$STUB_LOG"
RESULT="$(SMOKE_WORKGROUP_ROOT="$FAKE_WORKGROUP_ROOT" \
  bash "$SCRIPT" "$RUN7" "https://example.test" "$AUTH_STATE")"
echo "$RESULT" | jq -e '.ok == true' >/dev/null \
  || { echo "auth under workgroup root: a private auth path must still succeed: $RESULT" >&2; exit 1; }

echo "7/9 auth state under the shared workgroup tree refuses ok"

# --- 8. Caller-supplied source SHA rides through to the manifest verbatim ---
# and the page is never sniffed for it (the stub's `eval` verb would answer
# "stub-build-sha-123" if it were ever called for this).
RUN8="$(fresh_run_dir source-sha)"
cat >"$RUN8/contact-sheet/shots.json" <<'JSON'
[{ "name": "home", "path": "/" }]
JSON
FROZEN_SHA="abcdef0123456789abcdef0123456789abcdef01"

: >"$STUB_LOG"
RESULT="$(bash "$SCRIPT" "$RUN8" "https://example.test" "$AUTH_STATE" "$FROZEN_SHA")"
echo "$RESULT" | jq -e '.ok == true' >/dev/null \
  || { echo "source sha: unexpected result: $RESULT" >&2; exit 1; }
jq -e --arg sha "$FROZEN_SHA" '.buildSha == $sha' "$RUN8/contact-sheet/manifest.json" >/dev/null \
  || { echo "source sha: expected manifest buildSha to be the caller-supplied sha" >&2; exit 1; }
grep -q ' eval ' "$STUB_LOG" \
  && { echo "source sha: must not sniff the page for a build sha when the caller already supplied one" >&2; exit 1; }

echo "8/9 caller-supplied source sha rides through to the manifest ok"

# --- 9. A malformed source SHA is refused, never written into the manifest --
RUN9="$(fresh_run_dir bad-sha)"
cat >"$RUN9/contact-sheet/shots.json" <<'JSON'
[{ "name": "home", "path": "/" }]
JSON

: >"$STUB_LOG"
for BAD_SHA in "not-a-sha" "abcdef" "ABCDEF0123456789ABCDEF0123456789ABCDEF01" "main"; do
  set +e
  RESULT="$(bash "$SCRIPT" "$RUN9" "https://example.test" "$AUTH_STATE" "$BAD_SHA" 2>&1)"
  EC=$?
  set -e
  [ "$EC" -eq 2 ] || { echo "malformed sha ($BAD_SHA): expected exit 2, got $EC" >&2; exit 1; }
  echo "$RESULT" | jq -e '.ok == false and (.error | test("sha"))' >/dev/null \
    || { echo "malformed sha ($BAD_SHA): expected a refusal naming the sha: $RESULT" >&2; exit 1; }
done
[ ! -s "$STUB_LOG" ] || { echo "malformed sha: agent-browser must never be invoked" >&2; exit 1; }
[ ! -e "$RUN9/contact-sheet/manifest.json" ] \
  || { echo "malformed sha: no manifest should be written on refusal" >&2; exit 1; }

# Omitting the argument entirely still falls back to the existing page-sniff
# behaviour (already covered by the happy path in test 1, which asserts
# buildSha == "stub-build-sha-123" with no fourth argument given).

echo "9/9 malformed source sha is refused, never written into the manifest ok"

echo "smoke contact sheet tests passed"
