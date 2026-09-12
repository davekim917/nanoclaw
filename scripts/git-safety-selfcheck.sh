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

run_script() { # <script-path> extra env assignments as "$@..."
  local script=$1; shift
  OUT=$(env "$@" NANOCLAW_DIR="$NCDIR" GIT_SAFETY_DIR="$BACKUPS" HOME="$HOME2" bash "$script" 2>&1)
  RC=$?
}
run_safety() { # extra env assignments as "$@", e.g. run_safety GIT_SAFETY_GROUPS_COMMIT=dry
  run_script "$REAL" "$@"
}

# make_mutant_git_safety <old-literal> <new-literal> -> prints a mutant
# script path, exactly one literal substitution applied to a full copy of
# the REAL scripts/git-safety.sh (#628 item 9 mutation evidence). Fails
# loudly (via python's assert) if <old-literal> isn't found verbatim,
# rather than silently producing a byte-identical, unmutated copy — a
# fixture that stopped reproducing a bug is worse than no fixture. Lives
# in its own directory with lib/secret-scan.sh SYMLINKED alongside it
# (never copied — no drift risk) so the mutant's own
# `${SCRIPT_DIR}/lib/secret-scan.sh` source line resolves exactly like the
# real script's does, relative to itself.
make_mutant_git_safety() {
  local old=$1 new=$2 mutdir
  mutdir=$(mktemp -d)
  FIXTURE_DIRS+=("$mutdir")
  mkdir -p "$mutdir/lib"
  ln -s "$(dirname "$REAL")/lib/secret-scan.sh" "$mutdir/lib/secret-scan.sh"
  OLDSTR="$old" NEWSTR="$new" SRC="$REAL" DST="$mutdir/git-safety.sh" python3 -c "
import os
src = open(os.environ['SRC']).read()
old = os.environ['OLDSTR']
new = os.environ['NEWSTR']
assert old in src, 'mutation target text not found in git-safety.sh — source has drifted from this fixture'
open(os.environ['DST'], 'w').write(src.replace(old, new, 1))
"
  chmod +x "$mutdir/git-safety.sh"
  echo "$mutdir/git-safety.sh"
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
    *"held for secret-shaped content"*) ok "secret gate: $1" ;;
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
  *"held for secret-shaped content"*) ok "secret gate not blinded by color.ui=always" ;;
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
  *"held for secret-shaped content"*) ok "secret gate not blinded by a non-UTF-8 byte on the same line" ;;
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
# review-683 P3-5 split the shipped script's single `trap cleanup_scratch
# EXIT INT TERM` line into three separate `trap` statements (so INT/TERM
# actually exit after cleanup, instead of resuming — see that fix below);
# the range end-anchor here must track whichever is now the LAST such
# line, or this sed range never closes and captures the rest of the file
# to EOF, eval'ing far more of the real script than intended in THIS
# process (reproduced while making this exact change: it read all the way
# through to code that references $TS, which this truncated eval never
# assigns, and blew up with "TS: unbound variable").
eval "$(sed -n "/^CLEANUP_PATHS=()/,/^trap 'cleanup_scratch; exit 143' TERM/p" "$REAL")"
TRAPPED=$(trap -p | grep -c cleanup_scratch)
[ "$TRAPPED" -eq 3 ] && ok "cleanup_scratch is registered for EXIT, INT and TERM" \
  || bad "cleanup_scratch is not registered for all three signals" "$(trap -p)"
# review-683 P3-5, deterministic half: the registered INT/TERM trap TEXT
# itself must contain the `exit N` that actually stops the script — a bare
# `trap cleanup_scratch EXIT INT TERM` (the pre-fix shape) also registers
# cleanup_scratch for all three signals and would pass the check above,
# but never exits on a caught INT/TERM. A live SIGTERM-mid-run race is
# deliberately NOT asserted here (same reasoning as the comment above this
# block): reproduced empirically while building this fix, sending TERM at
# a random instant can land while bash is extracting a `$(...)` command
# substitution during word expansion, which can itself abort the trap's
# own execution with a "trap: ... unexpected EOF" parse diagnostic (or
# occasionally a "reader_loop: bad jump" abort with a core dump) and let
# the run continue regardless of the fix's correctness — flaky for a
# reason unrelated to whether the fix works, exactly the class of test
# this file already declines to write. review-683-r2 independently
# measured this same phenomenon far more rigorously (700 live runs: 8 lost
# signals, 6 core dumps, but none pushed a wrong tree — see the P3-1
# pre-write-tree guard in git-safety.sh, the actual signal-agnostic fix for
# the one class of that race that could matter). Manually verified outside
# this harness instead (dozens of real kill -TERM runs, rc=143 and nothing
# pushed whenever the signal was not lost to this race).
[[ $(trap -p INT) == *"exit 130"* ]] && ok "the INT trap actually exits (130), not just cleans up" \
  || bad "the INT trap has no exit — bash would resume after it" "$(trap -p INT)"
[[ $(trap -p TERM) == *"exit 143"* ]] && ok "the TERM trap actually exits (143), not just cleans up" \
  || bad "the TERM trap has no exit — bash would resume after it (the exact #628 item 9 regression: TERM mid-run pushed anyway)" "$(trap -p TERM)"
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
  *"held for secret-shaped content"*) bad "false positive: 'desk-...' mid-word match on sk-" "$OUT" ;;
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
  *"held for secret-shaped content"*) bad "a '+++ b/…sk-learn-….md' header was scanned as content" "$OUT" ;;
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
  *"held for secret-shaped content"*) bad "a quoted-path '+++ \"b/café.md\"' header was scanned as content" "$OUT" ;;
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

# ═══════════════════════════════════════════════════════════════════════════
# #628 item 9: per-file hold, alert-once, and the line-hash allowlist.
# review-658 measured 32 of 430 real groups commits (7.4%) would be refused
# WHOLE under the old single-tier gate — mostly TypeScript type annotations
# like `token: string`. These cases exercise the replacement: a match holds
# only its own file (everything else still commits), an alert fires once
# per (path, line-hash) — not every night — and a reviewed line can only be
# released by a COMMITTED entry in groups/.secret-scan-allow.
# ═══════════════════════════════════════════════════════════════════════════
GHP_LINE='export GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4aXYZ123'
allow_hash() { printf '%s\t%s' "$1" "$2" | sha256sum | cut -d' ' -f1; } # <path> <line> -> same key git-safety.sh/secret-scan-allow.sh use
held_state_file() { printf '%s/.git-safety-state/secret-scan-held.tsv' "$BACKUPS"; }

# ─ Case 1: a false positive (review-658's own TypeScript shape) holds only
# its own file; a genuinely clean, unrelated file still commits ───────────
new_fixture
mkdir -p "$G/bar"
echo placeholder > "$G/bar/types.ts"
git -C "$G" add bar/types.ts
git -C "$G" commit -qm "add bar/types.ts" >/dev/null
git -C "$G" push -q origin HEAD:main
echo 'clean edit' >> "$G/foo/container.json"
echo 'token: string' >> "$G/bar/types.ts"
run_safety
case "$OUT" in
  *"1 file(s) held for secret-shaped content"*) ok "case 1: exactly one file held (the false positive), named in the output" ;;
  *) bad "case 1: wrong hold reporting" "$OUT" ;;
esac
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null)
case "$CONTAINER_TIP" in
  *"clean edit"*) ok "case 1: the unrelated clean file still committed" ;;
  *) bad "case 1: the clean file's edit did not commit" "content=[$CONTAINER_TIP]" ;;
esac
TYPES_TIP=$(git --git-dir="$REMOTE" show host-snapshot:bar/types.ts 2>/dev/null)
[ "$TYPES_TIP" = "placeholder" ] && ok "case 1: the held file's snapshot content is HEAD's version, not the pending false-positive edit" \
  || bad "case 1: the held file's edit leaked into the snapshot" "content=[$TYPES_TIP]"
grep -q "token: string" "$G/bar/types.ts" 2>/dev/null && ok "case 1: the pending edit is still on disk in the working tree — nothing was lost" \
  || bad "case 1: the pending edit vanished from the working tree" ""

# Mutation evidence: the reset-to-HEAD step is what actually implements
# containment. Disable ONLY that one call (never even attempt it) and
# replay the identical fixture — detection still fires (still reported
# "held"), but the content leaks. The exact same `if ! ... reset ...; then`
# text also appears for the TAB/LF/CR-poisoned-path branch above it in the
# file — the FAILURES message text that follows is included here so the
# substitution targets the ORDINARY held-path branch specifically, not
# whichever occurrence happens to come first.
P1_MUTATION_OLD=$(cat <<'OLDEOF'
if ! GIT_INDEX_FILE="$TMPIDX" git -C "$G" reset -q HEAD -- ":(literal)$path" 2>>"$ERR"; then
        FAILURES+=("groups: could not reset a held path back to HEAD in the scratch index: $path — refused to commit any pending change")
OLDEOF
)
P1_MUTATION_NEW=$(cat <<'NEWEOF'
if false; then # MUTATED (#628 item 9 case 1): the reset never even runs, detected as offending but never contained
        FAILURES+=("groups: could not reset a held path back to HEAD in the scratch index: $path — refused to commit any pending change")
NEWEOF
)
MUTANT=$(make_mutant_git_safety "$P1_MUTATION_OLD" "$P1_MUTATION_NEW")
new_fixture
mkdir -p "$G/bar"
echo placeholder > "$G/bar/types.ts"
git -C "$G" add bar/types.ts
git -C "$G" commit -qm "add bar/types.ts" >/dev/null
git -C "$G" push -q origin HEAD:main
echo 'clean edit' >> "$G/foo/container.json"
echo 'token: string' >> "$G/bar/types.ts"
run_script "$MUTANT"
MUTANT_TYPES=$(git --git-dir="$REMOTE" show host-snapshot:bar/types.ts 2>/dev/null)
case "$MUTANT_TYPES" in
  *"token: string"*) ok "case 1 mutation evidence: without the reset-to-HEAD step, the 'held' file's edit leaks into the snapshot anyway — the reset is what actually implements containment, not just the detection" ;;
  *) bad "case 1 mutation evidence: mutant unexpectedly still contained the edit (fixture doesn't isolate the reset step)" "content=[$MUTANT_TYPES]" ;;
esac

# ─ Case 2: a brand-new hold exits non-zero exactly once ──────────────────
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_safety
[ "$RC" -ne 0 ] && ok "case 2: a brand-new hold exits non-zero" || bad "case 2: a new hold did not exit non-zero" "$OUT"
case "$OUT" in
  *"new, changed, or unresolved 7+ days"*) ok "case 2: the alert names why (new/changed/stale)" ;;
  *) bad "case 2: no alert reason in the output" "$OUT" ;;
esac

MUTANT=$(make_mutant_git_safety \
  'first_seen="$now_iso"; last_alerted="$now_iso"; alert_worthy=1' \
  'first_seen="$now_iso"; last_alerted="$now_iso"; alert_worthy=0 # MUTATED (#628 item 9 case 2): a brand-new hold never alerts')
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_script "$MUTANT"
[ "$RC" -eq 0 ] && ok "case 2 mutation evidence: without alert_worthy=1 on a new hold, the run exits 0 — a real new secret would silently never alert anyone" \
  || bad "case 2 mutation evidence: mutant unexpectedly still exited non-zero" "$OUT"

# ─ Case 3: the SAME unchanged hold exits 0 on the very next run ──────────
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_safety
[ "$RC" -ne 0 ] || bad "case 3 setup: the first run should have alerted (new hold)" "$OUT"
run_safety
[ "$RC" -eq 0 ] && ok "case 3: an unchanged hold exits 0 on the next run" || bad "case 3: an unchanged hold re-alerted" "$OUT"
case "$OUT" in
  *"1 file(s) held for secret-shaped content"*) ok "case 3: still names the still-pending held file even though it doesn't alert" ;;
  *) bad "case 3: no stderr line naming the still-pending hold" "$OUT" ;;
esac

MUTANT=$(make_mutant_git_safety \
  'if [ $((now_epoch - first_epoch)) -ge "$HOLD_REALERT_SECONDS" ] && [ $((now_epoch - last_epoch)) -ge "$HOLD_REALERT_SECONDS" ]; then' \
  'if true; then # MUTATED (#628 item 9 case 3): every existing hold re-alerts every run, 7-day gate removed')
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_script "$MUTANT"
[ "$RC" -ne 0 ] || bad "case 3 mutation setup: the first mutant run should still alert (new hold)" "$OUT"
run_script "$MUTANT"
[ "$RC" -ne 0 ] && ok "case 3 mutation evidence: without the 7-day gate, an UNCHANGED hold re-alerts on the very next run — reproduces the nightly alert-loop this item fixes" \
  || bad "case 3 mutation evidence: mutant unexpectedly stayed quiet on an unchanged hold" "$OUT"

# ─ Case 4: a COMMITTED allowlist entry releases a hold; an UNCOMMITTED one doesn't ─
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_safety
[ "$RC" -ne 0 ] || bad "case 4 setup: the first run should have held and alerted" "$OUT"
HASH=$(allow_hash "foo/container.json" "$GHP_LINE")
printf 'foo/container.json\t%s\ttest allow\n' "$HASH" > "$G/.secret-scan-allow"
run_safety
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null)
case "$CONTAINER_TIP" in
  *ghp_*) bad "case 4: an UNCOMMITTED .secret-scan-allow edit released the hold" "content=[$CONTAINER_TIP]" ;;
  *) ok "case 4: an uncommitted .secret-scan-allow edit does NOT release the hold" ;;
esac
git -C "$G" add .secret-scan-allow
git -C "$G" commit -qm "allow reviewed line" >/dev/null
run_safety
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null)
case "$CONTAINER_TIP" in
  *ghp_*) ok "case 4: a COMMITTED .secret-scan-allow entry releases the hold" ;;
  *) bad "case 4: a committed allowlist entry did not release the hold" "content=[$CONTAINER_TIP]" ;;
esac
[ -s "$(held_state_file)" ] && bad "case 4: the released entry is still in the held-state file" "$(cat "$(held_state_file)")" \
  || ok "case 4: the released entry dropped out of the held-state file"

MUTANT=$(make_mutant_git_safety \
  'raw=$(git -C "$g" show HEAD:.secret-scan-allow 2>/dev/null) || return 0' \
  'raw=$(cat "$g/.secret-scan-allow" 2>/dev/null) || return 0 # MUTATED (#628 item 9 case 4): reads the WORKING TREE, not committed HEAD')
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_script "$MUTANT"
HASH=$(allow_hash "foo/container.json" "$GHP_LINE")
printf 'foo/container.json\t%s\ttest allow\n' "$HASH" > "$G/.secret-scan-allow"
run_script "$MUTANT"
MUTANT_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null)
case "$MUTANT_TIP" in
  *ghp_*) ok "case 4 mutation evidence: reading the allowlist from the WORKING TREE releases the hold from a merely UNCOMMITTED edit — reproduces the bug the HEAD-only read prevents" ;;
  *) bad "case 4 mutation evidence: mutant unexpectedly did not release the hold" "content=[$MUTANT_TIP]" ;;
esac

# ─ Case 5: a real ghp_ token stays held, never committed ─────────────────
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_safety
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null || echo "<no snapshot>")
case "$CONTAINER_TIP" in
  *ghp_*) bad "case 5: a real ghp_ token was committed to host-snapshot" "content=[$CONTAINER_TIP]" ;;
  *) ok "case 5: a real ghp_ token stays held, never committed" ;;
esac

# ─ Case 6: a hold unresolved and unalerted for 7+ days re-alerts, then goes quiet again ─
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_safety
[ "$RC" -ne 0 ] || bad "case 6 setup: the first run should have alerted" "$OUT"
STATE_FILE=$(held_state_file)
HASH=$(cut -f2 "$STATE_FILE")
STALE=$(date -u -d '8 days ago' +%Y-%m-%dT%H:%M:%SZ)
printf 'foo/container.json\t%s\t%s\t%s\n' "$HASH" "$STALE" "$STALE" > "$STATE_FILE"
run_safety
[ "$RC" -ne 0 ] && ok "case 6: an 8-day-old, unresolved and unalerted-in-8-days hold re-alerts" \
  || bad "case 6: an 8-day-stale hold did not re-alert" "$OUT"
run_safety
[ "$RC" -eq 0 ] && ok "case 6: immediately after the 7-day re-alert, the very next run is quiet again (last_alerted just moved to now)" \
  || bad "case 6: re-alerted twice with no further time passing" "$OUT"

# ─ Case 7: a corrupt groups/.secret-scan-allow fails closed (holds stay) ─
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_safety
[ "$RC" -ne 0 ] || bad "case 7 setup: the first run should have alerted" "$OUT"
HASH=$(allow_hash "foo/container.json" "$GHP_LINE")
printf 'foo/container.json\t%s\n' "$HASH" > "$G/.secret-scan-allow" # malformed: missing the "reason" column
git -C "$G" add .secret-scan-allow
git -C "$G" commit -qm "malformed allowlist" >/dev/null
run_safety
case "$OUT" in
  *"malformed"*"treating as empty"*) ok "case 7: a malformed allowlist is diagnosed and treated as empty" ;;
  *) bad "case 7: no malformed-allowlist diagnostic in the output" "$OUT" ;;
esac
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null || echo "<no snapshot>")
case "$CONTAINER_TIP" in
  *ghp_*) bad "case 7: a corrupt allowlist released the hold anyway (fail-OPEN)" "content=[$CONTAINER_TIP]" ;;
  *) ok "case 7: a corrupt allowlist fails closed — the hold stays" ;;
esac

# ─ Case 8: a held file, later deleted from the working tree, is held too ─
# A second, unrelated clean file changes too, so run 1 actually produces a
# snapshot commit at all — if the held path were the ONLY pending change,
# holding it leaves nothing to commit and no snapshot exists yet either
# way, which would make this case vacuous.
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
mkdir -p "$G/bar"
echo placeholder > "$G/bar/types.ts"
git -C "$G" add bar/types.ts
git -C "$G" commit -qm "add bar/types.ts" >/dev/null
git -C "$G" push -q origin HEAD:main
echo 'unrelated clean edit' >> "$G/bar/types.ts"
run_safety
[ "$RC" -ne 0 ] || bad "case 8 setup: the first run should have held and alerted" "$OUT"
rm -f "$G/foo/container.json"
run_safety
git --git-dir="$REMOTE" cat-file -e host-snapshot:foo/container.json 2>&1 \
  && ok "case 8: a held file's later deletion never reaches the snapshot as a deletion" \
  || bad "case 8: the held file's deletion reached the snapshot" ""
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null)
if [ "$CONTAINER_TIP" = '{"a":1}' ]; then
  ok "case 8: the snapshot keeps the file's original committed content — no secret, and not the deleted state"
else
  bad "case 8: unexpected snapshot content for the deleted-and-held path" "content=[$CONTAINER_TIP]"
fi

# ═══════════════════════════════════════════════════════════════════════════
# review-683, round 1 on #628 item 9 (CHANGES): a P1 quoted/pathspec-magic
# filename bypass, two P2s, and several P3s. Each fix gets its own case
# below; P1-1/P2-1/P2-2/the TERM fix also get mutation evidence.
# ═══════════════════════════════════════════════════════════════════════════

# ─ P1-1: quoted and pathspec-magic filenames must not bypass the scan ─────
# `diff --cached --name-only HEAD` (no `-z`) quotes a special-byte path per
# core.quotePath — the quoted STRING then never matches anything as a
# pathspec, so the file is never scanned or held, yet `add -u` already
# staged it and it commits regardless. All 13 names below either need
# real bytes a shell would otherwise treat specially, or resemble git
# pathspec magic syntax closely enough to break unquoted use as one.
# review-683-r2 P3-7: an optional setup snippet, eval'd right after
# new_fixture (and only once) — needed because hostile_name_case calls
# new_fixture ITSELF as its first line, which silently threw away any
# fixture config (e.g. `core.quotePath false`) the caller had set up on a
# fixture from a PRECEDING new_fixture call. That made the
# "core.quotePath=false" case below vacuous: it actually ran against a
# fresh default-quotePath fixture, indistinguishable from the default case
# under a confusing label.
HOSTILE_CASE_SETUP=""
hostile_name_case() { # <label> <filename (may contain any byte but NUL and /)>
  new_fixture
  if [ -n "$HOSTILE_CASE_SETUP" ]; then eval "$HOSTILE_CASE_SETUP"; HOSTILE_CASE_SETUP=""; fi
  local label="$1" name="$2"
  printf 'placeholder\n' > "$G/$name"
  # review-683-r2 P3-7: a bare `git add -- "$name"` is ITSELF subject to
  # git's own pathspec-magic parsing — `:(exclude)*` and `:(top)zz.md` are
  # valid magic syntax as plain strings (any argument shaped `:(...)` is),
  # so without `:(literal)` this add was silently a no-op for exactly those
  # two names (nothing staged, no error), the resulting commit had nothing
  # new to commit, and the whole fixture never actually created the file
  # this case claims to test — passing "held, never committed" for the
  # wrong reason (it was never committed to begin with). `:(literal)` makes
  # this add match the name byte-for-byte, the same fix as the scan itself.
  git -C "$G" add -- ":(literal)$name"
  git -C "$G" commit -qm "add hostile-name placeholder" >/dev/null
  git -C "$G" push -q origin HEAD:main
  printf 'placeholder\n%s\n' "$GHP_LINE" > "$G/$name"
  run_safety
  # review-683-r2 P3-7: assert rc≠0 on the first run explicitly, not just
  # that the secret didn't reach host-snapshot — a run that silently
  # succeeded (rc=0) while ALSO somehow not leaking would pass the old
  # check for the wrong reason.
  [ "$RC" -ne 0 ] || bad "P1-1 hostile filename ($label): first run did not report a nonzero exit" "$OUT"
  local remote_content
  remote_content=$(git --git-dir="$REMOTE" show "host-snapshot:$name" 2>/dev/null || echo "<no-entry>")
  case "$remote_content" in
    *ghp_*) bad "P1-1 hostile filename ($label): secret leaked into host-snapshot" "content=[$remote_content]" ;;
    *) ok "P1-1 hostile filename ($label): held, never committed" ;;
  esac
}
hostile_name_case "café.md, core.quotePath default (true)" "café.md"
hostile_name_case 'd"q.md (embedded double quote)' 'd"q.md'
hostile_name_case 'back\slash.md (embedded backslash)' 'back\slash.md'
# review-683-r2 P3-7: the review's EXACT names, not the softened
# `:(exclude)star.md`/`*.md`/`[ab].md`/`:!x.md` variants used in round 1 —
# the un-suffixed forms are what actually collide with pathspec magic
# syntax byte-for-byte.
hostile_name_case ':(exclude)* (pathspec-magic-shaped name)' ':(exclude)*'
hostile_name_case ':(top)zz.md (pathspec-magic-shaped name)' ':(top)zz.md'
hostile_name_case "a space" "a b.md"
hostile_name_case "a leading dash" "-x.md"
hostile_name_case "a bare asterisk" "*"
hostile_name_case "bracket glob shape" "[ab]"
hostile_name_case ":!x (pathspec exclude-shorthand shape)" ":!x"
HOSTILE_CASE_SETUP='git -C "$G" config core.quotePath false'
hostile_name_case "café.md, core.quotePath=false" "café2.md"

# TAB/LF/CR in a path corrupt the TSV state/allowlist rows outright — per
# spec, such a path is ALWAYS held and alerts on EVERY run, never gets a
# state row, and can never be allowlisted; the operator's only path
# forward is to rename it. Two of the review's 13 names (embedded TAB,
# embedded LF) exercise exactly this branch, not ordinary one-time
# containment — checked against 3 consecutive runs with no other change,
# each of which must still alert.
poisoned_name_case() { # <label> <filename with an embedded TAB, LF or CR>
  new_fixture
  local label="$1" name="$2"
  printf 'placeholder\n' > "$G/$name"
  git -C "$G" add -- "$name"
  git -C "$G" commit -qm "add poisoned-name placeholder" >/dev/null
  git -C "$G" push -q origin HEAD:main
  printf 'placeholder\nordinary content, no secret at all\n' > "$G/$name"
  local i
  for i in 1 2 3; do
    run_safety
    [ "$RC" -ne 0 ] || bad "P1-1 poisoned filename ($label): run $i did not alert" "$OUT"
  done
  case "$OUT" in
    *"TAB/LF/CR"*) ok "P1-1 poisoned filename ($label): names why it's held every run" ;;
    *) bad "P1-1 poisoned filename ($label): no TAB/LF/CR diagnostic" "$OUT" ;;
  esac
  [ -s "$(held_state_file)" ] && bad "P1-1 poisoned filename ($label): got a state-file row despite never being allowlistable" "$(cat "$(held_state_file)")" \
    || ok "P1-1 poisoned filename ($label): never gets a state-file row"
  local remote_content
  remote_content=$(git --git-dir="$REMOTE" show "host-snapshot:$name" 2>/dev/null || echo "<no-entry>")
  case "$remote_content" in
    *"ordinary content"*) bad "P1-1 poisoned filename ($label): reached the snapshot anyway" "content=[$remote_content]" ;;
    *) ok "P1-1 poisoned filename ($label): never reaches the snapshot" ;;
  esac
}
poisoned_name_case "embedded TAB" $'ta\tb.md'
poisoned_name_case "embedded LF" $'new\nline.md'
# review-683-r2 P3-7: a CR case — the third of the three TSV-corrupting
# bytes (TAB/LF/CR), not previously exercised.
poisoned_name_case "embedded CR" $'cr\rx.md'

# Mutation evidence for P1-1: restore the old newline-split, non-literal
# pathspec code and show the hostile-name bypass reproduces. Built via
# heredoc-populated variables, not inline single-quoted literals — the
# real text contains an embedded `''` (read -d ''), which is painful and
# error-prone to escape correctly inside a single-quoted bash argument.
P1_1_OLD=$(cat <<'OLDEOF'
while IFS= read -r -d '' path; do
    [ -n "$path" ] && changed_paths+=("$path")
  done < <(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --name-only -z HEAD 2>>"$ERR")
OLDEOF
)
P1_1_NEW=$(cat <<'NEWEOF'
while IFS= read -r path; do [ -n "$path" ] && changed_paths+=("$path"); done < <(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --name-only HEAD 2>>"$ERR")
NEWEOF
)
MUTANT=$(make_mutant_git_safety "$P1_1_OLD" "$P1_1_NEW")
new_fixture
printf 'placeholder\n' > "$G/café.md"
git -C "$G" add -- café.md
git -C "$G" commit -qm "add cafe placeholder" >/dev/null
git -C "$G" push -q origin HEAD:main
printf 'placeholder\n%s\n' "$GHP_LINE" > "$G/café.md"
run_script "$MUTANT"
MUTANT_CONTENT=$(git --git-dir="$REMOTE" show "host-snapshot:café.md" 2>/dev/null || echo "<no-entry>")
case "$MUTANT_CONTENT" in
  *ghp_*) ok "P1-1 mutation evidence: the newline-split/non-literal-pathspec mutant leaks café.md's secret into host-snapshot — reproduces the exact bypass this fix closes" ;;
  *) bad "P1-1 mutation evidence: mutant unexpectedly still held café.md (fixture doesn't isolate the regression)" "content=[$MUTANT_CONTENT]" ;;
esac

# ─ P2-1 mutation evidence: skip the state rewrite on the empty-diff path ──
# (P2-1's own behavioral case — new hold, revert, re-add, must alert again
# — already lives above, in the original #628 item 9 case list; this adds
# the mutation evidence review-683 asked for.)
MUTANT=$(make_mutant_git_safety \
  'done < <(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --name-only -z HEAD 2>>"$ERR")
  # No early return here even when $changed_paths is empty (review-683' \
  'done < <(GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --name-only -z HEAD 2>>"$ERR")
  if [ "${#changed_paths[@]}" -eq 0 ]; then GROUPS_RESULT="nothing pending"; return; fi
  # (review-683 mutation: restores the removed early return) (review-683')
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_script "$MUTANT"
[ "$RC" -ne 0 ] || bad "P2-1 mutation setup: the first mutant run should have alerted (new hold)" "$OUT"
git -C "$G" checkout -q -- foo/container.json
run_script "$MUTANT"
echo "$GHP_LINE" >> "$G/foo/container.json"
run_script "$MUTANT"
[ "$RC" -eq 0 ] && ok "P2-1 mutation evidence: with the early return restored, revert-then-readd of the SAME secret goes quiet (rc=0) — reproduces the missed-re-alert bug" \
  || bad "P2-1 mutation evidence: mutant unexpectedly still alerted (fixture doesn't isolate the regression)" "$OUT"

# ─ P2-2: secret-scan-allow.sh must actually print something ───────────────
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_safety
[ "$RC" -ne 0 ] || bad "P2-2 setup: the run should have held and alerted" "$OUT"
ALLOW_OUT=$(env NANOCLAW_DIR="$NCDIR" GIT_SAFETY_DIR="$BACKUPS" HOME="$HOME2" bash "$(dirname "$REAL")/secret-scan-allow.sh" foo/container.json)
case "$ALLOW_OUT" in
  *"foo/container.json"*"ALLOW:"*) ok "P2-2: prints exactly one ready-to-append allowlist line" ;;
  *) bad "P2-2: printed nothing usable" "$ALLOW_OUT" ;;
esac
case "$ALLOW_OUT" in
  *"$GHP_LINE"*) bad "P2-2: printed the UNMASKED secret line" "$ALLOW_OUT" ;;
  *"export G..."*) ok "P2-2: the offending line is masked to its first 8 characters" ;;
  *) bad "P2-2: masking looks wrong" "$ALLOW_OUT" ;;
esac
[ -e "$G/.secret-scan-allow" ] && bad "P2-2: the helper wrote groups/.secret-scan-allow itself" "" \
  || ok "P2-2: the helper wrote nothing on its own"

# Mutation evidence for P2-2: options after `--` are pathspecs, not
# options — restore that ordering and show the helper prints nothing.
# Built via heredoc-populated variables passed through the ENVIRONMENT
# (not embedded in the python source string) — the same reliable pattern
# make_mutant_git_safety uses, for the same reason: this text is long,
# multi-line, and full of embedded quotes/backslashes that are painful and
# error-prone to escape correctly inline.
P2_2_OLD=$(cat <<'OLDEOF'
FILE_DIFF=$(git -C "$GROUPS_DIR" diff-index --no-color -p --text --no-ext-diff --no-textconv \
  --src-prefix=a/ --dst-prefix=b/ \
  --output-indicator-new="$SECRET_SCAN_NEW_INDICATOR" --output-indicator-old=- --output-indicator-context=' ' \
  HEAD -- ":(literal)$TARGET_PATH" 2>/dev/null | LC_ALL=C tr '\000' ' ')
OLDEOF
)
P2_2_NEW=$(cat <<'NEWEOF'
FILE_DIFF=$(git -C "$GROUPS_DIR" diff-index --no-color -p --text --no-ext-diff --no-textconv HEAD -- "$TARGET_PATH" \
  --src-prefix=a/ --dst-prefix=b/ \
  --output-indicator-new="$SECRET_SCAN_NEW_INDICATOR" --output-indicator-old=- --output-indicator-context=' ' 2>/dev/null)
NEWEOF
)
MUTANT_ALLOW=$(mktemp)
ALLOW_SRC="$(dirname "$REAL")/secret-scan-allow.sh"
OLDSTR="$P2_2_OLD" NEWSTR="$P2_2_NEW" SRC="$ALLOW_SRC" DST="$MUTANT_ALLOW" python3 -c "
import os
src = open(os.environ['SRC']).read()
old = os.environ['OLDSTR']
new = os.environ['NEWSTR']
assert old in src, 'mutation target text not found in secret-scan-allow.sh — source has drifted from this fixture'
open(os.environ['DST'], 'w').write(src.replace(old, new, 1))
"
chmod +x "$MUTANT_ALLOW"
MUTANT_ALLOW_OUT=$(env NANOCLAW_DIR="$NCDIR" GIT_SAFETY_DIR="$BACKUPS" HOME="$HOME2" bash "$MUTANT_ALLOW" foo/container.json)
case "$MUTANT_ALLOW_OUT" in
  *"ALLOW:"*) bad "P2-2 mutation evidence: mutant unexpectedly still printed a usable line" "$MUTANT_ALLOW_OUT" ;;
  *) ok "P2-2 mutation evidence: options placed after -- print nothing at all — reproduces the bug this fix closes" ;;
esac
rm -f "$MUTANT_ALLOW"

# ─ P3-1: an unparseable timestamp counts as epoch 0 (re-alerts), not "now" ─
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_safety
[ "$RC" -ne 0 ] || bad "P3-1 setup: the first run should have alerted" "$OUT"
HASH=$(cut -f2 "$(held_state_file)")
printf 'foo/container.json\t%s\tnot-a-timestamp\tnot-a-timestamp\n' "$HASH" > "$(held_state_file)"
run_safety
[ "$RC" -ne 0 ] && ok "P3-1: an unparseable first_seen/last_alerted re-alerts instead of going quiet" \
  || bad "P3-1: an unparseable timestamp was silently treated as fresh (rc=0)" "$OUT"

# ─ P3-3: allowlist parsing rejects an empty field or a malformed hash ─────
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_safety
[ "$RC" -ne 0 ] || bad "P3-3 setup: the first run should have alerted" "$OUT"
printf 'foo/container.json\t\ttest allow\n' > "$G/.secret-scan-allow" # empty hash field
git -C "$G" add .secret-scan-allow
git -C "$G" commit -qm "malformed: empty hash field" >/dev/null
run_safety
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null || echo "<no-entry>")
case "$CONTAINER_TIP" in
  *ghp_*) bad "P3-3: an empty allowlist field released the hold" "content=[$CONTAINER_TIP]" ;;
  *) ok "P3-3: an empty allowlist field fails closed" ;;
esac
printf 'foo/container.json\tNOTAVALIDHASH\ttest allow\n' > "$G/.secret-scan-allow" # not 64 lowercase hex chars
git -C "$G" add .secret-scan-allow
git -C "$G" commit -qm "malformed: bad hash shape" >/dev/null
run_safety
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null || echo "<no-entry>")
case "$CONTAINER_TIP" in
  *ghp_*) bad "P3-3: a malformed (non-hex) hash released the hold" "content=[$CONTAINER_TIP]" ;;
  *) ok "P3-3: a malformed hash shape fails closed" ;;
esac

# P3-5's deterministic check (the INT/TERM trap text actually contains
# `exit N`) lives above, alongside the pre-existing #628 item 6 trap-
# registration test — see the comment there for why a live SIGTERM-mid-run
# race isn't asserted here as its own case.

# ─ P3-6: bare vendor-shaped tokens, with no identifier-assignment context ─
# to fall back on, must still match — the #630 fixtures already in this
# file (`export GITHUB_TOKEN=ghu_...` etc.) also satisfy the GENERIC
# identifier alternative on their own (…TOKEN=…), so they never actually
# proved the vendor-specific gh[ousr]_/  (sk|rk)_live_/xox[abpre]-/
# (AKIA|ASIA) alternatives fire independently.
secret_case "bare github user-to-server token (ghu_), no identifier context"  'ghu_16C7e42F292c6912E7710c838347Ae178B4a'
secret_case "bare github refresh token (ghr_), no identifier context"         'ghr_16C7e42F292c6912E7710c838347Ae178B4a'
secret_case "bare stripe restricted key (rk_live_), no identifier context"    'rk_live_51H8xamplekeyvalueabc123'
secret_case "bare slack rotation token (xoxe-), no identifier context"       'xoxe-1-abcdefghijklmnopqrstuvwxyz'
secret_case "bare AWS STS temp key (ASIA), no identifier context"           'ASIAABCDEFGHIJKLMNOP'

# ═══════════════════════════════════════════════════════════════════════════
# review-683-r2 on #628 item 9 (CHANGES, then APPROVED at 4853d046f/04477b72
# with 8 P3s): fixes P3-1 through P3-8. Labeled "review-683-r2 P3-N" below to
# stay distinct from round 1's own "P3-1"/"P3-3"/"P3-6" cases above, which
# are a DIFFERENT numbering from a DIFFERENT round.
# ═══════════════════════════════════════════════════════════════════════════

# ─ review-683-r2 P3-2a: a held hostile-named path's later deletion stays
# held too, exactly like case 8 above but with a name core.quotePath would
# quote — the bug this closes: a plain newline-split `ls-files --deleted`
# never matched the quoted string as a literal pathspec, so the deletion
# slipped past the exclude and reached host-snapshot as a real deletion ──
new_fixture
printf 'placeholder\n' > "$G/café.md"
git -C "$G" add -- café.md
git -C "$G" commit -qm "add café.md placeholder" >/dev/null
git -C "$G" push -q origin HEAD:main
mkdir -p "$G/bar"
echo placeholder > "$G/bar/types.ts"
git -C "$G" add bar/types.ts
git -C "$G" commit -qm "add bar/types.ts" >/dev/null
git -C "$G" push -q origin HEAD:main
printf 'placeholder\n%s\n' "$GHP_LINE" > "$G/café.md"
echo 'unrelated clean edit' >> "$G/bar/types.ts"
run_safety
[ "$RC" -ne 0 ] || bad "P3-2a setup: the first run should have held café.md" "$OUT"
rm -f "$G/café.md"
run_safety
git --git-dir="$REMOTE" cat-file -e "host-snapshot:café.md" 2>&1 \
  && ok "P3-2a: a held hostile-named path's entry still exists in host-snapshot after its deletion" \
  || bad "P3-2a: a held hostile-named path's deletion reached host-snapshot" ""
CAFE_TIP=$(git --git-dir="$REMOTE" show "host-snapshot:café.md" 2>/dev/null)
[ "$CAFE_TIP" = "placeholder" ] \
  && ok "P3-2a: the snapshot keeps café.md's HEAD content, not the secret and not a deletion" \
  || bad "P3-2a: unexpected snapshot content for the deleted-and-held hostile-named path" "content=[$CAFE_TIP]"

# ─ review-683-r2 P3-2b: deleting a literal `*` file does not silently drop
# every OTHER pending edit — the bug: `:(exclude)$f` with a non-literal `$f`
# equal to `*` is itself a glob matching every path, so `add -u` staged
# nothing at all and the run reported "nothing pending" (rc=0) while a real,
# unrelated edit sat unstaged forever ─────────────────────────────────────
new_fixture
printf 'literal star file\n' > "$G/*"
git -C "$G" add -- '*'
git -C "$G" commit -qm "add literal * file" >/dev/null
git -C "$G" push -q origin HEAD:main
echo 'clean edit' >> "$G/foo/container.json"
rm -f "$G/*"
run_safety
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null || echo "<no-entry>")
case "$CONTAINER_TIP" in
  *"clean edit"*) ok "P3-2b: deleting a literal '*' file doesn't drop an unrelated pending edit" ;;
  *) bad "P3-2b: deleting a literal '*' file silently dropped an unrelated pending edit" "content=[$CONTAINER_TIP]" ;;
esac

# ─ review-683-r2 P3-2 mutation evidence: restore the old newline-split,
# non-literal `:(exclude)$f` deletion handling. Uses `d"q.md`, not café.md —
# this git version does not actually C-quote valid UTF-8 like café.md in
# `ls-files` output (only genuinely unusual bytes, like an embedded double
# quote, get quoted), so café.md's deletion was excluded correctly even
# under the OLD code and never isolated this regression. `d"q.md` reliably
# gets quoted (`"d\"q.md"`), which the old non-literal exclude then fails
# to match.
P3_2_OLD=$(cat <<'OLDEOF'
  local deleted=() f
  while IFS= read -r -d '' f; do
    [ -n "$f" ] && deleted+=("$f")
  done < <(GIT_INDEX_FILE="$TMPIDX" git -C "$G" ls-files --deleted -z)
  local excludes=("${GROUPS_SENSITIVE_EXCLUDES[@]}")
  for f in "${deleted[@]}"; do excludes+=(":(exclude,literal)$f"); done
OLDEOF
)
P3_2_NEW=$(cat <<'NEWEOF'
  local deleted=() f
  while IFS= read -r f; do [ -n "$f" ] && deleted+=("$f"); done < <(GIT_INDEX_FILE="$TMPIDX" git -C "$G" ls-files --deleted) # MUTATED (review-683-r2 P3-2): newline-split, quoted paths never match
  local excludes=("${GROUPS_SENSITIVE_EXCLUDES[@]}")
  for f in "${deleted[@]}"; do excludes+=(":(exclude)$f"); done # MUTATED: non-literal pathspec
NEWEOF
)
# The P3-1 pre-write-tree guard (added further below in the real script)
# independently catches ANY unexpected staged deletion in the scratch
# index, regardless of cause — so a mutant with ONLY the P3-2 deletion-
# exclusion code reverted still gets caught by P3-1's guard before
# write-tree, refusing cleanly instead of reproducing the P3-2 bug (this
# was measured empirically while building this fixture: the deletion DOES
# reach the scratch index as intended, but the run then refuses with
# "the scratch index has a staged deletion... refusing to commit from an
# unaccountable index" — a real defense-in-depth property of P3-1, but it
# means P3-2's OWN fix can't be isolated without ALSO disabling P3-1's
# guard in this one mutant.
GUARD2_OLD=$(cat <<'OLDEOF'
  if [ ! -f "$TMPIDX" ]; then
    FAILURES+=("groups: the scratch index vanished before write-tree — refusing to commit from an unaccountable index")
    GROUPS_RESULT="failed (missing scratch index)"; return
  fi
  if ! GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --no-ext-diff --no-textconv --diff-filter=D --quiet HEAD 2>>"$ERR"; then
    FAILURES+=("groups: the scratch index has a staged deletion, which never happens by design — refusing to commit from an unaccountable index")
    GROUPS_RESULT="failed (unexpected staged deletion)"; return
  fi
OLDEOF
)
GUARD2_NEW=$(cat <<'NEWEOF'
  : # MUTATED (review-683-r2 P3-2 selfcheck): P3-1's guard disabled too, to isolate P3-2's own fix
NEWEOF
)
MUTDIR=$(mktemp -d)
FIXTURE_DIRS+=("$MUTDIR")
mkdir -p "$MUTDIR/lib"
ln -s "$(dirname "$REAL")/lib/secret-scan.sh" "$MUTDIR/lib/secret-scan.sh"
OLDSTR1="$P3_2_OLD" NEWSTR1="$P3_2_NEW" OLDSTR2="$GUARD2_OLD" NEWSTR2="$GUARD2_NEW" \
  SRC="$REAL" DST="$MUTDIR/git-safety.sh" python3 -c "
import os
src = open(os.environ['SRC']).read()
o1, n1 = os.environ['OLDSTR1'], os.environ['NEWSTR1']
o2, n2 = os.environ['OLDSTR2'], os.environ['NEWSTR2']
assert o1 in src, 'P3-2 mutation target text not found — source has drifted from this fixture'
assert o2 in src, 'P3-1 guard text not found — source has drifted from this fixture'
src = src.replace(o1, n1, 1)
src = src.replace(o2, n2, 1)
open(os.environ['DST'], 'w').write(src)
"
chmod +x "$MUTDIR/git-safety.sh"
MUTANT="$MUTDIR/git-safety.sh"
DQ_NAME='d"q.md'
new_fixture
printf 'placeholder\n' > "$G/$DQ_NAME"
git -C "$G" add -- ":(literal)$DQ_NAME"
git -C "$G" commit -qm "add d-quote placeholder" >/dev/null
git -C "$G" push -q origin HEAD:main
mkdir -p "$G/bar"
echo placeholder > "$G/bar/types.ts"
git -C "$G" add bar/types.ts
git -C "$G" commit -qm "add bar/types.ts" >/dev/null
git -C "$G" push -q origin HEAD:main
printf 'placeholder\n%s\n' "$GHP_LINE" > "$G/$DQ_NAME"
echo 'unrelated clean edit' >> "$G/bar/types.ts"
run_script "$MUTANT"
rm -f "$G/$DQ_NAME"
run_script "$MUTANT"
git --git-dir="$REMOTE" cat-file -e "host-snapshot:$DQ_NAME" 2>&1 \
  && bad "P3-2 mutation evidence: mutant unexpectedly still kept d\"q.md's entry (fixture doesn't isolate the regression)" "" \
  || ok "P3-2 mutation evidence: with P3-1's guard ALSO disabled to isolate it, the newline-split/non-literal-pathspec mutant lets a held hostile-named path's deletion reach host-snapshot for real — reproduces the exact bug this fix closes"

# ─ review-683-r2 P3-4: refusing on an unrelated binary change must not skip
# the hold's own state-file bookkeeping — the bug: the binary check used to
# run and `return` BEFORE the per-file hold loop and its state rewrite, so
# an active hold's row (first_seen/last_alerted) never got written while a
# binary change also sat pending, the same staleness class as P2-1 ───────
new_fixture
printf 'text\n' > "$G/bar.bin"
git -C "$G" add bar.bin
git -C "$G" commit -qm "add bar.bin" >/dev/null
git -C "$G" push -q origin HEAD:main
echo "$GHP_LINE" >> "$G/foo/container.json"
printf '\x00\x01\x02binary' > "$G/bar.bin"
run_safety
[ "$RC" -ne 0 ] || bad "P3-4 setup: a new hold plus a binary change should refuse" "$OUT"
case "$OUT" in
  *"binary change"*) ok "P3-4: the run refuses for the unrelated binary change, as before" ;;
  *) bad "P3-4: no binary-change refusal in the output" "$OUT" ;;
esac
STATE_FILE=$(held_state_file)
grep -q "^foo/container\.json"$'\t' "$STATE_FILE" 2>/dev/null \
  && ok "P3-4: the hold's state-file row was written even though the run also refused for the unrelated binary change" \
  || bad "P3-4: no state-file row for the held path — bookkeeping was skipped" "$(cat "$STATE_FILE" 2>/dev/null)"

# ─ review-683-r2 P3-5: a leading, trailing, or doubled TAB in an allowlist
# line must be rejected as malformed — `IFS=$'\t' read` silently collapsed
# all three, wrongly accepting them as well-formed ────────────────────────
new_fixture
echo "$GHP_LINE" >> "$G/foo/container.json"
run_safety
[ "$RC" -ne 0 ] || bad "P3-5 setup: the first run should have alerted" "$OUT"
HASH=$(allow_hash "foo/container.json" "$GHP_LINE")
printf '\tfoo/container.json\t%s\ttest allow\n' "$HASH" > "$G/.secret-scan-allow" # leading TAB
git -C "$G" add .secret-scan-allow
git -C "$G" commit -qm "malformed: leading TAB" >/dev/null
run_safety
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null || echo "<no-entry>")
case "$CONTAINER_TIP" in
  *ghp_*) bad "P3-5: a leading-TAB allowlist line released the hold" "content=[$CONTAINER_TIP]" ;;
  *) ok "P3-5: a leading-TAB allowlist line is rejected as malformed" ;;
esac
printf 'foo/container.json\t%s\ttest allow\t\n' "$HASH" > "$G/.secret-scan-allow" # trailing TAB
git -C "$G" add .secret-scan-allow
git -C "$G" commit -qm "malformed: trailing TAB" >/dev/null
run_safety
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null || echo "<no-entry>")
case "$CONTAINER_TIP" in
  *ghp_*) bad "P3-5: a trailing-TAB allowlist line released the hold" "content=[$CONTAINER_TIP]" ;;
  *) ok "P3-5: a trailing-TAB allowlist line is rejected as malformed" ;;
esac
printf 'foo/container.json\t\t%s\ttest allow\n' "$HASH" > "$G/.secret-scan-allow" # doubled TAB
git -C "$G" add .secret-scan-allow
git -C "$G" commit -qm "malformed: doubled TAB" >/dev/null
run_safety
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null || echo "<no-entry>")
case "$CONTAINER_TIP" in
  *ghp_*) bad "P3-5: a doubled-TAB allowlist line released the hold" "content=[$CONTAINER_TIP]" ;;
  *) ok "P3-5: a doubled-TAB allowlist line is rejected as malformed" ;;
esac
# Sanity: a genuinely well-formed line still releases the hold, so P3-5's
# rejection isn't overbroad.
printf 'foo/container.json\t%s\ttest allow\n' "$HASH" > "$G/.secret-scan-allow"
git -C "$G" add .secret-scan-allow
git -C "$G" commit -qm "well-formed allow" >/dev/null
run_safety
CONTAINER_TIP=$(git --git-dir="$REMOTE" show host-snapshot:foo/container.json 2>/dev/null || echo "<no-entry>")
case "$CONTAINER_TIP" in
  *ghp_*) ok "P3-5: a genuinely well-formed allowlist line still releases the hold" ;;
  *) bad "P3-5: a well-formed line was wrongly rejected too" "content=[$CONTAINER_TIP]" ;;
esac

# ─ review-683-r2 P3-6: an alert naming a TAB/LF/CR-poisoned path renders it
# via `printf %q`, so an embedded LF can't truncate/corrupt the displayed
# alert line ────────────────────────────────────────────────────────────
new_fixture
printf 'placeholder\n' > "$G/"$'new\nline.md'
git -C "$G" add -- $'new\nline.md'
git -C "$G" commit -qm "add poisoned-name placeholder" >/dev/null
git -C "$G" push -q origin HEAD:main
printf 'placeholder\nordinary content, no secret at all\n' > "$G/"$'new\nline.md'
run_safety
case "$OUT" in
  *'new\nline.md'*) ok "P3-6: the alert line %q-quotes an embedded-LF filename intact, on one line, instead of truncating it" ;;
  *) bad "P3-6: no %q-quoted form of the poisoned filename in the alert output" "$OUT" ;;
esac

# ─ review-683-r2 P3-1: the pre-write-tree guard refuses on an unaccountable
# scratch index, whatever put it in that state — both failure shapes ─────
new_fixture
echo 'clean edit' >> "$G/foo/container.json"
TMPIDX_GONE_OLD=$(cat <<'OLDEOF'
  GIT_INDEX_FILE="$TMPIDX" git -C "$G" add -u -- . "${excludes[@]}" 2>>"$ERR" || {
    FAILURES+=("groups: staging tracked changes into the scratch index failed"); GROUPS_RESULT="failed (add -u)"; return; }
OLDEOF
)
TMPIDX_GONE_NEW=$(cat <<'NEWEOF'
  GIT_INDEX_FILE="$TMPIDX" git -C "$G" add -u -- . "${excludes[@]}" 2>>"$ERR" || {
    FAILURES+=("groups: staging tracked changes into the scratch index failed"); GROUPS_RESULT="failed (add -u)"; return; }
  rm -f "$TMPIDX" # FAULT INJECTION (review-683-r2 P3-1 selfcheck): simulate the scratch index vanishing mid-run
NEWEOF
)
MUTANT_GONE=$(make_mutant_git_safety "$TMPIDX_GONE_OLD" "$TMPIDX_GONE_NEW")
run_script "$MUTANT_GONE"
[ "$RC" -ne 0 ] && ok "P3-1: refuses when the scratch index vanished before write-tree" \
  || bad "P3-1: did not refuse on a missing scratch index" "$OUT"
case "$OUT" in
  *"vanished before write-tree"*) ok "P3-1: names the missing-index reason" ;;
  *) bad "P3-1: no missing-index diagnostic in the output" "$OUT" ;;
esac
git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1 \
  && bad "P3-1: a host-snapshot branch was pushed despite the missing-index refusal" "" \
  || ok "P3-1: nothing was pushed when the scratch index vanished"

new_fixture
echo 'clean edit' >> "$G/foo/container.json"
STAGED_DEL_OLD=$(cat <<'OLDEOF'
  GIT_INDEX_FILE="$TMPIDX" git -C "$G" add -u -- . "${excludes[@]}" 2>>"$ERR" || {
    FAILURES+=("groups: staging tracked changes into the scratch index failed"); GROUPS_RESULT="failed (add -u)"; return; }
OLDEOF
)
STAGED_DEL_NEW=$(cat <<'NEWEOF'
  GIT_INDEX_FILE="$TMPIDX" git -C "$G" add -u -- . "${excludes[@]}" 2>>"$ERR" || {
    FAILURES+=("groups: staging tracked changes into the scratch index failed"); GROUPS_RESULT="failed (add -u)"; return; }
  GIT_INDEX_FILE="$TMPIDX" git -C "$G" rm --cached -q -- foo/container.json 2>>"$ERR" # FAULT INJECTION (review-683-r2 P3-1 selfcheck): simulate an unaccountable staged deletion
NEWEOF
)
MUTANT_STAGED_DEL=$(make_mutant_git_safety "$STAGED_DEL_OLD" "$STAGED_DEL_NEW")
run_script "$MUTANT_STAGED_DEL"
[ "$RC" -ne 0 ] && ok "P3-1: refuses when the scratch index has an unexpected staged deletion" \
  || bad "P3-1: did not refuse on an unexpected staged deletion" "$OUT"
case "$OUT" in
  *"unexpected staged deletion"* | *"staged deletion, which never happens by design"*) ok "P3-1: names the staged-deletion reason" ;;
  *) bad "P3-1: no staged-deletion diagnostic in the output" "$OUT" ;;
esac
git --git-dir="$REMOTE" rev-parse --verify -q host-snapshot >/dev/null 2>&1 \
  && bad "P3-1: a host-snapshot branch was pushed despite the staged-deletion refusal" "" \
  || ok "P3-1: nothing was pushed when the scratch index had an unexpected staged deletion"

# ─ review-683-r2 P3-1 mutation evidence: same staged-deletion fault as
# above, but with the guard ALSO removed — without it, write-tree proceeds
# on the unaccountable index and a wrong tree (missing foo/container.json)
# actually gets pushed to host-snapshot ────────────────────────────────
GUARD_OLD=$(cat <<'OLDEOF'
  if [ ! -f "$TMPIDX" ]; then
    FAILURES+=("groups: the scratch index vanished before write-tree — refusing to commit from an unaccountable index")
    GROUPS_RESULT="failed (missing scratch index)"; return
  fi
  if ! GIT_INDEX_FILE="$TMPIDX" git -C "$G" diff --cached --no-ext-diff --no-textconv --diff-filter=D --quiet HEAD 2>>"$ERR"; then
    FAILURES+=("groups: the scratch index has a staged deletion, which never happens by design — refusing to commit from an unaccountable index")
    GROUPS_RESULT="failed (unexpected staged deletion)"; return
  fi
OLDEOF
)
GUARD_NEW=$(cat <<'NEWEOF'
  : # MUTATED (review-683-r2 P3-1): pre-write-tree guard removed entirely
NEWEOF
)
DST_DIR=$(mktemp -d)
FIXTURE_DIRS+=("$DST_DIR")
mkdir -p "$DST_DIR/lib"
ln -s "$(dirname "$REAL")/lib/secret-scan.sh" "$DST_DIR/lib/secret-scan.sh"
OLDSTR1="$STAGED_DEL_OLD" NEWSTR1="$STAGED_DEL_NEW" OLDSTR2="$GUARD_OLD" NEWSTR2="$GUARD_NEW" \
  SRC="$REAL" DST="$DST_DIR/git-safety.sh" python3 -c "
import os
src = open(os.environ['SRC']).read()
o1, n1 = os.environ['OLDSTR1'], os.environ['NEWSTR1']
o2, n2 = os.environ['OLDSTR2'], os.environ['NEWSTR2']
assert o1 in src, 'P3-1 fault-injection target text not found — source has drifted from this fixture'
assert o2 in src, 'P3-1 guard text not found — source has drifted from this fixture'
src = src.replace(o1, n1, 1)
src = src.replace(o2, n2, 1)
open(os.environ['DST'], 'w').write(src)
"
chmod +x "$DST_DIR/git-safety.sh"
MUTANT_NOGUARD="$DST_DIR/git-safety.sh"
new_fixture
echo 'clean edit' >> "$G/foo/container.json"
run_script "$MUTANT_NOGUARD"
git --git-dir="$REMOTE" cat-file -e host-snapshot:foo/container.json 2>&1 \
  && bad "P3-1 mutation evidence: mutant unexpectedly still kept foo/container.json's entry (fixture doesn't isolate the guard)" "" \
  || ok "P3-1 mutation evidence: without the guard, the unaccountable staged-deletion fault ships a wrong tree (foo/container.json missing from host-snapshot) — reproduces exactly what the guard closes"

[ "$FAILED" -eq 0 ] && echo "git-safety-selfcheck: all checks passed" || echo "git-safety-selfcheck: FAILURES"
exit "$FAILED"
