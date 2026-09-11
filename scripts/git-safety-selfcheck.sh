#!/usr/bin/env bash
# Self-check for scripts/git-safety.sh, modeled on
# scripts/health-sentinel-selfcheck.sh: builds real fixture repos (a
# nanoclaw checkout + a groups checkout + its bare remote), runs the SHIPPED
# script against them with only notify-owner.ts stubbed, and asserts on the
# repo/remote state afterwards — never a re-implementation of the script's
# logic. One check per finding in GitHub issue #618 ("git-safety.sh: fix
# before installing the nightly timer").
#
#   bash scripts/git-safety-selfcheck.sh

set -uo pipefail

REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/git-safety.sh"
FAILED=0
ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n     %s\n' "$1" "$2"; FAILED=1; }

# ── fixture builder ──────────────────────────────────────────────────────
# Each case gets its own throwaway HOME, NANOCLAW_DIR (with a nanoclaw repo
# and a groups repo cloned from a local bare remote), snapshot dir, and a
# stubbed notify-owner.ts / tsx so no real DM is ever attempted.
FIX=""
G=""       # groups worktree
REMOTE=""  # groups bare remote
HOME2=""
BACKUPS=""
NCDIR=""

# #666 review P3-10: every new_fixture() call overwrote FIX with a fresh
# mktemp -d, but only the LAST one was ever removed (the old convention
# left every earlier run's fixture on disk) — ~57 leaked temp dirs per full
# run of this script, each containing planted fake secrets. Track every one
# and remove them all on exit, matching the pattern already fixed the same
# way in scripts/wiki-pre-push-hook-selfcheck.sh.
FIXTURE_DIRS=()
cleanup_fixtures() {
  local dir
  for dir in "${FIXTURE_DIRS[@]}"; do
    rm -rf "$dir"
  done
}
trap cleanup_fixtures EXIT INT TERM

new_fixture() {
  FIX=$(mktemp -d)
  FIXTURE_DIRS+=("$FIX")
  HOME2="$FIX/home"
  BACKUPS="$FIX/home/backups"
  NCDIR="$FIX/nanoclaw"
  REMOTE="$FIX/remote-groups.git"
  mkdir -p "$HOME2"

  git init --bare -q "$REMOTE"

  mkdir -p "$NCDIR"
  git init -q "$NCDIR"
  git -C "$NCDIR" config user.email test@example.com
  git -C "$NCDIR" config user.name test
  echo hi > "$NCDIR/README.md"
  git -C "$NCDIR" add README.md
  git -C "$NCDIR" commit -qm init >/dev/null

  git clone -q "$REMOTE" "$NCDIR/groups" 2>/dev/null
  G="$NCDIR/groups"
  git -C "$G" config user.email test@example.com
  git -C "$G" config user.name test
  mkdir -p "$G/foo"
  echo '{"a":1}' > "$G/foo/container.json"
  git -C "$G" add .
  git -C "$G" commit -qm init >/dev/null
  git -C "$G" push -q origin HEAD:main

  mkdir -p "$NCDIR/scripts" "$NCDIR/node_modules/.bin"
  echo 'console.log("stub")' > "$NCDIR/scripts/notify-owner.ts"
  DM_LOG="$FIX/dm.log"
  : > "$DM_LOG"
  cat > "$NCDIR/node_modules/.bin/tsx" <<EOF
#!/bin/bash
echo "\$*" >> "$DM_LOG"
exit 2
EOF
  chmod +x "$NCDIR/node_modules/.bin/tsx"
}

run_safety() { # extra env assignments as "$@", e.g. run_safety GIT_SAFETY_GROUPS_COMMIT=dry
  OUT=$(env "$@" NANOCLAW_DIR="$NCDIR" GIT_SAFETY_DIR="$BACKUPS" HOME="$HOME2" bash "$REAL" 2>&1)
  RC=$?
}

latest_snapshot() { ls -td "$BACKUPS"/*/ 2>/dev/null | head -1; }

# unit-alert-dm.sh's keyword grep misses most FAILURES wording ("failed"
# alone isn't a keyword), so on a FAILURES exit it falls back to the LAST
# non-empty line of the unit's recent output for its DM. That line must be
# an actual failure reason, not the "whatever did succeed" context line
# that used to print after it (#658 review).
assert_failure_reason_is_last() { # label, $OUT
  local label="$1" out="$2" tail_line
  tail_line=$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1)
  case "$tail_line" in
    *"Whatever did succeed"*) bad "$label: context line, not the failure, is last" "tail=[$tail_line]" ;;
    *) ok "$label: the failure reason is the last line (what unit-alert-dm.sh's DM would show)" ;;
  esac
}

# ═══ 1. Phase 2 never touches groups' HEAD, index, or working tree ═════════
new_fixture
BEFORE_HEAD=$(git -C "$G" rev-parse HEAD)
echo '{"a":2}' > "$G/foo/container.json"
BEFORE_STATUS=$(git -C "$G" status --porcelain)
run_safety
AFTER_HEAD=$(git -C "$G" rev-parse HEAD)
AFTER_STATUS=$(git -C "$G" status --porcelain)
[ "$BEFORE_HEAD" = "$AFTER_HEAD" ] && ok "groups HEAD untouched by phase 2" \
  || bad "groups HEAD moved" "before=$BEFORE_HEAD after=$AFTER_HEAD"
[ "$BEFORE_STATUS" = "$AFTER_STATUS" ] && ok "groups working tree/index untouched (still shows the pending edit)" \
  || bad "groups working tree/index changed" "before=[$BEFORE_STATUS] after=[$AFTER_STATUS]"
git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1 \
  && ok "a host-snapshot branch was created on the remote" \
  || bad "no host-snapshot branch was pushed" "$OUT"

# ═══ 2. Secret gate catches every #618 shape, case-insensitively ══════════
secret_case() { # label, secret-line
  new_fixture
  printf '{"a":2}\n%s\n' "$2" > "$G/foo/container.json"
  run_safety
  case "$OUT" in
    *"look like a secret"*) ok "secret gate: $1" ;;
    *) bad "secret gate missed: $1" "line=[$2] out=$OUT" ;;
  esac
  # Refused means nothing pushed.
  if git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1; then
    bad "secret gate: $1 — pushed anyway" "$(git --git-dir="$REMOTE" log --oneline host-snapshot)"
  fi
}
secret_case "slack app token (xapp-)"        'export SLACK_APP_TOKEN=xapp-1-A0123-4567890123-abcdefabcdefabcdefabcdefabcdef'
secret_case "github OAuth token (gho_)"      'export GITHUB_TOKEN=gho_16C7e42F292c6912E7710c838347Ae178B4a'
secret_case "github App token (ghs_)"        'export GITHUB_TOKEN=ghs_16C7e42F292c6912E7710c838347Ae178B4a'
secret_case "stripe live key (sk_live_)"     '"stripe_key": "sk_live_51H8xamplekeyvalueabc123"'
secret_case "google API key (AIza)"          'GOOGLE_API_KEY=AIzaSyD-FAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKE'
secret_case "access_token JSON key"          '"access_token": "ya29.a0AfakeAccessTokenValue1234567890"'
secret_case "uppercase PASSWORD key"         'PASSWORD: SuperSecretValue123'
secret_case "export X_API_KEY="              'export X_API_KEY=abcdefghijklmnop123456'
secret_case "postgres URI with credentials"  'DATABASE_URL: postgres://appuser:testpass123@example.com:5432/app'
secret_case "JWT"                            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_fakefakefakefakefakefake'
secret_case "YAML password: x"               'password: x'
secret_case "existing coverage: openai sk-"  'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx'
secret_case "existing coverage: AWS AKIA"    'aws_key = AKIAABCDEFGHIJKLMNOP'
secret_case "existing coverage: PEM header"  '-----BEGIN RSA PRIVATE KEY-----'

# color.ui / plain `git diff` without --no-color must not blind the scan —
# assert the gate still catches a secret when the repo has color.ui=always.
new_fixture
git -C "$G" config color.ui always
printf '{"a":2}\nexport API_KEY=abcdefghijklmnop123456\n' > "$G/foo/container.json"
run_safety
case "$OUT" in
  *"look like a secret"*) ok "secret gate not blinded by color.ui=always" ;;
  *) bad "color.ui=always defeated the scan" "$OUT" ;;
esac

# A non-UTF-8 byte on the same line as a real secret must not blind the
# scan either (#658 review). Under the installed unit's LANG=en_US.UTF-8,
# GNU grep classifies a diff containing an invalid UTF-8 byte as binary and
# `-c` reports 0/"binary file matches" instead of the line — verified
# empirically before the LC_ALL=C fix: this exact line counted 0 hits
# under LANG=en_US.UTF-8, 1 under LC_ALL=C. Force the vulnerable locale
# here (LC_ALL= clears any inherited override) so the test fails if the
# LC_ALL=C fix in lib/secret-scan.sh regresses.
new_fixture
printf '{"a":2}\n' > "$G/foo/container.json"
printf 'binary junk: \x80\x81\x82 export SLACK_APP_TOKEN=xapp-1-A0123-4567890123-abcdefabcdefabcdefabcdefabcdef\n' >> "$G/foo/container.json"
run_safety LANG=en_US.UTF-8 LC_ALL=
case "$OUT" in
  *"look like a secret"*) ok "secret gate not blinded by a non-UTF-8 byte on the same line" ;;
  *) bad "a non-UTF-8 byte blinded the scan to an adjacent real secret" "$OUT" ;;
esac
if git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1; then
  bad "non-UTF-8 line: pushed anyway" "$(git --git-dir="$REMOTE" log --oneline host-snapshot)"
fi

# ═══ Refuse binary changes ══════════════════════════════════════════════
new_fixture
printf '\x00\x01binarydata\x02\x03' > "$G/foo/container.json"
run_safety
case "$OUT" in
  *"binary change"*) ok "binary change refused" ;;
  *) bad "binary change was not refused" "$OUT" ;;
esac
if git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1; then
  bad "binary change: pushed anyway" "$(git --git-dir="$REMOTE" log --oneline host-snapshot)"
fi
assert_failure_reason_is_last "binary change refusal" "$OUT"

# ═══ Never auto-commit sensitive filenames; report them instead ══════════
new_fixture
git -C "$G" add .  # baseline commit already has foo/container.json tracked
mkdir -p "$G/bar"
printf 'a: 1\n' > "$G/bar/profiles.yml"
git -C "$G" add bar/profiles.yml
git -C "$G" commit -qm "track profiles.yml" >/dev/null
git -C "$G" push -q origin HEAD:main
echo 'password: hunter2verylongvalue' >> "$G/bar/profiles.yml"
echo '{"a":2}' > "$G/foo/container.json"
run_safety
[ "$RC" -eq 0 ] && ok "profiles.yml edit did not block the rest of the snapshot" \
  || bad "run failed unexpectedly with a tracked profiles.yml edit pending" "$OUT"
SNAP_TIP=$(git --git-dir="$REMOTE" rev-parse -q --verify host-snapshot 2>/dev/null)
if [ -n "$SNAP_TIP" ] && git --git-dir="$REMOTE" show "$SNAP_TIP:bar/profiles.yml" 2>/dev/null | grep -q hunter2; then
  bad "profiles.yml content with a secret-shaped line was committed" "tip=$SNAP_TIP"
else
  ok "profiles.yml was never staged into the snapshot commit"
fi
manifest=$(latest_snapshot)
grep -rq "profiles.yml" "$manifest/MANIFEST.txt" 2>/dev/null \
  && ok "profiles.yml exclusion was reported in the manifest" \
  || bad "profiles.yml exclusion was not reported" "$(cat "$manifest/MANIFEST.txt" 2>/dev/null)"

# ═══ Deletions are reported, never committed ══════════════════════════════
new_fixture
# Also change a second, unrelated file, so a commit actually gets built
# (a deletion alone, once excluded, would leave nothing pending to snapshot
# at all — the interesting assertion is that the deletion rides alongside a
# real change without being part of it).
mkdir -p "$G/other"
echo '{"x":1}' > "$G/other/thing.json"
git -C "$G" add other/thing.json
git -C "$G" commit -qm "add other file" >/dev/null
git -C "$G" push -q origin HEAD:main
rm -f "$G/foo/container.json"
echo '{"x":2}' > "$G/other/thing.json"
run_safety
[ "$RC" -eq 0 ] || bad "a deletion alone should not fail the run" "$OUT"
SNAP_TIP=$(git --git-dir="$REMOTE" rev-parse -q --verify host-snapshot 2>/dev/null)
if [ -n "$SNAP_TIP" ] && git --git-dir="$REMOTE" show "$SNAP_TIP:foo/container.json" >/dev/null 2>&1; then
  ok "deleted tracked file kept at last-known content in the snapshot commit"
else
  bad "deleted tracked file's content is missing from the snapshot commit" "tip=${SNAP_TIP:-<none>}"
fi
grep -q "deleted tracked file" "$(latest_snapshot)/MANIFEST.txt" 2>/dev/null \
  && ok "deletion was reported in the manifest" \
  || bad "deletion was not reported in the manifest" "$(cat "$(latest_snapshot)/MANIFEST.txt" 2>/dev/null)"
grep -q "container.json" "$DM_LOG" \
  && ok "deletion-only run still notified the owner" \
  || bad "deletion-only run sent no notice" "dm_log=$(cat "$DM_LOG")"

# ═══ Nothing another session staged leaks in ══════════════════════════════
new_fixture
mkdir -p "$G/leak"
echo 'new untracked file from another session' > "$G/leak/new-file.txt"
git -C "$G" add leak/new-file.txt   # staged in the REAL index by "another session"
echo '{"a":2}' > "$G/foo/container.json"
run_safety
SNAP_TIP=$(git --git-dir="$REMOTE" rev-parse -q --verify host-snapshot 2>/dev/null)
if [ -n "$SNAP_TIP" ] && git --git-dir="$REMOTE" show "$SNAP_TIP:leak/new-file.txt" >/dev/null 2>&1; then
  bad "another session's staged new file leaked into the snapshot commit" "tip=$SNAP_TIP"
else
  ok "another session's staged new file did not leak into the snapshot commit"
fi
if [ -n "$SNAP_TIP" ] && git --git-dir="$REMOTE" show "$SNAP_TIP:foo/container.json" 2>/dev/null | grep -q '"a":2'; then
  ok "the real tracked-file edit still made it into the snapshot commit"
else
  bad "the legitimate pending edit did not make it into the snapshot" "tip=${SNAP_TIP:-<none>}"
fi

# ═══ Rejected push: retry once, then succeed ═══════════════════════════════
# (git's pre-receive hooks run inside a ref-update quarantine and cannot
# mutate refs themselves — verified empirically while building this: a
# `git update-ref` inside the hook fails with "forbidden inside quarantine
# environment" — so a genuine concurrent-writer race is exercised
# separately below, via a real out-of-band `update-ref` on the bare repo
# between two runs, which proves the fresh-parent property without needing
# to fight that restriction.)
new_fixture
cat > "$REMOTE/hooks/pre-receive" <<'HOOK'
#!/bin/bash
MARK="$(dirname "$0")/../reject-once.marker"
if [ -e "$MARK" ]; then
  rm -f "$MARK"
  exit 0
fi
touch "$MARK"
echo "simulated race: rejecting the first push" >&2
exit 1
HOOK
chmod +x "$REMOTE/hooks/pre-receive"
echo '{"a":2}' > "$G/foo/container.json"
run_safety
[ "$RC" -eq 0 ] && ok "a once-rejected push retries and succeeds" \
  || bad "a once-rejected push did not recover" "$OUT"
git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1 \
  && ok "host-snapshot exists after the retry" \
  || bad "host-snapshot missing after the retry" "$OUT"

# ═══ Rejected push: always rejected → fail loudly, never jam ══════════════
new_fixture
cat > "$REMOTE/hooks/pre-receive" <<'HOOK'
#!/bin/bash
echo "simulated permanent rejection" >&2
exit 1
HOOK
chmod +x "$REMOTE/hooks/pre-receive"
echo '{"a":2}' > "$G/foo/container.json"
run_safety
[ "$RC" -ne 0 ] && ok "a permanently-rejected push fails the run" \
  || bad "a permanently-rejected push exited 0" "$OUT"
case "$OUT" in
  *"push"*"failed"*|*"FAILED"*) ok "permanent push failure reported clearly" ;;
  *) bad "permanent push failure not reported" "$OUT" ;;
esac
# Never jams: groups HEAD/working tree still clean, nothing left staged for
# next time except the untouched real working tree edit.
[ -n "$(git -C "$G" status --porcelain)" ] && ok "pending edit remains on disk for the next run to retry" \
  || bad "pending edit was lost after the permanent push failure" ""
# #628 item 8: a FAILURES exit must alert exactly once — via the installed
# unit's OnFailure= (which reads the journal this script's stderr just fed),
# never via the script's own notify-owner.ts call too.
[ ! -s "$DM_LOG" ] && ok "a FAILURES exit sends no DM of its own (OnFailure= alerts instead)" \
  || bad "a FAILURES exit still sent its own DM — double-alerts with OnFailure=" "$(cat "$DM_LOG")"
assert_failure_reason_is_last "permanent push failure" "$OUT"

# ═══ Dry mode: no fetch, no fast-forward, no push, no DM ══════════════════
new_fixture
cat > "$REMOTE/hooks/pre-receive" <<'HOOK'
#!/bin/bash
echo "dry mode must never reach this hook" >&2
exit 1
HOOK
chmod +x "$REMOTE/hooks/pre-receive"
echo '{"a":2}' > "$G/foo/container.json"
run_safety GIT_SAFETY_GROUPS_COMMIT=dry
case "$OUT" in
  *"dry run: would commit"*) ok "dry mode reports what it would do" ;;
  *) bad "dry mode did not report intent" "$OUT" ;;
esac
git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1 \
  && bad "dry mode created a host-snapshot branch" "" \
  || ok "dry mode pushed nothing"
[ -s "$DM_LOG" ] && bad "dry mode sent a DM" "$(cat "$DM_LOG")" || ok "dry mode sent no DM"

# ═══ Phase 1 errors are non-silent (update-ref / diff / tar) ══════════════
# A plain FILE sitting where update-ref needs to create
# refs/git-safety/detached/<slug> (a directory) makes the ref update fail;
# assert the run reports it as a FAILURE and exits non-zero (which is what
# the installed unit's OnFailure= escalation keys off) instead of
# swallowing it into errors.log alone.
new_fixture
WT="$FIX/detached-wt"
git -C "$NCDIR" worktree add -q --detach "$WT" HEAD >/dev/null 2>&1
echo more >> "$WT/README.md"
git -C "$WT" commit -qam "unpushed on detached worktree" >/dev/null
mkdir -p "$NCDIR/.git/refs"
touch "$NCDIR/.git/refs/git-safety"
run_safety
case "$OUT" in
  *"update-ref"*) ok "a failing update-ref is reported as a failure" ;;
  *) bad "a failing update-ref was silent" "$OUT" ;;
esac
[ "$RC" -ne 0 ] && ok "phase-1 error causes non-zero exit (for OnFailure= to escalate)" \
  || bad "phase-1 error did not fail the run" "$OUT"
[ ! -s "$DM_LOG" ] && ok "phase-1 FAILURES exit sends no DM of its own either" \
  || bad "phase-1 FAILURES exit still sent its own DM" "$(cat "$DM_LOG")"
assert_failure_reason_is_last "phase-1 update-ref failure" "$OUT"
git -C "$NCDIR" worktree remove --force "$WT" >/dev/null 2>&1

# ═══ A missing lib/secret-scan.sh fails closed, not open ══════════════════
# git-safety.sh sources lib/secret-scan.sh with `${SCRIPT_DIR}/lib/...`,
# where SCRIPT_DIR is derived from ${BASH_SOURCE[0]} — the path of whatever
# copy of the script bash actually runs. Exercise the SHIPPED script's
# source-guard (`|| exit 1`, #658 review) by running a byte-for-byte copy of
# it from a scratch directory with no lib/ sibling at all, so this never
# touches the real scripts/lib/secret-scan.sh in this checkout. Before the
# guard, a missing lib left secret_scan_hits() undefined: the later
# `hits=$(secret_scan_hits ...)` failed silently (command not found), hits
# ended up "", and `${hits:-0}` read that as 0 — the secret gate passed
# every pending change through unchecked.
new_fixture
NOLIB_DIR="$FIX/nolib-scripts"
mkdir -p "$NOLIB_DIR"
cp "$REAL" "$NOLIB_DIR/git-safety.sh"
echo '{"a":2}' > "$G/foo/container.json"
OUT=$(env NANOCLAW_DIR="$NCDIR" GIT_SAFETY_DIR="$BACKUPS" HOME="$HOME2" bash "$NOLIB_DIR/git-safety.sh" 2>&1)
RC=$?
[ "$RC" -ne 0 ] && ok "a missing lib/secret-scan.sh fails the run" \
  || bad "a missing lib/secret-scan.sh did NOT fail the run (fail-open)" "$OUT"
case "$OUT" in
  *"cannot load"*"secret-scan.sh"*) ok "missing-lib failure names the file it could not load" ;;
  *) bad "missing-lib failure did not explain itself" "$OUT" ;;
esac
git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1 \
  && bad "missing-lib run pushed a host-snapshot commit anyway (fail-OPEN, gate never ran)" \
    "$(git --git-dir="$REMOTE" log --oneline host-snapshot)" \
  || ok "missing-lib run pushed nothing — fails closed"

# ═══ A PRESENT but CORRUPT lib/secret-scan.sh also fails closed ═══════════
# Distinct from the missing-file case above: git-safety.sh now calls
# secret_scan_selftest() right after sourcing the lib (#666 rework) so a
# lib that sources cleanly (rc=0, every function/variable name still
# exists) but whose regex/variables are broken is still caught, not just a
# lib that fails to source at all.
new_fixture
BADLIB_DIR="$FIX/badlib-scripts"
mkdir -p "$BADLIB_DIR/lib"
cp "$REAL" "$BADLIB_DIR/git-safety.sh"
sed '/^SECRET_BLOCK_RE=/d' "$(dirname "$REAL")/lib/secret-scan.sh" > "$BADLIB_DIR/lib/secret-scan.sh"
echo '{"a":2}' > "$G/foo/container.json"
OUT=$(env NANOCLAW_DIR="$NCDIR" GIT_SAFETY_DIR="$BACKUPS" HOME="$HOME2" bash "$BADLIB_DIR/git-safety.sh" 2>&1)
RC=$?
[ "$RC" -ne 0 ] && ok "a corrupt (but sourceable) lib/secret-scan.sh fails the run" \
  || bad "a corrupt lib/secret-scan.sh did NOT fail the run (fail-open)" "$OUT"
case "$OUT" in
  *"self-test"*) ok "corrupt-lib failure names the self-test, not a generic error" ;;
  *) bad "corrupt-lib failure did not mention the self-test" "$OUT" ;;
esac
git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1 \
  && bad "corrupt-lib run pushed a host-snapshot commit anyway (fail-OPEN, gate never ran)" \
    "$(git --git-dir="$REMOTE" log --oneline host-snapshot)" \
  || ok "corrupt-lib run pushed nothing — fails closed"

# ═══ SECRET_BLOCK_RE is a literal subset of SECRET_RE (#666 addendum 2) ═══
# git-safety.sh has only ONE tier (over the full, case-insensitive
# SECRET_RE) — it never consults SECRET_BLOCK_RE directly. This assertion
# exists here anyway because git-safety.sh and the wiki pre-push hook share
# this one lib file: if a future edit ever widened SECRET_BLOCK_RE past
# SECRET_RE, the wiki hook's BLOCK tier would start rejecting pushes that
# git-safety.sh's own single-tier scan would have let through as clean —
# silently inconsistent secret handling between the two call sites.
# shellcheck source=lib/secret-scan.sh
source "$(dirname "$REAL")/lib/secret-scan.sh"
BLOCK_SUBSET_FIXTURES=(
  'export SLACK_APP_TOKEN=xapp-1-A0123-4567890123-abcdefabcdefabcdefabcdefabcdef'
  'export GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4aXYZ123'
  'AKIAIOSFODNN7ABCDEFG'
  '-----BEGIN PGP PRIVATE KEY BLOCK-----'
)
BLOCK_SUBSET_OK=1
for line in "${BLOCK_SUBSET_FIXTURES[@]}"; do
  if LC_ALL=C grep -qE "$SECRET_BLOCK_RE" <<<"$line" && ! LC_ALL=C grep -qiE "$SECRET_RE" <<<"$line"; then
    BLOCK_SUBSET_OK=0
    bad "BLOCK-subset: '$line' matches SECRET_BLOCK_RE but not SECRET_RE" ""
  fi
done
[ "$BLOCK_SUBSET_OK" -eq 1 ] && ok "SECRET_BLOCK_RE stays a literal subset of SECRET_RE across sample fixtures"

# ═══ Worktree slugs get a hash suffix (uniqueness even after truncation) ══
# Unit-test slug() directly (extracted verbatim from the shipped script),
# with two paths engineered to be BYTE-IDENTICAL in their last 100 chars —
# the truncation alone would collide them; only the hash (of the FULL,
# untruncated path) can tell them apart. The old version of this check just
# counted patch files from two merely-long paths, which passes even if the
# hash suffix were deleted entirely, as long as the paths differ before the
# truncation point.
eval "$(sed -n '/^slug() {/,/^}/p' "$REAL")"
PREFIX_A="aaa"; PREFIX_B="bbb"
SHARED_TAIL=$(printf 'x%.0s' $(seq 1 120))
SLUG_A=$(slug "/tmp/$PREFIX_A/$SHARED_TAIL")
SLUG_B=$(slug "/tmp/$PREFIX_B/$SHARED_TAIL")
[ "$SLUG_A" != "$SLUG_B" ] && ok "slug() disambiguates two paths identical in their last 100 chars" \
  || bad "slug() collided on two different paths" "a=$SLUG_A b=$SLUG_B"

# `..` anywhere in a worktree path must not survive into the slug: git
# forbids two consecutive dots in a ref name, so an untreated ".." would
# make update-ref fail and that worktree's commits would never get pinned.
DOTDOT_SLUG=$(slug "/tmp/a/../b/worktree")
case "$DOTDOT_SLUG" in
  *..*) bad "slug() left '..' in the output" "$DOTDOT_SLUG" ;;
  *) ok "slug() strips '..' from the output ($DOTDOT_SLUG)" ;;
esac
# Prove it's actually a valid ref name, not just eyeballed.
new_fixture
if git -C "$NCDIR" update-ref "refs/git-safety/detached/$DOTDOT_SLUG" HEAD 2>/dev/null; then
  ok "the '..'-stripped slug is a valid ref name"
  git -C "$NCDIR" update-ref -d "refs/git-safety/detached/$DOTDOT_SLUG" 2>/dev/null
else
  bad "the '..'-stripped slug is still not a valid ref name" "$DOTDOT_SLUG"
fi

new_fixture
LONGA="$FIX/$(printf 'a%.0s' $(seq 1 140))-one"
LONGB="$FIX/$(printf 'a%.0s' $(seq 1 140))-two"
git -C "$NCDIR" worktree add -q -b wt-long-a "$LONGA" >/dev/null 2>&1
git -C "$NCDIR" worktree add -q -b wt-long-b "$LONGB" >/dev/null 2>&1
echo edit >> "$LONGA/README.md"
echo edit >> "$LONGB/README.md"
run_safety
NANOCLAW_SNAP="$(latest_snapshot)nanoclaw"
COUNT=$(ls "$NANOCLAW_SNAP"/*.patch 2>/dev/null | wc -l)
[ "$COUNT" -ge 2 ] && ok "two long, tail-colliding worktree paths produced distinct slugs ($COUNT patch files)" \
  || bad "worktree slug collision — expected 2 distinct patch files" "found=$COUNT dir=$(ls "$NANOCLAW_SNAP" 2>/dev/null)"
git -C "$NCDIR" worktree remove --force "$LONGA" >/dev/null 2>&1
git -C "$NCDIR" worktree remove --force "$LONGB" >/dev/null 2>&1

# ═══ Untracked files at/over the size cap are skipped AND recorded ═══════
new_fixture
head -c 200 /dev/zero > "$NCDIR/big-untracked.bin"
run_safety GIT_SAFETY_MAX_UNTRACKED_BYTES=100
manifest=$(latest_snapshot)
grep -q "skipped big-untracked.bin" "$manifest/MANIFEST.txt" 2>/dev/null \
  && ok "an over-cap untracked file is recorded as skipped" \
  || bad "an over-cap untracked file was skipped silently" "$(cat "$manifest/MANIFEST.txt" 2>/dev/null)"
find "$manifest" -name '*untracked.tgz' -exec tar tzf {} \; 2>/dev/null | grep -q big-untracked.bin \
  && bad "the over-cap file ended up in a tarball anyway" "" \
  || ok "the over-cap file was not captured in any tarball"

# ═══ Snapshot hygiene: secret-shaped untracked filenames never tarred ═════
new_fixture
echo "SECRET=abc" > "$NCDIR/.env"
run_safety
manifest=$(latest_snapshot)
grep -q "excluded .env" "$manifest/MANIFEST.txt" 2>/dev/null \
  && ok ".env exclusion from snapshot was recorded" \
  || bad ".env exclusion was not recorded" "$(cat "$manifest/MANIFEST.txt" 2>/dev/null)"
find "$manifest" -name '*untracked.tgz' -exec tar tzf {} \; 2>/dev/null | grep -qE '(^|/)\.env$' \
  && bad ".env ended up in an untracked-files tarball" "" \
  || ok ".env was excluded from every untracked-files tarball"
# umask 077: everything created under the snapshot root is owner-only.
# `-perm /077` (ANY group/other bit set) — `-perm -g+rwx -o -perm -o+rwx`
# would only fire on ALL of group's or ALL of other's rwx bits, missing a
# file at, say, mode 640 (group-readable, not group-writable/executable).
PERM_BAD=$(find "$manifest" -perm /077 2>/dev/null)
[ -z "$PERM_BAD" ] && ok "snapshot files are owner-only (umask 077)" \
  || bad "snapshot files are group/world accessible" "$PERM_BAD"

# ═══ Bundle verify actually inflates the pack (catches pack corruption) ══
new_fixture
WT="$FIX/detached-wt2"
git -C "$NCDIR" worktree add -q --detach "$WT" HEAD >/dev/null 2>&1
echo unpushed >> "$WT/README.md"
git -C "$WT" commit -qam "commit that exists on no remote" >/dev/null
run_safety
BUNDLE="$(latest_snapshot)nanoclaw/unpushed-commits.bundle"
if [ -s "$BUNDLE" ]; then
  ok "a bundle of unpushed commits was written"
  # `git bundle verify` alone must not be trusted: prove it still says OK on
  # a corrupted pack, and that the shipped verify_bundle() (extracted
  # verbatim from git-safety.sh, not a re-implementation) catches it. A
  # naive "fetch into a scratch repo with alternates" does NOT catch this —
  # proven while building this check — because git's quickfetch shortcut
  # sees every OID the bundle advertises already present via the alternate
  # (it's the same repo the bundle came from) and never touches the pack
  # bytes at all; that dead end is why verify_bundle extracts the pack and
  # feeds it to index-pack directly instead.
  cp "$BUNDLE" "$FIX/corrupt.bundle"
  # Corrupt a byte at a COMPUTED OFFSET inside the pack's own OBJECT data,
  # not the file's last byte (#666 review T1: the last-byte version failed
  # 4 of 4 times when review-666 ran this script from a copied directory
  # instead of in-tree, and passed in-tree — location-dependent). A bundle
  # is header lines (refs, prerequisites) + a blank line + the pack itself,
  # which starts with the 4-byte "PACK" magic; corrupting the file's LAST
  # byte instead lands in the pack's trailing checksum, whose exact
  # position (and so, apparently, its effect on plain `git bundle verify`)
  # shifts with incidental header content. PACK's own magic bytes are
  # always findable regardless of where the file lives or how long the
  # header is, and 12 bytes past it (4-byte magic + 4-byte version + 4-byte
  # object count) is always inside the first object's zlib-compressed data
  # — which plain verify never inspects but index-pack (verify_bundle)
  # always does. Verified location-independent by running this exact
  # selfcheck both in-tree and from a copy of the whole repo at a
  # different path (see the PR body's test-plan evidence for both runs).
  PACK_OFFSET=$(LC_ALL=C grep -aob 'PACK' "$FIX/corrupt.bundle" | head -1 | cut -d: -f1)
  if [ -z "$PACK_OFFSET" ]; then
    bad "test setup: could not find the PACK magic inside the bundle to corrupt" ""
  fi
  CORRUPT_AT=$((PACK_OFFSET + 12))
  printf '\xff' | dd of="$FIX/corrupt.bundle" bs=1 seek="$CORRUPT_AT" count=1 conv=notrunc status=none
  # `-C "$NCDIR"` (#666 review P3-3): without it, `git bundle verify` needs
  # the CURRENT WORKING DIRECTORY to already be inside a git repo (or one
  # of its ancestors) — location-dependent in exactly the same way the
  # earlier last-byte corruption offset was, and for the same underlying
  # reason (this script's own behavior must not depend on where it's run
  # from). Verified by running this whole selfcheck from a directory
  # outside any git repo entirely (see the PR body's test-plan evidence).
  if git -C "$NCDIR" bundle verify "$FIX/corrupt.bundle" >/dev/null 2>&1; then
    ok "confirmed: plain 'git bundle verify' does not catch this pack corruption (motivates the fix)"
  else
    bad "test setup: plain bundle verify already caught the corruption — strengthen the corruption" ""
  fi
  # Extract verify_bundle()'s exact body from the shipped script and eval it,
  # so this asserts on the real function, not a copy of it.
  eval "$(sed -n '/^verify_bundle() {/,/^}/p' "$REAL")"
  if verify_bundle "$FIX/corrupt.bundle" "$NCDIR"; then
    bad "verify_bundle() did not catch the corrupted pack" ""
  else
    ok "verify_bundle() (real, shipped code) catches the corrupted pack"
  fi
  if verify_bundle "$BUNDLE" "$NCDIR"; then
    ok "verify_bundle() (real, shipped code) still accepts the original, uncorrupted bundle"
  else
    bad "verify_bundle() rejected a good bundle (false positive)" ""
  fi
else
  bad "no bundle was written for the unpushed commit" "$OUT"
fi
git -C "$NCDIR" worktree remove --force "$WT" >/dev/null 2>&1

# ═══ Stash pins are keyed by SHA and expire with the snapshot retention ═══
new_fixture
echo stashme >> "$NCDIR/README.md"
git -C "$NCDIR" stash push -q -m "selfcheck stash"
STASH_SHA=$(git -C "$NCDIR" rev-parse refs/stash)
run_safety
git -C "$NCDIR" show-ref --verify -q "refs/git-safety/stash/$STASH_SHA" \
  && ok "stash pin is keyed by the stash's own SHA" \
  || bad "no refs/git-safety/stash/<sha> pin was created" "$(git -C "$NCDIR" for-each-ref refs/git-safety)"
git -C "$NCDIR" stash drop -q
# Popped/dropped: pin becomes orphaned, but must not vanish immediately —
# only after it has been orphaned for GIT_SAFETY_KEEP_DAYS.
run_safety
git -C "$NCDIR" show-ref --verify -q "refs/git-safety/stash/$STASH_SHA" \
  && ok "an orphaned stash pin survives before the retention window elapses" \
  || bad "an orphaned stash pin was deleted immediately (data-loss risk)" ""
# Backdate the marker past the retention window and confirm it's pruned.
MARK="$BACKUPS/.git-safety-refs/nanoclaw/stash-$STASH_SHA"
if [ -e "$MARK" ]; then
  touch -d '30 days ago' "$MARK" 2>/dev/null || touch -t 202001010000 "$MARK"
  run_safety GIT_SAFETY_KEEP_DAYS=14
  git -C "$NCDIR" show-ref --verify -q "refs/git-safety/stash/$STASH_SHA" \
    && bad "an orphaned stash pin was not expired past the retention window" "" \
    || ok "an orphaned stash pin expired once past the retention window"
else
  bad "no orphan marker file was created for the dropped stash pin" "$(find "$BACKUPS/.git-safety-refs" 2>/dev/null)"
fi

# ═══ GIT_OPTIONAL_LOCKS=0 is honored (no incidental .git/index rewrite) ═══
new_fixture
echo '{"a":2}' > "$G/foo/container.json"
IDX_BEFORE=$(stat -c %Y "$G/.git/index" 2>/dev/null || echo 0)
sleep 1
run_safety
IDX_AFTER=$(stat -c %Y "$G/.git/index" 2>/dev/null || echo 0)
[ "$IDX_BEFORE" = "$IDX_AFTER" ] && ok "groups/.git/index mtime untouched (GIT_OPTIONAL_LOCKS=0 honored)" \
  || bad "groups/.git/index was rewritten" "before=$IDX_BEFORE after=$IDX_AFTER"

# ═══ A stat-dirty file (mtime touched, content unchanged) must not rewrite
# the real index either — GIT_OPTIONAL_LOCKS=0 does NOT stop this for
# porcelain `git diff` (verified empirically while building this fix: it
# rewrites the index regardless of the variable's setting); only the
# `diff-index` plumbing command this script now uses never does it. #628.
new_fixture
git -C "$NCDIR" commit --allow-empty -qm "second commit so README.md is tracked and clean" >/dev/null
sleep 1.1
touch "$NCDIR/README.md"
IDX_BEFORE=$(stat -c %Y "$NCDIR/.git/index")
run_safety
IDX_AFTER=$(stat -c %Y "$NCDIR/.git/index")
[ "$IDX_BEFORE" = "$IDX_AFTER" ] && ok "a stat-dirty (not content-dirty) tracked file does not rewrite .git/index" \
  || bad "a stat-dirty file's index refresh leaked through" "before=$IDX_BEFORE after=$IDX_AFTER"

# ═══ #628 follow-ups ═══════════════════════════════════════════════════════

# ─ A force-reset of host-snapshot must not wedge the next run (the fetch
# refspec needs a leading "+") ─
new_fixture
echo '{"a":2}' > "$G/foo/container.json"
run_safety
# This first run_safety's own success was never actually checked before
# reading host-snapshot back — a transient failure here (seen once in CI,
# never locally) surfaced two lines later as an opaque "fatal: : not a
# valid SHA1" instead of the real reason. Diagnose loudly instead of
# silently treating "no host-snapshot yet" as this test's own assertion.
if [ "$RC" -ne 0 ] || ! git --git-dir="$REMOTE" rev-parse -q --verify host-snapshot >/dev/null 2>&1; then
  bad "setup: first run_safety did not produce a host-snapshot to force-reset" "rc=$RC out=$OUT"
fi
FIRST_SNAP_TIP=$(git --git-dir="$REMOTE" rev-parse host-snapshot)
FORCE_RESET_TIP=$(git -c user.name=selfcheck -c user.email=selfcheck@example.invalid --git-dir="$REMOTE" commit-tree "$FIRST_SNAP_TIP^{tree}" -m "operator force-reset target" 2>/dev/null)
git --git-dir="$REMOTE" update-ref refs/heads/host-snapshot "$FORCE_RESET_TIP"
echo '{"a":3}' > "$G/foo/container.json"
run_safety
[ "$RC" -eq 0 ] && ok "a force-reset remote does not wedge the next run" \
  || bad "a force-reset remote wedged the run" "$OUT"
AFTER_RESET_TIP=$(git --git-dir="$REMOTE" rev-parse -q --verify host-snapshot 2>/dev/null)
AFTER_RESET_PARENT=$(git --git-dir="$REMOTE" log -1 --format=%P "$AFTER_RESET_TIP" 2>/dev/null | awk '{print $1}')
[ "$AFTER_RESET_PARENT" = "$FORCE_RESET_TIP" ] \
  && ok "the next commit is built on the force-reset tip, not a stale cached one" \
  || bad "the next commit used the wrong parent after a force-reset" "expected=$FORCE_RESET_TIP got=${AFTER_RESET_PARENT:-<none>}"

# ─ A `git rm` (or `git mv`) reaches host-snapshot unannounced only if the
# deletion check reads the real index instead of the scratch one ─
new_fixture
mkdir -p "$G/other"; echo '{"x":1}' > "$G/other/thing.json"
git -C "$G" add other/thing.json
git -C "$G" commit -qm "add other file" >/dev/null
git -C "$G" push -q origin HEAD:main
# `git rm` removes the path from BOTH the real index and the working tree —
# the real index no longer even lists it as tracked, which is exactly the
# state that made the old `ls-files --deleted` (against the real index)
# blind to it.
git -C "$G" rm -q foo/container.json
echo '{"x":2}' > "$G/other/thing.json"
run_safety
SNAP_TIP=$(git --git-dir="$REMOTE" rev-parse -q --verify host-snapshot 2>/dev/null)
if [ -n "$SNAP_TIP" ] && git --git-dir="$REMOTE" show "$SNAP_TIP:foo/container.json" >/dev/null 2>&1; then
  ok "a git-rm'd file is kept at last-known content in the snapshot commit"
else
  bad "a git-rm'd file's content is missing from the snapshot commit (reached host-snapshot as a real deletion)" "tip=${SNAP_TIP:-<none>}"
fi
grep -q "foo/container.json" "$(latest_snapshot)/MANIFEST.txt" 2>/dev/null \
  && ok "the git-rm deletion was reported in the manifest" \
  || bad "the git-rm deletion was not reported" "$(cat "$(latest_snapshot)/MANIFEST.txt" 2>/dev/null)"

# ─ verify_bundle's PACK-offset search must not be fooled by a prerequisite
# commit whose subject contains the literal word "PACK" ─
new_fixture
echo base > "$NCDIR/base.txt"
git -C "$NCDIR" add base.txt
git -C "$NCDIR" commit -qm "base commit whose subject mentions the PACK format explicitly" >/dev/null
PACK_REMOTE="$FIX/nanoclaw-remote.git"
git init --bare -q "$PACK_REMOTE"
git -C "$NCDIR" remote add pushtest "$PACK_REMOTE" 2>/dev/null || git -C "$NCDIR" remote set-url pushtest "$PACK_REMOTE"
git -C "$NCDIR" push -q pushtest HEAD:main
echo unpushed >> "$NCDIR/base.txt"
git -C "$NCDIR" commit -qam "unpushed on top of the PACK-mentioning base" >/dev/null
run_safety
case "$OUT" in
  *"could not write a verified bundle"*) bad "a PACK-mentioning prerequisite subject broke verify_bundle" "$OUT" ;;
  *) ok "a prerequisite commit subject containing 'PACK' does not break the offset search" ;;
esac
[ -s "$(latest_snapshot)nanoclaw/unpushed-commits.bundle" ] \
  && ok "the bundle was still written despite the PACK-mentioning prerequisite" \
  || bad "no bundle was written" "$OUT"

# ─ An identical tree is not committed again every night ─
new_fixture
echo '{"a":2}' > "$G/foo/container.json"
run_safety
FIRST_RUN_TIP=$(git --git-dir="$REMOTE" rev-parse -q --verify host-snapshot 2>/dev/null)
[ "$RC" -eq 0 ] && [ -n "$FIRST_RUN_TIP" ] && ok "first run with a pending edit commits and pushes" \
  || bad "first run did not push" "$OUT"
# Same persistent uncommitted edit, unchanged, on the second run.
run_safety
SECOND_RUN_TIP=$(git --git-dir="$REMOTE" rev-parse -q --verify host-snapshot 2>/dev/null)
[ "$SECOND_RUN_TIP" = "$FIRST_RUN_TIP" ] \
  && ok "a second run with the identical pending edit does not push a new no-op commit" \
  || bad "an identical tree was committed again" "first=$FIRST_RUN_TIP second=${SECOND_RUN_TIP:-<none>}"
case "$OUT" in
  *"unchanged since last snapshot"*) ok "the no-op run reports why it skipped" ;;
  *) bad "the no-op run did not explain itself" "$OUT" ;;
esac

# ─ Scratch-file cleanup trap is wired to EXIT/INT/TERM (#628 item 6) ─
# NOT tested here: winning the timing race of an actual SIGTERM landing
# mid-`add -u`. bash defers a pending trap until the current foreground
# child (git) returns control to it — confirmed empirically while building
# this: `kill -TERM` on a script blocked in a 30s `sleep` did not run its
# TERM trap until the full 30s elapsed, matching POSIX shell semantics, not
# a bug in this script. Reproducing systemd's real behavior (SIGTERM to the
# whole cgroup, so git dies too and unblocks bash immediately) needs a
# process-group-aware harness this fixture doesn't have; a naive version of
# that test would either always pass for the wrong reason (racing a
# same-process kill against a background job with no real interruption) or
# flake on timing, which is worse than no test. What IS checked, cheaply and
# deterministically: the extracted trap declaration (verbatim from the
# shipped script) actually registers `cleanup_scratch` for all three
# signals, and that function actually empties CLEANUP_PATHS when invoked
# directly.
eval "$(sed -n '/^CLEANUP_PATHS=()/,/^trap cleanup_scratch EXIT INT TERM/p' "$REAL")"
TRAPPED=$(trap -p | grep -c cleanup_scratch)
[ "$TRAPPED" -eq 3 ] && ok "cleanup_scratch is registered for EXIT, INT and TERM" \
  || bad "cleanup_scratch is not registered for all three signals" "$(trap -p)"
SCRATCH_A=$(mktemp -d); SCRATCH_B=$(mktemp)
CLEANUP_PATHS+=("$SCRATCH_A" "$SCRATCH_B")
cleanup_scratch
[ ! -e "$SCRATCH_A" ] && [ ! -e "$SCRATCH_B" ] \
  && ok "cleanup_scratch() removes every path it was given" \
  || bad "cleanup_scratch() left a path behind" "a=$([ -e "$SCRATCH_A" ] && echo present) b=$([ -e "$SCRATCH_B" ] && echo present)"

# #666 review P3-10, root cause: the `eval` above runs the SHIPPED script's
# own `trap cleanup_scratch EXIT INT TERM` line directly in THIS process
# (not a subshell), which silently REPLACES this file's own
# `cleanup_fixtures` trap registered near the top — bash trap registration
# is last-wins per signal, not cumulative. Every fixture dir created before
# this point (most of them: new_fixture() is called dozens of times above)
# was then never cleaned up at exit, because cleanup_scratch — a different
# function, with nothing in CLEANUP_PATHS — ran instead. Re-registered here
# once this section's own assertions (which specifically need
# cleanup_scratch active) are done, restoring cleanup over FIXTURE_DIRS for
# the rest of this run and confirmed by measuring zero leaked tmp dirs
# after a full run, not just by inspection.
trap cleanup_fixtures EXIT INT TERM

# ─ Secret-gate regex gaps named in #628 ─
secret_case "github user-to-server token (ghu_)" 'export GITHUB_TOKEN=ghu_16C7e42F292c6912E7710c838347Ae178B4a'
secret_case "github refresh token (ghr_)"         'export GITHUB_TOKEN=ghr_16C7e42F292c6912E7710c838347Ae178B4a'
secret_case "stripe restricted key (rk_live_)"    '"stripe_key": "rk_live_51H8xamplekeyvalueabc123"'
secret_case "slack rotation token (xoxe-)"        'export SLACK_TOKEN=xoxe-1-abcdefghijklmnopqrstuvwxyz'
secret_case "AWS STS temp key (ASIA)"             'aws_key = ASIAABCDEFGHIJKLMNOP'
secret_case "*_PASSPHRASE="                       'export SIGNING_KEY_PASSPHRASE=averylongpassphrasevalue123'
secret_case "*_PASS="                              'export DB_PASS=averylongpasswordvalue123'
secret_case "unexported *_KEY="                   'SOME_SERVICE_KEY=abcdefghijklmnop123456'
secret_case "Authorization: Bearer"               'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'

# False-positive reduction: "sk-" needs a word boundary — a long hyphenated
# value that merely CONTAINS "sk-" as a mid-word substring must not trip
# the gate (the historical 3.3%-per-commit false-positive driver per #628).
new_fixture
printf '{"a":2}\ndesk-configurationabcdefghijklmnopqrstuvwxyz\n' > "$G/foo/container.json"
run_safety
case "$OUT" in
  *"look like a secret"*) bad "false positive: 'desk-...' mid-word match on sk-" "$OUT" ;;
  *) ok "'sk-' requires a word boundary — 'desk-...' is not flagged" ;;
esac
git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1 \
  && ok "the non-secret 'desk-...' change was committed normally" \
  || bad "a non-secret change was refused" "$OUT"

# ═══ The '+++ ' header exclusion, narrowed after review (#658 round 2) ════
# An ADDED line is itself printed as `+` followed by its own content, so a
# real added line whose content starts with "++ " becomes "+++ ..." on the
# wire — syntactically identical to a `+++ ` diff header. The old blanket
# `grep -vE '^\+\+\+ '` exclusion dropped that content along with real
# headers (verified: reverting to it makes this exact case count 0 hits
# instead of 1). Narrowed to the shapes git actually emits for a header
# (`+++ b/<path>`, `+++ "b/<path>"`, `+++ /dev/null`).
secret_case "an added line starting with '++ ' is still scanned, not mistaken for a diff header" \
  '++ token=abc123secretabc123secretabc'

# LC_ALL=C counts BYTES for a character class, not characters — a 3-byte
# UTF-8 smart quote can burn most of a small {0,N} budget on its own.
# `{0,3}` let this exact line (smart-quote punctuation before the `:`)
# slip past under LC_ALL=C, though it matched fine under a UTF-8 locale
# (verified: reverting to {0,3} makes it count 0 hits instead of 1).
secret_case "smart-quote punctuation before ':' is still caught under LC_ALL=C" \
  '“password” : hunter2x'

# A file whose path happens to look like an sk- secret, already TRACKED
# (add -u only picks up edits to tracked files, never new ones — a brand
# new file wouldn't exercise this diff at all), gets a real content edit.
# The diff's own `+++ b/<path>` header line must not itself be scanned via
# the coincidental resemblance.
new_fixture
mkdir -p "$G/foo/tasks"
echo placeholder > "$G/foo/tasks/sk-learn-migration-plan-2026.md"
git -C "$G" add foo/tasks/sk-learn-migration-plan-2026.md
git -C "$G" commit -qm "add placeholder task file" >/dev/null
git -C "$G" push -q origin HEAD:main
printf 'ordinary planning notes, nothing secret here\n' >> "$G/foo/tasks/sk-learn-migration-plan-2026.md"
run_safety
case "$OUT" in
  *"look like a secret"*) bad "a '+++ b/…sk-learn-….md' header was scanned as content" "$OUT" ;;
  *) ok "a '+++ b/…sk-learn-….md' header is recognized as a header, not scanned" ;;
esac
git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1 \
  && ok "the sk--looking file's edit was committed normally" \
  || bad "the sk--looking file's edit was refused" "$OUT"

# git C-quotes a path containing non-ASCII bytes in its diff header
# (`+++ "b/café.md"` rather than `+++ b/café.md`) — the exclusion must
# recognize that quoted form too. Same reasoning as above: the file must
# already be tracked for `add -u` to pick up the edit.
new_fixture
printf 'placeholder\n' > "$G/foo/café.md"
git -C "$G" add foo/café.md
git -C "$G" commit -qm "add cafe placeholder" >/dev/null
git -C "$G" push -q origin HEAD:main
printf 'ordinary content, nothing secret here\n' >> "$G/foo/café.md"
run_safety
case "$OUT" in
  *"look like a secret"*) bad "a quoted-path '+++ \"b/café.md\"' header was scanned as content" "$OUT" ;;
  *) ok "a quoted-path header is recognized as a header, not scanned" ;;
esac
git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1 \
  && ok "the non-ASCII-named file's edit was committed normally" \
  || bad "the non-ASCII-named file's edit was refused" "$OUT"

# ─ Phase 1's untracked-file exclusions now match phase 2's list (#628) ─
untracked_excluded_case() { # label, filename, content
  new_fixture
  printf '%s' "$3" > "$NCDIR/$2"
  run_safety
  manifest=$(latest_snapshot)
  if find "$manifest" -name '*untracked.tgz' -exec tar tzf {} \; 2>/dev/null | grep -qF "$2"; then
    bad "phase 1: $1 ($2) was tarred" ""
  else
    ok "phase 1: $1 ($2) excluded from every untracked-files tarball"
  fi
}
untracked_excluded_case ".netrc"       ".netrc"        "machine example.com login me password hunter2"
untracked_excluded_case "SSH key"      "id_rsa"        "-----BEGIN OPENSSH PRIVATE KEY-----"
untracked_excluded_case "prod.env"     "prod.env"      "SECRET=abc"
untracked_excluded_case "secrets.yaml" "secrets.yaml"  "password: abc"

echo
[ "$FAILED" -eq 0 ] && echo "git-safety-selfcheck: all checks passed" || echo "git-safety-selfcheck: FAILURES"
exit "$FAILED"
