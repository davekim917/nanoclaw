#!/usr/bin/env bash
# Docker smoke for the by-reference GitHub credential, against a real agent image.
#
# Verifies inside a container, with the image's own git and gh, that:
#   1. `git credential fill` returns the token from the read-only mounted file
#   2. `gh` resolves the same token (offline — `gh auth token`, no API call)
#   3. rewriting the host file IN PLACE is picked up by the RUNNING container
#
# Nothing here talks to GitHub. Token values are fake.
#
# Usage: bash container/entrypoint-github-auth.smoke.sh [image]
#        With no argument, uses this install's own agent image.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRYPOINT="$SCRIPT_DIR/entrypoint.sh"

# Image names are per-checkout so two installs on one host don't collide, so a
# hardcoded default would be wrong everywhere. Derive it the way build.sh and
# setup/probe.sh do.
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE="${1:-$(container_image_base):latest}"
ROOT="$(mktemp -d)"
NAME="nanoclaw-ghtoken-smoke-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; rm -rf "$ROOT"; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

mkdir -p "$ROOT/gh-token"
chmod 0700 "$ROOT/gh-token"
printf 'ghs_smoke_first\n' > "$ROOT/gh-token/token"
chmod 0600 "$ROOT/gh-token/token"

docker run -d --rm --name "$NAME" \
  --user "$(id -u):$(id -g)" \
  --entrypoint bash \
  -e GITHUB_TOKEN_FILE=/run/nanoclaw/gh-token/token \
  -v "$ROOT/gh-token:/run/nanoclaw/gh-token:ro" \
  -v "$ENTRYPOINT:/tmp/entrypoint-under-test.sh:ro" \
  "$IMAGE" -c 'sleep 300' >/dev/null \
  || fail "could not start $IMAGE — run ./container/build.sh first, or pass an existing image as \$1 (the derived name follows the checkout path, so a worktree derives a different one)"

# Run the shipped GitHub block, then persist the resulting env for later execs.
docker exec "$NAME" bash -c '
set -e
awk "/^# --- GitHub git auth ---\$/{f=1} /^# --- Render CLI workspace pre-config ---\$/{f=0} f" \
  /tmp/entrypoint-under-test.sh > /tmp/blk.sh
grep -q nanoclaw-git-creds /tmp/blk.sh
set +u; source /tmp/blk.sh
' || fail "GitHub auth block failed inside the container"

# git and gh are invoked in fresh execs, exactly like the agent would: the block
# already wrote ~/.gitconfig and /tmp/bin, and GITHUB_TOKEN_FILE is container env.
IN="docker exec -e PATH=/tmp/bin:/usr/local/bin:/usr/bin:/bin $NAME"

helper=$($IN git config --global --get 'credential.https://github.com.helper') \
  || fail "no credential helper configured for github.com"
echo "$helper" | grep -q 'nanoclaw-git-creds' || fail "unexpected helper: $helper"
pass "git credential helper wired to the file reader"

creds=$($IN bash -c 'printf "protocol=https\nhost=github.com\n\n" | git credential fill') \
  || fail "git credential fill failed"
echo "$creds" | grep -qx 'username=x-access-token' || fail "wrong username: $creds"
echo "$creds" | grep -qx 'password=ghs_smoke_first' || fail "git did not get the file token: $creds"
pass "git credential fill returns the mounted token (real git, real helper)"

tok=$($IN gh auth token 2>/dev/null) || fail "gh auth token failed — shim not resolving the file"
[ "$tok" = "ghs_smoke_first" ] || fail "gh resolved '$tok', expected ghs_smoke_first"
pass "gh authenticates from the file, offline, via the PATH shim"

$IN bash -c '[ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]' \
  || fail "a credential VALUE is present in the container env — the whole point was to remove it"
pass "no GITHUB_TOKEN/GH_TOKEN value in the container environment"

docker inspect "$NAME" --format '{{json .Config.Env}}' | grep -q 'ghs_smoke_first' \
  && fail "the container spec carries the credential value"
pass "docker inspect shows a path, not a credential"

# The headline: rewrite in place and the RUNNING container sees it.
printf 'ghs_smoke_rotated\n' > "$ROOT/gh-token/token"
creds=$($IN bash -c 'printf "protocol=https\nhost=github.com\n\n" | git credential fill')
echo "$creds" | grep -qx 'password=ghs_smoke_rotated' || fail "running container still on the old token: $creds"
tok=$($IN gh auth token 2>/dev/null)
[ "$tok" = "ghs_smoke_rotated" ] || fail "gh still on the old token: $tok"
pass "an in-place host rewrite reaches a RUNNING container — no respawn"

# A remapped uid: the image owns /home/node as its build-time uid (1001) and a
# macOS install runs the host service as 501, so $HOME is not writable in the
# container. `git config --global` fails there and, under the entrypoint's
# `set -e`, used to take the container down during startup.
echo
echo "remapped uid (501) — the shape a macOS install lands in:"
# A real uid-501 host writes this file AS uid 501 at 0600, so the container
# reads it by ownership. This test cannot chown without root, so it stands the
# ownership in for permissions. The mode is the fixture's, not the product's —
# planGitHubTokenSpawn still writes 0600, asserted in github-token-file.test.ts.
mkdir -p "$ROOT/gh-token-501"
chmod 0755 "$ROOT/gh-token-501"
cp "$ROOT/gh-token/token" "$ROOT/gh-token-501/token"
chmod 0644 "$ROOT/gh-token-501/token"
docker run --rm --user 501:501 -e HOME=/home/node \
  -e GITHUB_TOKEN_FILE=/run/nanoclaw/gh-token/token \
  -v "$ROOT/gh-token-501:/run/nanoclaw/gh-token:ro" \
  -v "$ENTRYPOINT:/tmp/entrypoint-under-test.sh:ro" \
  --entrypoint bash "$IMAGE" -c '
    awk "/^# --- GitHub git auth ---\$/{f=1} /^# --- Render CLI workspace pre-config ---\$/{f=0} f" \
      /tmp/entrypoint-under-test.sh > /tmp/blk.sh
    set -e; set +u; source /tmp/blk.sh; set +e
    printf "protocol=https\nhost=github.com\n\n" | git credential fill
    gh auth token' > "$ROOT/uid501.txt" 2>"$ROOT/uid501.err" \
  || fail "entrypoint died on a remapped uid: $(cat "$ROOT/uid501.err")"
grep -qx 'password=ghs_smoke_rotated' "$ROOT/uid501.txt" || fail "no git credential on a remapped uid: $(cat "$ROOT/uid501.txt")"
grep -qx 'ghs_smoke_rotated' "$ROOT/uid501.txt" || fail "gh not authenticated on a remapped uid"
pass "remapped uid boots and gets working git + gh auth"

echo
echo "PASS — by-reference GitHub credential smoke against $IMAGE"
