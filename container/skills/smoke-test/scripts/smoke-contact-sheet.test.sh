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
#   open <url>            under https://baseline.test when
#                         AGENT_BROWSER_STUB_FAIL_BASELINE=1 -> exit 1
#   screenshot [--full] <p>  path containing FAIL-SHOT -> exit 1
#   eval location.pathname  prints the path of the session's last `open`,
#                           except: "/login" for the origin named by
#                           AGENT_BROWSER_STUB_LOGIN_REDIRECT=head|baseline,
#                           and "/moved" when that url contains NAVSTEP
#   eval <js>               the freeze script prints "frozen" (exit 1 when
#                           AGENT_BROWSER_STUB_FAIL_FREEZE=1); anything else
#                           prints a fixed stub build sha
#   --json diff screenshot --baseline <f> -o <out>
#                           prints the real 0.33.0 JSON shape. A settle check
#                           (<out> is the script's *.settle.png) matches unless
#                           AGENT_BROWSER_STUB_UNSETTLED=1. A base-vs-head
#                           diff matches unless the baseline path contains
#                           CHANGED (4.5%, writes <out>) or MISMATCH
#                           (dimensionMismatch); a missing baseline is exit 1.
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

SESSION=""
if [ "\$1" = "--session" ]; then SESSION="\$2"; shift 2; fi
if [ "\${1:-}" = "--json" ]; then shift; fi
VERB="\${1:-}"
shift || true

case "\$VERB" in
  state)
    exit 0
    ;;
  open)
    printf '%s' "\${1:-}" >"$WORK/loc-\$SESSION"
    case "\${1:-}" in
      *FAIL-OPEN*) echo "stub: navigation failed" >&2; exit 1 ;;
      https://baseline.test*)
        if [ "\${AGENT_BROWSER_STUB_FAIL_BASELINE:-}" = 1 ]; then
          echo "stub: baseline unreachable" >&2; exit 1
        fi
        echo "✓ stub open"; exit 0 ;;
      *) echo "✓ stub open"; exit 0 ;;
    esac
    ;;
  eval)
    case "\${1:-}" in
      location.pathname)
        LOC="\$(cat "$WORK/loc-\$SESSION")"
        case "\${AGENT_BROWSER_STUB_LOGIN_REDIRECT:-}:\$LOC" in
          baseline:https://baseline.test*|head:https://example.test*) echo '"/login"'; exit 0 ;;
        esac
        case "\$LOC" in
          *NAVSTEP*) echo '"/moved"' ;;
          *) LOC="/\$(printf '%s' "\$LOC" | cut -d/ -f4-)"; echo "\"\${LOC%%[?#]*}\"" ;;
        esac ;;
      *smoke-contact-sheet-freeze*)
        if [ "\${AGENT_BROWSER_STUB_FAIL_FREEZE:-}" = 1 ]; then
          echo "stub: eval failed" >&2; exit 1
        fi
        echo '"frozen"' ;;
      *) echo "stub-build-sha-123" ;;
    esac
    exit 0
    ;;
  diff)
    BASELINE="\$3"; OUT="\$5"
    [ -s "\$BASELINE" ] || { echo '{"success":false,"data":null,"error":"Failed to read baseline: No such file or directory (os error 2)"}'; exit 1; }
    MATCH=true; PCT=0.0; PIXELS=0; MISMATCH=null
    case "\$OUT:\$BASELINE" in
      *.settle.png:*) [ "\${AGENT_BROWSER_STUB_UNSETTLED:-}" = 1 ] && { MATCH=false; PCT=1.0; PIXELS=11520; } ;;
      *MISMATCH*-base.png) MATCH=false; PCT=100.0; PIXELS=1152000
        MISMATCH='{"actual":{"height":844,"width":390},"expected":{"height":900,"width":1280}}' ;;
      *CHANGED*-base.png) MATCH=false; PCT=4.5; PIXELS=51840 ;;
    esac
    [ "\$MATCH" = true ] || printf '%s' "$TINY_PNG_B64" | base64 -d >"\$OUT"
    echo "{\"success\":true,\"data\":{\"diffPath\":\"\$OUT\",\"differentPixels\":\$PIXELS,\"dimensionMismatch\":\$MISMATCH,\"match\":\$MATCH,\"mismatchPercentage\":\$PCT,\"totalPixels\":1152000},\"error\":null}"
    exit 0
    ;;
  set)
    if [ "\${AGENT_BROWSER_STUB_FAIL_GRID_VIEWPORT:-}" = 1 ] &&
       [[ "\$SESSION" == *-grid ]] && [ "\${1:-}" = "viewport" ]; then
      echo "stub: grid viewport failed" >&2
      exit 1
    fi
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
jq -e '.screens[0].freshNavigation == true and .screens[1].freshNavigation == true' \
  "$RUN1/contact-sheet/manifest.json" >/dev/null \
  || { echo "happy path: expected freshNavigation:true recorded on every screen" >&2; exit 1; }

[ -s "$RUN1/contact-sheet/shots/00-home-1280.png" ] || { echo "happy path: missing desktop shot" >&2; exit 1; }
[ -s "$RUN1/contact-sheet/shots/00-home-390.png" ] || { echo "happy path: missing mobile shot" >&2; exit 1; }
[ -s "$RUN1/contact-sheet/sheet.png" ] || { echo "happy path: sheet.png missing or empty" >&2; exit 1; }
grep -q '<img class="desktop" src="shots/00-home-1280.png">' "$RUN1/contact-sheet/grid.html" \
  || { echo "happy path: grid.html does not reference the desktop shot" >&2; exit 1; }

# A fresh session per screen, never one shared for the whole run — plus one
# for the preflight auth-state probe and one for the final grid render: 2
# screens here means 4 distinct sessions total.
SESSIONS_USED="$(grep -o '^--session [^ ]*' "$STUB_LOG" | sort -u | wc -l)"
[ "$SESSIONS_USED" -eq 4 ] || { echo "happy path: expected 4 distinct sessions (preflight + 2 screens + grid), saw $SESSIONS_USED" >&2; exit 1; }
# Every session used must also be closed, not just left open at run end.
CLOSED_SESSIONS="$(awk '$1=="--session" && $3=="close"{print $2}' "$STUB_LOG" | sort -u | wc -l)"
[ "$CLOSED_SESSIONS" -eq "$SESSIONS_USED" ] \
  || { echo "happy path: expected all $SESSIONS_USED sessions closed, saw $CLOSED_SESSIONS close calls" >&2; exit 1; }

# state load must run before the first open (auth lease, never a fresh login).
FIRST_STATE_LINE="$(grep -n ' state load ' "$STUB_LOG" | head -1 | cut -d: -f1)"
FIRST_OPEN_LINE="$(grep -n ' open ' "$STUB_LOG" | head -1 | cut -d: -f1)"
[ -n "$FIRST_STATE_LINE" ] && [ -n "$FIRST_OPEN_LINE" ] && [ "$FIRST_STATE_LINE" -lt "$FIRST_OPEN_LINE" ] \
  || { echo "happy path: expected state load before the first open" >&2; exit 1; }

# The contact-sheet grid uses a cold session. It must navigate to its local
# page before setting a viewport, and the viewport must precede its screenshot.
GRID_SESSION="$(awk '$1=="--session" && $3=="open" && $4 ~ /^file:/{print $2}' "$STUB_LOG")"
[ -n "$GRID_SESSION" ] || { echo "happy path: grid session never opened the local sheet" >&2; exit 1; }
GRID_OPEN_LINE="$(grep -n -- "^--session $GRID_SESSION open file:" "$STUB_LOG" | head -1 | cut -d: -f1)"
GRID_VIEWPORT_LINE="$(grep -n -- "^--session $GRID_SESSION set viewport 1750 1000$" "$STUB_LOG" | head -1 | cut -d: -f1)"
GRID_SHOT_LINE="$(grep -n -- "^--session $GRID_SESSION screenshot --full .*sheet.png$" "$STUB_LOG" | head -1 | cut -d: -f1)"
[ -n "$GRID_OPEN_LINE" ] && [ -n "$GRID_VIEWPORT_LINE" ] && [ -n "$GRID_SHOT_LINE" ] &&
  [ "$GRID_OPEN_LINE" -lt "$GRID_VIEWPORT_LINE" ] && [ "$GRID_VIEWPORT_LINE" -lt "$GRID_SHOT_LINE" ] \
  || { echo "happy path: grid must open, set viewport, then screenshot in its cold session" >&2; exit 1; }

# The graded image is a VIEWPORT capture taken frozen and settled: per width,
# viewport -> freeze -> `screenshot <file>` (no --full) -> settle check against
# that same file. The full-page image is a separate, clearly named context
# file taken afterwards, and the manifest says which is which.
for WIDTH in "1280 900" "390 844"; do
  W="${WIDTH% *}"
  SHOT="$RUN1/contact-sheet/shots/00-home-$W.png"
  VIEWPORT_LINE="$(grep -n -- "scr00 set viewport $WIDTH\$" "$STUB_LOG" | head -1 | cut -d: -f1)"
  FREEZE_LINE="$(grep -n -- 'scr00 eval .*smoke-contact-sheet-freeze' "$STUB_LOG" | awk -F: -v v="$VIEWPORT_LINE" '$1>v{print $1; exit}')"
  SHOT_LINE="$(grep -n -- "scr00 screenshot $SHOT\$" "$STUB_LOG" | head -1 | cut -d: -f1)"
  SETTLE_LINE="$(grep -n -- "scr00 --json diff screenshot --baseline $SHOT " "$STUB_LOG" | head -1 | cut -d: -f1)"
  FULL_LINE="$(grep -n -- "scr00 screenshot --full .*00-home-$W-full.png\$" "$STUB_LOG" | head -1 | cut -d: -f1)"
  [ -n "$VIEWPORT_LINE" ] && [ -n "$FREEZE_LINE" ] && [ -n "$SHOT_LINE" ] && [ -n "$SETTLE_LINE" ] && [ -n "$FULL_LINE" ] &&
    [ "$VIEWPORT_LINE" -lt "$FREEZE_LINE" ] && [ "$FREEZE_LINE" -lt "$SHOT_LINE" ] &&
    [ "$SHOT_LINE" -lt "$SETTLE_LINE" ] && [ "$SETTLE_LINE" -lt "$FULL_LINE" ] \
    || { echo "happy path ($W): expected viewport, freeze, viewport screenshot, settle check, then the full-page context shot" >&2; exit 1; }
done
grep -q -- ' screenshot --full .*00-home-\(1280\|390\)\.png$' "$STUB_LOG" \
  && { echo "happy path: the graded file must never be a --full capture" >&2; exit 1; }
jq -e '.schemaVersion == 2 and .capture.graded == "viewport" and .capture.animationsFrozen == true and
       ([.screens[] | .desktop, .mobile] | all(.graded == "viewport" and .settled == true and
         (.fullPage | endswith("-full.png")) and (.file | endswith("-full.png") | not)))' \
  "$RUN1/contact-sheet/manifest.json" >/dev/null \
  || { echo "happy path: manifest must name the viewport capture as graded and the full-page file as context" >&2; exit 1; }
# No baseline given: no baseline is touched and no diff key exists anywhere.
jq -e '(has("baselineUrl") | not) and (.totals | has("diff") | not) and
       ([.screens[] | .desktop, .mobile] | all(has("diff") | not))' "$RUN1/contact-sheet/manifest.json" >/dev/null \
  || { echo "happy path: no baseline given, so the manifest must carry no diff fields" >&2; exit 1; }
echo "$RESULT" | jq -e 'has("diff") | not' >/dev/null \
  || { echo "happy path: no baseline given, so the result line must carry no diff counts" >&2; exit 1; }
grep -q -- '-base[0-9]\|-base\.png\|-basepreflight' "$STUB_LOG" \
  && { echo "happy path: no baseline given, so no baseline session or file may appear" >&2; exit 1; }

# the click step's text= shorthand must translate to find text ... click, not
# a raw `click "text=..."` call agent-browser does not understand.
grep -q ' find text Get started click' "$STUB_LOG" \
  || { echo "happy path: expected the text= step to use find text ... click" >&2; exit 1; }
grep -q ' click text=' "$STUB_LOG" \
  && { echo "happy path: text= step must never be passed straight to click" >&2; exit 1; }

echo "1/17 happy path ok"

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

echo "2/17 failed screen stays a placeholder ok"

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

echo "3/17 8-screen cap ok"

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

echo "4/17 missing auth state refuses before touching the browser ok"

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

echo "5/17 empty/missing shots file refuses ok"

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

echo "6/17 auth state inside the run dir refuses ok"

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

echo "7/17 auth state under the shared workgroup tree refuses ok"

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
grep -q ' eval (document' "$STUB_LOG" \
  && { echo "source sha: must not sniff the page for a build sha when the caller already supplied one" >&2; exit 1; }

echo "8/17 caller-supplied source sha rides through to the manifest ok"

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

echo "9/17 malformed source sha is refused, never written into the manifest ok"

# --- 10. Every screen gets its own fresh session (state load THEN open, in
# that session, before any other screen's session is ever touched) — and the
# per-screen pattern is identical regardless of which order the screens are
# listed in. This is the regression for xzo-pr-pr1792-cac47f6f1153-20260912T113129Z,
# where one shared session let an earlier screen's open nav drawer bleed into
# every later 390px shot and the shadow critic graded all three BROKEN on
# that capture artifact alone.
check_fresh_nav() {
  local run_dir="$1" home_path="$2" pricing_path="$3"
  local home_url="https://example.test${home_path}" pricing_url="https://example.test${pricing_path}"

  : >"$STUB_LOG"
  local result
  result="$(bash "$SCRIPT" "$run_dir" "https://example.test" "$AUTH_STATE")"
  echo "$result" | jq -e '.ok == true and .captured == 2' >/dev/null \
    || { echo "fresh nav ($run_dir): unexpected result: $result" >&2; exit 1; }

  # Exactly one session ever called `open` with each screen's URL.
  local home_session pricing_session
  home_session="$(awk -v u="$home_url" '$1=="--session" && $3=="open" && $4==u{print $2}' "$STUB_LOG")"
  pricing_session="$(awk -v u="$pricing_url" '$1=="--session" && $3=="open" && $4==u{print $2}' "$STUB_LOG")"
  [ -n "$home_session" ] || { echo "fresh nav ($run_dir): no session opened $home_url" >&2; exit 1; }
  [ -n "$pricing_session" ] || { echo "fresh nav ($run_dir): no session opened $pricing_url" >&2; exit 1; }
  [ "$home_session" != "$pricing_session" ] \
    || { echo "fresh nav ($run_dir): home and pricing shared one session ($home_session) — this is the pr1792 bleed" >&2; exit 1; }

  # Each screen's own session did a `state load` of the SAME saved auth file
  # BEFORE its `open` — a fresh context loading the existing state, not a
  # fresh login.
  for pair in "$home_session:$home_url" "$pricing_session:$pricing_url"; do
    local sess="${pair%%:*}" url="${pair#*:}"
    local state_line open_line
    state_line="$(grep -n -- "^--session $sess state load $AUTH_STATE\$" "$STUB_LOG" | head -1 | cut -d: -f1)"
    open_line="$(grep -n -- "^--session $sess open $url\$" "$STUB_LOG" | head -1 | cut -d: -f1)"
    [ -n "$state_line" ] || { echo "fresh nav ($run_dir): session $sess never did state load" >&2; exit 1; }
    [ -n "$open_line" ] || { echo "fresh nav ($run_dir): session $sess never opened $url" >&2; exit 1; }
    [ "$state_line" -lt "$open_line" ] \
      || { echo "fresh nav ($run_dir): session $sess opened before loading state" >&2; exit 1; }
    grep -q -- "^--session $sess close\$" "$STUB_LOG" \
      || { echo "fresh nav ($run_dir): session $sess was never closed" >&2; exit 1; }
  done

  jq -e '[.screens[].freshNavigation] == [true, true]' "$run_dir/contact-sheet/manifest.json" >/dev/null \
    || { echo "fresh nav ($run_dir): expected freshNavigation:true on both screens" >&2; exit 1; }
}

RUN10="$(fresh_run_dir fresh-nav-order-a)"
cat >"$RUN10/contact-sheet/shots.json" <<'JSON'
[
  { "name": "home", "path": "/" },
  { "name": "pricing", "path": "/pricing" }
]
JSON
check_fresh_nav "$RUN10" "/" "/pricing"

# Same two screens, reversed order: the per-screen pattern above must hold
# identically — no special-casing of "the first screen" that a shared
# opening session would tempt (e.g. reusing whatever session happened to be
# opened outside the loop only for index 0).
RUN10B="$(fresh_run_dir fresh-nav-order-b)"
cat >"$RUN10B/contact-sheet/shots.json" <<'JSON'
[
  { "name": "pricing", "path": "/pricing" },
  { "name": "home", "path": "/" }
]
JSON
check_fresh_nav "$RUN10B" "/" "/pricing"

echo "10/17 fresh session per screen, order-independent ok"

# --- 11. A grid viewport failure is visible; it must never post a clipped sheet
RUN11="$(fresh_run_dir grid-viewport-failure)"
cat >"$RUN11/contact-sheet/shots.json" <<'JSON'
[{ "name": "home", "path": "/" }]
JSON

: >"$STUB_LOG"
set +e
RESULT="$(AGENT_BROWSER_STUB_FAIL_GRID_VIEWPORT=1 bash "$SCRIPT" "$RUN11" "https://example.test" "$AUTH_STATE" 2>&1)"
EC=$?
set -e
[ "$EC" -eq 1 ] || { echo "grid viewport: expected exit 1, got $EC" >&2; exit 1; }
echo "$RESULT" | jq -e '.ok == false and (.error | test("grid viewport"))' >/dev/null \
  || { echo "grid viewport: expected a visible viewport failure: $RESULT" >&2; exit 1; }
[ ! -e "$RUN11/contact-sheet/sheet.png" ] \
  || { echo "grid viewport: must not emit a sheet after viewport failure" >&2; exit 1; }
grep -q -- ' screenshot --full .*sheet.png$' "$STUB_LOG" \
  && { echo "grid viewport: must not screenshot a grid after viewport failure" >&2; exit 1; }

echo "11/17 grid viewport failure is visible, no clipped sheet emitted"

# --- 12. A page that never settles is captured but flagged, never silently graded
RUN12="$(fresh_run_dir unsettled)"
cat >"$RUN12/contact-sheet/shots.json" <<'JSON'
[{ "name": "home", "path": "/" }]
JSON

: >"$STUB_LOG"
RESULT="$(AGENT_BROWSER_STUB_UNSETTLED=1 bash "$SCRIPT" "$RUN12" "https://example.test" "$AUTH_STATE")"
echo "$RESULT" | jq -e '.ok == true and .captured == 1' >/dev/null || { echo "unsettled: unexpected result: $RESULT" >&2; exit 1; }
jq -e '.screens[0].status == "captured" and .screens[0].desktop.settled == false and .screens[0].mobile.settled == false' \
  "$RUN12/contact-sheet/manifest.json" >/dev/null || { echo "unsettled: expected settled:false on both widths" >&2; exit 1; }
ATTEMPTS="$(grep -c -- ' screenshot .*00-home-390\.png$' "$STUB_LOG")"
[ "$ATTEMPTS" -eq 4 ] || { echo "unsettled: expected 4 bounded capture attempts at 390, saw $ATTEMPTS" >&2; exit 1; }
grep -q 'badge-failed">unsettled<' "$RUN12/contact-sheet/grid.html" \
  || { echo "unsettled: expected an unsettled badge on the tile" >&2; exit 1; }

# A freeze that cannot be applied fails the capture: an unfrozen image is
# never emitted as graded evidence.
RUN12B="$(fresh_run_dir freeze-failure)"
cp "$RUN12/contact-sheet/shots.json" "$RUN12B/contact-sheet/shots.json"
: >"$STUB_LOG"
set +e
RESULT="$(AGENT_BROWSER_STUB_FAIL_FREEZE=1 bash "$SCRIPT" "$RUN12B" "https://example.test" "$AUTH_STATE" "abcdef0123456789abcdef0123456789abcdef01")"
EC=$?
set -e
[ "$EC" -eq 1 ] || { echo "freeze failure: expected exit 1 (zero screens captured), got $EC" >&2; exit 1; }
jq -e '.screens[0].status == "failed" and (.screens[0].desktop.reason | test("freeze"))' \
  "$RUN12B/contact-sheet/manifest.json" >/dev/null || { echo "freeze failure: expected a freeze reason" >&2; exit 1; }
grep -q -- ' screenshot .*00-home' "$STUB_LOG" && { echo "freeze failure: must not screenshot an unfrozen page" >&2; exit 1; }

echo "12/17 unsettled page is flagged; unfrozen page is never captured"

# --- 13. Baseline diff: identical recipe, read-only, per-width diff, ordered sheet
RUN13="$(fresh_run_dir baseline)"
cat >"$RUN13/contact-sheet/shots.json" <<'JSON'
[
  { "name": "same", "path": "/same" },
  { "name": "CHANGED-screen", "path": "/changed", "steps": ["click text=Pricing", "wait 200"] },
  { "name": "MISMATCH-screen", "path": "/mismatch" }
]
JSON
BASE_AUTH="$WORK/baseline-auth-state.json"
printf '{"cookies":[],"origins":[]}' >"$BASE_AUTH"
FROZEN_SHA="abcdef0123456789abcdef0123456789abcdef01"

: >"$STUB_LOG"
RESULT="$(bash "$SCRIPT" "$RUN13" "https://example.test" "$AUTH_STATE" "" "https://baseline.test/" "$BASE_AUTH")"
echo "$RESULT" | jq -e '.ok == true and .captured == 3 and .diff == {changed:2, unchanged:2, failed:2}' >/dev/null \
  || { echo "baseline: unexpected result: $RESULT" >&2; exit 1; }
M13="$RUN13/contact-sheet/manifest.json"
jq -e '.baselineUrl == "https://baseline.test/" and .totals.diff == {changed:2, unchanged:2, failed:2} and
       [.screens[].name] == ["same", "CHANGED-screen", "MISMATCH-screen"]' "$M13" >/dev/null \
  || { echo "baseline: manifest must record the baseline url, diff totals, and keep shots.json order" >&2; exit 1; }
jq -e '.screens[0].desktop.diff == {status:"unchanged", pct:0, differentPixels:0, image:null, baseline:"shots/00-same-1280-base.png"}' \
  "$M13" >/dev/null || { echo "baseline: unchanged screen recorded wrong: $(jq -c '.screens[0].desktop.diff' "$M13")" >&2; exit 1; }
jq -e '.screens[1].mobile.diff == {status:"changed", pct:4.5, differentPixels:51840,
        image:"shots/01-CHANGED-screen-390-diff.png", baseline:"shots/01-CHANGED-screen-390-base.png"}' \
  "$M13" >/dev/null || { echo "baseline: changed screen recorded wrong: $(jq -c '.screens[1].mobile.diff' "$M13")" >&2; exit 1; }
[ -s "$RUN13/contact-sheet/shots/01-CHANGED-screen-390-diff.png" ] && [ -s "$RUN13/contact-sheet/shots/01-CHANGED-screen-390-base.png" ] \
  || { echo "baseline: expected the diff and baseline images on disk" >&2; exit 1; }
jq -e '.screens[2].desktop.captured == true and .screens[2].desktop.diff.status == "failed" and
       (.screens[2].desktop.diff.reason | test("dimension mismatch"))' "$M13" >/dev/null \
  || { echo "baseline: a dimension mismatch must be a failed diff, never a 100% change" >&2; exit 1; }
jq -e '.buildSha == "stub-build-sha-123"' "$M13" >/dev/null \
  || { echo "baseline: an empty source-sha argument must still fall back to the head page sniff" >&2; exit 1; }

# Sheet order: changed first, then diff-failed, then unchanged.
ORDER="$(grep -o '<div class="label">[^<]*' "$RUN13/contact-sheet/grid.html" | sed 's/.*>//' | tr '\n' ' ')"
[ "$ORDER" = "CHANGED-screen MISMATCH-screen same " ] || { echo "baseline: sheet order was: $ORDER" >&2; exit 1; }
grep -q 'badge-changed">changed 4.50%<' "$RUN13/contact-sheet/grid.html" &&
  grep -q 'badge-unchanged">unchanged<' "$RUN13/contact-sheet/grid.html" &&
  grep -q 'badge-failed">diff failed: dimension mismatch' "$RUN13/contact-sheet/grid.html" &&
  grep -q '<img class="mobile diff" src="shots/01-CHANGED-screen-390-diff.png">' "$RUN13/contact-sheet/grid.html" \
  || { echo "baseline: expected changed/unchanged/failed badges and the diff overlay in the grid" >&2; exit 1; }

# Identical recipe: strip the session name, the origin, the auth path and the
# -base file suffix, and the baseline session's command list must equal the
# head's minus the head-only commands (build-sha sniff, base-vs-head diff,
# full-page context shot).
normalize() {
  grep -- "^--session [^ ]*-$1 " "$STUB_LOG" | cut -d' ' -f3- |
    sed -e 's#https://[a-z]*\.test#ORIGIN#' -e "s#$AUTH_STATE\|$BASE_AUTH#AUTH#" -e 's#-base\.png#.png#g'
}
HEAD_RECIPE="$(normalize scr01 | grep -v -- '^eval (document\|^screenshot --full \| -o [^ ]*-diff\.png$')"
BASE_RECIPE="$(normalize base01)"
[ -n "$BASE_RECIPE" ] && [ "$HEAD_RECIPE" = "$BASE_RECIPE" ] || {
  echo "baseline: head and baseline recipes differ" >&2
  diff <(printf '%s\n' "$HEAD_RECIPE") <(printf '%s\n' "$BASE_RECIPE") >&2 || true
  exit 1
}
# Read-only: a baseline session runs only these verbs, never a --full shot or
# a build-sha sniff, and loads the baseline auth state, never the head's.
BASE_VERBS="$(grep -- '^--session [^ ]*-base[0-9]* ' "$STUB_LOG" | cut -d' ' -f3- | sed 's/^--json //' | cut -d' ' -f1 | sort -u | tr '\n' ' ')"
[ "$BASE_VERBS" = "close diff eval find open screenshot set state wait " ] \
  || { echo "baseline: unexpected verbs in a baseline session: $BASE_VERBS" >&2; exit 1; }
grep -- '^--session [^ ]*-base[0-9]* ' "$STUB_LOG" | grep -q -- '--full\|eval (document' \
  && { echo "baseline: baseline sessions must never take a full-page shot or sniff a sha" >&2; exit 1; }
grep -q -- "-base[0-9]* state load $AUTH_STATE\$" "$STUB_LOG" \
  && { echo "baseline: baseline sessions must load the baseline auth state" >&2; exit 1; }
grep -q -- 'baseline-auth-state\|auth-state.json' "$M13" "$RUN13/contact-sheet/grid.html" \
  && { echo "baseline: no auth state path may reach the shared evidence" >&2; exit 1; }
SESSIONS_USED="$(grep -o '^--session [^ ]*' "$STUB_LOG" | sort -u | wc -l)"
CLOSED_SESSIONS="$(awk '$1=="--session" && $3=="close"{print $2}' "$STUB_LOG" | sort -u | wc -l)"
[ "$SESSIONS_USED" -eq 9 ] && [ "$CLOSED_SESSIONS" -eq 9 ] \
  || { echo "baseline: expected 9 sessions (2 preflights + 3 base + 3 head + grid) all closed, saw $SESSIONS_USED/$CLOSED_SESSIONS" >&2; exit 1; }

echo "13/17 baseline diff: identical read-only recipe, per-width diff, ordered sheet ok"

# --- 14. A baseline that cannot be captured degrades to "no diff", head untouched
RUN14="$(fresh_run_dir baseline-down)"
cat >"$RUN14/contact-sheet/shots.json" <<'JSON'
[{ "name": "home", "path": "/" }]
JSON
RESULT="$(AGENT_BROWSER_STUB_FAIL_BASELINE=1 bash "$SCRIPT" "$RUN14" "https://example.test" "$AUTH_STATE" "$FROZEN_SHA" "https://baseline.test")"
echo "$RESULT" | jq -e '.ok == true and .captured == 1 and .failed == 0 and .diff == {changed:0, unchanged:0, failed:2}' >/dev/null \
  || { echo "baseline down: head capture must be unaffected: $RESULT" >&2; exit 1; }
jq -e '.screens[0].status == "captured" and .screens[0].desktop.captured == true and
       .screens[0].desktop.diff.status == "failed" and (.screens[0].desktop.diff.reason | test("baseline: open .*unreachable"))' \
  "$RUN14/contact-sheet/manifest.json" >/dev/null || { echo "baseline down: expected a recorded reason" >&2; exit 1; }
[ ! -e "$RUN14/contact-sheet/shots/00-home-1280-base.png" ] || { echo "baseline down: no baseline image expected" >&2; exit 1; }

echo "14/17 baseline failure degrades to no diff with a reason ok"

# --- 15. Baseline auth state obeys the same placement refusal ------------------
RUN15="$(fresh_run_dir baseline-auth-in-rundir)"
cp "$RUN14/contact-sheet/shots.json" "$RUN15/contact-sheet/shots.json"
printf '{"cookies":[],"origins":[]}' >"$RUN15/contact-sheet/base-auth.json"
: >"$STUB_LOG"
set +e
RESULT="$(bash "$SCRIPT" "$RUN15" "https://example.test" "$AUTH_STATE" "" "https://baseline.test" "$RUN15/contact-sheet/base-auth.json" 2>&1)"
EC=$?
set -e
[ "$EC" -eq 2 ] || { echo "baseline auth in run dir: expected exit 2, got $EC" >&2; exit 1; }
[ ! -s "$STUB_LOG" ] || { echo "baseline auth in run dir: agent-browser must never be invoked" >&2; exit 1; }
set +e
RESULT="$(bash "$SCRIPT" "$RUN15" "https://example.test" "$AUTH_STATE" "" "ftp://baseline.test" 2>&1)"
EC=$?
set -e
[ "$EC" -eq 2 ] || { echo "bad baseline url: expected exit 2, got $EC" >&2; exit 1; }

echo "15/17 baseline auth state placement and url are validated ok"

# --- 16. A baseline bounced to a login route is a FAILED diff, never `changed`
RUN16="$(fresh_run_dir baseline-login-redirect)"
cat >"$RUN16/contact-sheet/shots.json" <<'JSON'
[{ "name": "CHANGED-settings", "path": "/settings/?tab=pricing" }]
JSON
: >"$STUB_LOG"
RESULT="$(AGENT_BROWSER_STUB_LOGIN_REDIRECT=baseline bash "$SCRIPT" "$RUN16" "https://example.test" "$AUTH_STATE" "$FROZEN_SHA" "https://baseline.test")"
echo "$RESULT" | jq -e '.ok == true and .captured == 1 and .diff == {changed:0, unchanged:0, failed:2}' >/dev/null \
  || { echo "baseline login redirect: unexpected result: $RESULT" >&2; exit 1; }
jq -e '[.screens[0].desktop, .screens[0].mobile] | all(.captured == true and .diff.status == "failed" and
        (.diff.reason | test("baseline: landed on /login, expected /settings ")))' \
  "$RUN16/contact-sheet/manifest.json" >/dev/null \
  || { echo "baseline login redirect: expected failed diffs naming both paths: $(jq -c '.screens[0].desktop' "$RUN16/contact-sheet/manifest.json")" >&2; exit 1; }
ls "$RUN16/contact-sheet/shots/" | grep -q -- '-base\.png\|-diff\.png' \
  && { echo "baseline login redirect: no login-page baseline or diff image may be kept" >&2; exit 1; }
grep -q -- ' -o [^ ]*-diff\.png$' "$STUB_LOG" \
  && { echo "baseline login redirect: must not diff against a redirected baseline" >&2; exit 1; }

echo "16/17 redirected baseline is a failed diff with a reason, never changed ok"

# --- 17. The head obeys the same rule; finalPath declares an intended navigation
RUN17="$(fresh_run_dir head-login-redirect)"
cp "$RUN16/contact-sheet/shots.json" "$RUN17/contact-sheet/shots.json"
set +e
RESULT="$(AGENT_BROWSER_STUB_LOGIN_REDIRECT=head bash "$SCRIPT" "$RUN17" "https://example.test" "$AUTH_STATE" "$FROZEN_SHA" "https://baseline.test")"
EC=$?
set -e
[ "$EC" -eq 1 ] || { echo "head login redirect: expected exit 1 (zero screens captured), got $EC" >&2; exit 1; }
jq -e '.screens[0].status == "failed" and .screens[0].desktop.file == null and
       (.screens[0].desktop.reason | test("landed on /login, expected /settings ")) and
       .screens[0].desktop.diff == {status:"failed", reason:"head not captured"}' \
  "$RUN17/contact-sheet/manifest.json" >/dev/null || { echo "head login redirect: expected a failed head capture with both paths named" >&2; exit 1; }
[ ! -e "$RUN17/contact-sheet/shots/00-CHANGED-settings-1280.png" ] \
  || { echo "head login redirect: a login-page image must not be kept as the graded file" >&2; exit 1; }

RUN17B="$(fresh_run_dir final-path)"
cat >"$RUN17B/contact-sheet/shots.json" <<'JSON'
[
  { "name": "declared", "path": "/NAVSTEP", "steps": ["click text=Details"], "finalPath": "/moved/" },
  { "name": "undeclared", "path": "/NAVSTEP", "steps": ["click text=Details"] }
]
JSON
RESULT="$(bash "$SCRIPT" "$RUN17B" "https://example.test" "$AUTH_STATE" "$FROZEN_SHA")"
jq -e '.screens[0].status == "captured" and .screens[1].status == "failed" and
       (.screens[1].mobile.reason | test("landed on /moved, expected /NAVSTEP "))' \
  "$RUN17B/contact-sheet/manifest.json" >/dev/null || { echo "finalPath: a declared navigation must capture, an undeclared one must fail" >&2; exit 1; }

echo "17/17 redirected head fails with a reason; finalPath declares an intended navigation ok"

echo "smoke contact sheet tests passed"
