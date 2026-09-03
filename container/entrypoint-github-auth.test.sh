#!/usr/bin/env bash
# Container-side GitHub credential wiring, run with plain bash — no docker.
#
# The block under test is lifted VERBATIM out of entrypoint.sh between its two
# section markers, with the one substitution that makes it safe to run on a
# developer's machine: the hardcoded `/tmp/bin` helper directory is rewritten to
# a temp dir. Everything else — the heredocs, the git config calls, the retry
# loop — is the shipped text, so this cannot drift into testing a copy.
#
# Run: bash container/entrypoint-github-auth.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT="$SCRIPT_DIR/entrypoint.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

BIN="$ROOT/bin"
STUBS="$ROOT/stubs"
mkdir -p "$STUBS"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

# --- Lift the block out of the shipped entrypoint -------------------------
BLOCK="$ROOT/github-auth-block.sh"
awk '/^# --- GitHub git auth ---$/{f=1} /^# --- Render CLI workspace pre-config ---$/{f=0} f' "$ENTRYPOINT" \
  | sed "s|/tmp/bin|$BIN|g" > "$BLOCK"
grep -q 'nanoclaw-git-creds' "$BLOCK" || fail "could not extract the GitHub auth block from entrypoint.sh"
grep -q 'GITHUB_TOKEN_FILE' "$BLOCK" || fail "extracted block has no GITHUB_TOKEN_FILE handling"
grep -q '/tmp/bin' "$BLOCK" && fail "extraction left a literal /tmp/bin — the test would write to the real host path"
pass "extracted the shipped block ($(wc -l < "$BLOCK") lines)"

# --- gh stub: records its argv and the GH_TOKEN it was handed -------------
cat > "$STUBS/gh" <<'STUB'
#!/usr/bin/env bash
echo "argv=$*" >> "$GH_STUB_LOG"
echo "GH_TOKEN=${GH_TOKEN:-}" >> "$GH_STUB_LOG"
echo "GITHUB_TOKEN=${GITHUB_TOKEN:-}" >> "$GH_STUB_LOG"
STUB
chmod +x "$STUBS/gh"

# Runs the block in a clean subshell. Each case gets its own HOME (so
# `git config --global` is observable and isolated) and its own gh stub log.
# `set +u` matches entrypoint.sh, which runs under `set -e` only.
run_block() {
  local case_dir="$1"; shift
  rm -rf "$BIN" "$case_dir"
  mkdir -p "$case_dir" "$BIN"
  : > "$case_dir/gh.log"
  env -i \
    PATH="$STUBS:/usr/bin:/bin" \
    HOME="$case_dir" \
    GH_STUB_LOG="$case_dir/gh.log" \
    "$@" \
    bash -c 'set -e; set +u; source "$0"' "$BLOCK"
}

# =========================================================================
echo "1. file mode, no org scope"
CASE="$ROOT/case1"
TOKEN_FILE="$ROOT/case1-token"
mkdir -p "$(dirname "$TOKEN_FILE")"
printf 'ghs_from_file\n' > "$TOKEN_FILE"
run_block "$CASE" GITHUB_TOKEN_FILE="$TOKEN_FILE" || fail "block exited nonzero in file mode"

[ -x "$BIN/nanoclaw-git-creds" ] || fail "credential helper not written"
[ -x "$BIN/nanoclaw-gh-token" ] || fail "token reader not written"

out=$(GITHUB_TOKEN_FILE="$TOKEN_FILE" "$BIN/nanoclaw-git-creds" get) || fail "credential helper exited nonzero"
[ "$out" = "username=x-access-token
password=ghs_from_file" ] || fail "credential helper output wrong: $out"
pass "credential helper reads the mounted file"

HOME="$CASE" git config --global --get 'credential.https://github.com.helper' | grep -q "$BIN/nanoclaw-git-creds" \
  || fail "github.com credential helper not configured in file mode"
HOME="$CASE" git config --global --get 'credential.https://gist.github.com.helper' >/dev/null \
  || fail "gist.github.com credential helper not configured in file mode"
pass "git wired to the helper for github.com and gist.github.com"

grep -q 'setup-git' "$CASE/gh.log" && fail "gh auth setup-git ran in file mode — it would read gh's empty env"
pass "gh auth setup-git skipped in file mode"

[ -x "$BIN/gh" ] || fail "gh shim not written"
GITHUB_TOKEN_FILE="$TOKEN_FILE" GH_STUB_LOG="$CASE/gh.log" PATH="$BIN:$STUBS:/usr/bin:/bin" gh api user >/dev/null \
  || fail "gh shim exited nonzero"
grep -q '^GH_TOKEN=ghs_from_file$' "$CASE/gh.log" || fail "gh shim did not export GH_TOKEN from the file"
grep -q '^GITHUB_TOKEN=ghs_from_file$' "$CASE/gh.log" || fail "gh shim did not export GITHUB_TOKEN from the file"
grep -q '^argv=api user$' "$CASE/gh.log" || fail "gh shim did not forward argv to the real binary"
pass "gh shim resolves the token per invocation and execs the real gh"

# THE POINT OF THE WHOLE CHANGE: a host rewrite reaches an already-running
# container. Nothing is re-sourced here — only the file changed.
printf 'ghs_rotated\n' > "$TOKEN_FILE"
out=$(GITHUB_TOKEN_FILE="$TOKEN_FILE" "$BIN/nanoclaw-git-creds" get) || fail "helper failed after rotation"
echo "$out" | grep -q '^password=ghs_rotated$' || fail "helper did not pick up the rotated token: $out"
GITHUB_TOKEN_FILE="$TOKEN_FILE" GH_STUB_LOG="$CASE/gh.log" PATH="$BIN:$STUBS:/usr/bin:/bin" gh api user >/dev/null
grep -q '^GH_TOKEN=ghs_rotated$' "$CASE/gh.log" || fail "gh shim did not pick up the rotated token"
pass "a rewrite of the file is live for both git and gh, with no respawn"

# Torn read: the host truncates before writing, so a reader can catch the file
# mid-write. No trailing newline means "not fully written" — refuse it.
printf 'ghs_par' > "$TOKEN_FILE"
if out=$(GITHUB_TOKEN_FILE="$TOKEN_FILE" "$BIN/nanoclaw-git-creds" get 2>/dev/null); then
  fail "credential helper accepted a torn (unterminated) token file: $out"
fi
echo "$out" | grep -q 'password' && fail "credential helper emitted a password for a torn read"
pass "torn read refused instead of handing git half a token"

printf '\n' > "$TOKEN_FILE"
GITHUB_TOKEN_FILE="$TOKEN_FILE" "$BIN/nanoclaw-git-creds" get >/dev/null 2>&1 \
  && fail "credential helper accepted an empty token file"
pass "empty token file refused"

# =========================================================================
echo "2. file mode + GITHUB_ALLOWED_ORGS"
CASE="$ROOT/case2"
printf 'ghs_from_file\n' > "$TOKEN_FILE"
run_block "$CASE" GITHUB_TOKEN_FILE="$TOKEN_FILE" GITHUB_ALLOWED_ORGS="acme, widgets" \
  || fail "block exited nonzero with org scoping"

HOME="$CASE" git config --global --get 'credential.https://github.com/acme/.helper' >/dev/null \
  || fail "acme org helper not configured"
HOME="$CASE" git config --global --get 'credential.https://github.com/widgets/.helper' >/dev/null \
  || fail "widgets org helper not configured (whitespace not trimmed?)"
HOME="$CASE" git config --global --get 'credential.https://github.com.helper' >/dev/null 2>&1 \
  && fail "org scoping must NOT install a global github.com helper — that defeats the scope"
pass "per-org helpers only, unchanged from the env-mode behavior"

grep -q 'setup-git' "$CASE/gh.log" && fail "gh auth setup-git ran under org scoping"
pass "gh auth setup-git still skipped under org scoping"

out=$(GITHUB_TOKEN_FILE="$TOKEN_FILE" "$BIN/nanoclaw-git-creds" get)
echo "$out" | grep -q '^password=ghs_from_file$' || fail "org-scoped helper does not read the file"
pass "org-scoped helper reads the file"

# =========================================================================
echo "3. legacy env mode (GITHUB_TOKEN_IN_ENV=1 on the host), no org scope"
CASE="$ROOT/case3"
run_block "$CASE" GH_TOKEN=ghp_from_env || fail "block exited nonzero in env mode"

grep -q 'argv=auth setup-git' "$CASE/gh.log" || fail "gh auth setup-git did not run in env mode"
pass "gh auth setup-git still runs — legacy path unchanged"

[ -x "$BIN/gh" ] && fail "gh shim written in env mode — gh already reads GH_TOKEN itself"
pass "no gh shim in env mode"

out=$(NANOCLAW_GH_TOKEN=ghp_from_env "$BIN/nanoclaw-git-creds" get) || fail "env-fallback helper exited nonzero"
echo "$out" | grep -q '^password=ghp_from_env$' || fail "helper did not fall back to NANOCLAW_GH_TOKEN: $out"
pass "helper falls back to NANOCLAW_GH_TOKEN when no file is mounted"

# =========================================================================
echo "4. legacy env mode + GITHUB_ALLOWED_ORGS"
CASE="$ROOT/case4"
run_block "$CASE" GH_TOKEN=ghp_from_env GITHUB_ALLOWED_ORGS=acme || fail "block exited nonzero"

HOME="$CASE" git config --global --get 'credential.https://github.com/acme/.helper' >/dev/null \
  || fail "acme org helper not configured in env mode"
grep -q 'setup-git' "$CASE/gh.log" && fail "gh auth setup-git ran under env-mode org scoping"
pass "env-mode org scoping byte-identical to before"

# =========================================================================
echo "5. file mode wins when BOTH are set"
CASE="$ROOT/case5"
printf 'ghs_from_file\n' > "$TOKEN_FILE"
run_block "$CASE" GITHUB_TOKEN_FILE="$TOKEN_FILE" GH_TOKEN=ghp_from_env || fail "block exited nonzero"
out=$(GITHUB_TOKEN_FILE="$TOKEN_FILE" NANOCLAW_GH_TOKEN=ghp_from_env "$BIN/nanoclaw-git-creds" get)
echo "$out" | grep -q '^password=ghs_from_file$' || fail "env shadowed the file: $out"
pass "the mounted file is authoritative"

# =========================================================================
echo "6. no credential at all"
CASE="$ROOT/case6"
run_block "$CASE" || fail "block exited nonzero with no credential"
[ -e "$BIN/nanoclaw-git-creds" ] && fail "helper written with no credential configured"
[ -e "$CASE/.gitconfig" ] && fail "git config touched with no credential configured"
grep -q . "$CASE/gh.log" && fail "gh invoked with no credential configured"
pass "no credential, no helper, no git config, no gh call"

echo
echo "PASS — container GitHub credential wiring"
