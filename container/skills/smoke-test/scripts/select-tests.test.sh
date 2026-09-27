#!/usr/bin/env bash
# select-tests.py over a fictional repo: every way a suite can depend on a file
# (by path only, sourced through a helper, a cite pin, a python import, a
# symlink) selects it, prose does not chain, and anything unmapped runs the
# FULL set. The selector is copied into the fixture so it finds that repo.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export PYTHONDONTWRITEBYTECODE=1
FAILED=0
ok() { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAILED=1; }
R="$T/repo"
S="container/skills/demo/scripts"
put() { mkdir -p "$(dirname "$R/$1")" && cat >"$R/$1"; }

git init -q "$R"
put container/skill-shell-tests.test.ts <<'EOF'
const EXCLUDED_SUITES = [
  {
    relPath: 'container/needs-docker.test.sh',
    reason: 'docker',
  },
];
EOF
put container/needs-docker.test.sh <<<'exit 1'
put "$S/fx-checker.sh" <<'EOF'
. "$(dirname "$0")/fx-helper.sh"
EOF
put "$S/fx-helper.sh" <<<'true'
put "$S/by-path.test.sh" <<'EOF'
DIR="$(dirname "$0")"; bash "$DIR/fx-checker.sh"
EOF
put "$S/tool.py" <<<'x = 1'
put "$S/fx-pins.test.sh" <<'EOF'
cite tool.py 1 'x = 1'
EOF
put "$S/mod_x.py" <<<'VALUE = 1'
put "$S/imports.test.sh" <<'EOF'
python3 -c 'import sys; sys.path.insert(0, "."); import mod_x'
EOF
put "$S/real-target.sh" <<<'true'
ln -s real-target.sh "$R/$S/alias.sh"
put "$S/link.test.sh" <<'EOF'
bash "$(dirname "$0")/alias.sh"
EOF
put "$S/guide.md" <<<'Run unrelated.sh to see it.'
put "$S/unrelated.sh" <<<'true'
put "$S/reads-guide.test.sh" <<'EOF'
grep -q . "$(dirname "$0")/guide.md"
EOF
put "$S/other.test.sh" <<'EOF'
bash "$(dirname "$0")/unrelated.sh"
EOF
put "$S/lonely-data.json" <<<'{}'
put "$S/quiet.sh" <<<'true'
put "$S/runs-quiet.test.sh" <<'EOF'
bash "$(dirname "$0")/quiet.sh"
EOF
put "$S/mentions-quiet.test.sh" <<'EOF'
# same idea as quiet.sh, but this suite never runs it
true
EOF
put container/skills/demo/SKILL.md <<<'demo'
put container/skills/other/SKILL.md <<<'other'
put container/skills/other/scripts/names-demo.test.sh <<'EOF'
grep -q demo "$(dirname "$0")/../../demo/SKILL.md"
EOF
put container/skills/other/scripts/generic.test.sh <<'EOF'
grep -q . SKILL.md
EOF
put src/app.ts <<<'export const a = 1;'
put docs/notes.md <<<'notes'
put "$S/fails.test.sh" <<<'exit 3'
put "$S/select-tests.test.sh" <<<'python3 "$(dirname "$0")/select-tests.py" --help >/dev/null'
put "$S/reads-gate.test.sh" <<<'grep -q relPath "$(dirname "$0")/../../../skill-shell-tests.test.ts"'
mkdir -p "$R/$S"
cp "$SCRIPT_DIR/select-tests.py" "$R/$S/select-tests.py"
git -C "$R" add -A && git -C "$R" -c user.email=t@example.com -c user.name=t commit -qm base

SEL="$R/$S/select-tests.py"
pick() { python3 "$SEL" "$@" 2>"$T/err" | tr '\n' ' ' | sed 's/ $//'; }
expect() { # <label> <expected suites, space-separated, repo-relative> <changed...>
  local label="$1" want="$2" got; shift 2
  got="$(pick "$@")"
  if [ "$got" = "$want" ]; then ok "$label"; else fail "$label: want [$want] got [$got] ($(cat "$T/err"))"; fi
}
ALL="$(cd "$R" && git ls-files '*.test.sh' | grep -v needs-docker | sort | tr '\n' ' ' | sed 's/ $//')"
expect_full() { # <label> <changed...>
  local label="$1"; shift
  local got; got="$(pick "$@")"
  if [ "$got" = "$ALL" ] && grep -q 'FULL set' "$T/err"; then ok "$label"; else fail "$label: got [$got] ($(cat "$T/err"))"; fi
}

expect "a suite that runs a script only by path is selected" "$S/by-path.test.sh" "$S/fx-checker.sh"
expect "a helper sourced by that script selects the same suite" "$S/by-path.test.sh" "$S/fx-helper.sh"
expect "a cite pin selects the suite" "$S/fx-pins.test.sh" "$S/tool.py"
expect "a python import selects the suite" "$S/imports.test.sh" "$S/mod_x.py"
expect "a symlink's target selects the suite that runs the link" "$S/link.test.sh" "$S/real-target.sh"
expect "prose that names a script does not chain to its readers" "$S/other.test.sh" "$S/unrelated.sh"
expect "a name in a comment is not a reference" "$S/runs-quiet.test.sh" "$S/quiet.sh"
expect "a doc a suite reads selects that suite" "$S/reads-guide.test.sh" "$S/guide.md"
expect "a changed suite selects itself" "$S/fx-pins.test.sh" "$S/fx-pins.test.sh"
expect "a shared basename counts where its dir qualifies it, or in its own skill" \
  "container/skills/other/scripts/names-demo.test.sh" container/skills/demo/SKILL.md
expect "the same basename in the referrer's own skill counts unqualified" \
  "container/skills/other/scripts/generic.test.sh container/skills/other/scripts/names-demo.test.sh" container/skills/other/SKILL.md
expect "an excluded suite is never selected" "" container/needs-docker.test.sh
expect "src/ and docs/ files no suite names select nothing" "" src/app.ts docs/notes.md
expect_full "a file no suite names under container/ runs the full set" "$S/lonely-data.json"
expect_full "a deleted file no suite names runs the full set" "$S/gone.sh"
expect_full "the gate itself runs the full set" container/skill-shell-tests.test.ts
expect "the selector is covered by its own test" "$S/select-tests.test.sh" "$S/select-tests.py"
expect_full "--all runs the full set" --all
expect_full "one unmapped file among mapped ones still runs the full set" "$S/fx-checker.sh" "$S/lonely-data.json"

echo 'true # edited' >>"$R/$S/tool.py"
echo 'new' >"$R/$S/untracked-note.md"
expect_full "with no paths the diff from the merge base is used, untracked included" --base HEAD
rm "$R/$S/untracked-note.md"
expect "with no paths a working-tree edit is picked up" "$S/fx-pins.test.sh" --base HEAD

if python3 "$SEL" --run -j 2 "$S/fx-checker.sh" >"$T/run.out" 2>&1 && grep -q "PASS .*by-path.test.sh" "$T/run.out"; then
  ok "--run runs the selected suites and passes"
else
  fail "--run on a passing suite: $(cat "$T/run.out")"
fi
if python3 "$SEL" --run "$S/fails.test.sh" >"$T/run.out" 2>&1; then
  fail "--run exited 0 with a failing suite: $(cat "$T/run.out")"
else
  grep -q "FAIL .*fails.test.sh" "$T/run.out" && ok "--run reports a failing suite and exits non-zero" ||
    fail "--run failure output: $(cat "$T/run.out")"
fi

[ "$FAILED" = 0 ] || { echo "select-tests tests FAILED" >&2; exit 1; }
echo "select-tests tests passed"
