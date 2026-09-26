#!/usr/bin/env bash
# The observation helper: the shared case table (the host judge runs the same
# table), JSON escaping of hostile evidence, the CLI's refusal modes, and use
# as an imported module.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/task_observation.py"

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. Every case in the shared table.
python3 - "$SCRIPT_DIR" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[1])
import task_observation as t

table = json.load(open(f"{sys.argv[1]}/cases.json"))
now_ms = t.parse_since(table["now"])
failures = []
for case in table["cases"]:
    observation = case["observation"]
    problem = t.observation_problem(observation, now_ms)
    if (problem is None) != case["valid"]:
        failures.append(f"{case['name']}: expected valid={case['valid']}, got problem={problem!r}")
        continue
    if case["valid"]:
        if t.parse_bound(observation["bound"]) != case["boundMs"]:
            failures.append(f"{case['name']}: bound {t.parse_bound(observation['bound'])} != {case['boundMs']}")
        if "sinceMs" in case and t.parse_since(observation["since"]) != case["sinceMs"]:
            failures.append(f"{case['name']}: since {t.parse_since(observation['since'])} != {case['sinceMs']}")
if failures:
    print("\n".join(failures), file=sys.stderr)
    sys.exit(1)
PY

# 2. Hostile evidence round-trips exactly, on one line.
evidence=$'quote " backslash \\ newline\nsecond line tab\t unicode \xc3\xbc'
out="$(python3 "$HELPER" --kind unreadable --evidence "$evidence" --bound 90m --data '{"n": 1}')"
[ "$(printf '%s\n' "$out" | wc -l)" -eq 1 ] || fail "output is not one line: $out"
EVIDENCE="$evidence" OUT="$out" python3 - <<'PY' || fail "escaping round-trip"
import json, os
line = json.loads(os.environ["OUT"])
assert line == {
    "wakeAgent": False,
    "observation": {"kind": "unreadable", "evidence": os.environ["EVIDENCE"], "bound": "90m"},
    "data": {"n": 1},
}, line
PY

# 3. JSON evidence, since, and the default empty data.
out="$(python3 "$HELPER" --kind unfinished --evidence-json '{"pr": 12}' --bound 4h --since 2026-01-01T08:00:00Z)"
[ "$out" = '{"wakeAgent":false,"observation":{"kind":"unfinished","evidence":{"pr":12},"bound":"4h","since":"2026-01-01T08:00:00Z"},"data":{}}' ] \
  || fail "unfinished line: $out"

# 4. A wake carries data and no observation.
out="$(python3 "$HELPER" --wake --data '{"pr": 12}')"
[ "$out" = '{"wakeAgent":true,"data":{"pr":12}}' ] || fail "wake line: $out"

# 5. Refusals print nothing on stdout and exit 2.
refuses() {
  local stdout rc=0
  stdout="$(python3 "$HELPER" "$@" 2>/dev/null)" || rc=$?
  [ "$rc" -eq 2 ] || fail "expected exit 2 for: $* (got $rc)"
  [ -z "$stdout" ] || fail "stdout not empty for: $*"
}
refuses --kind empty --evidence "" --bound 1h
refuses --kind empty --evidence x --bound 4hours
refuses --kind unfinished --evidence x --bound 4h
refuses --kind unfinished --evidence x --bound 4h --since 2026-02-30T00:00:00Z
refuses --kind done --evidence x --bound 1h
refuses --kind empty --evidence-json '{}' --bound 1h
refuses --kind empty --evidence x --bound 1h --data '{"x": NaN}'
refuses --kind empty --evidence x --bound 1h --data 'not json'
refuses --wake --kind empty
refuses --evidence x --bound 1h

# 6. Imported as a module.
out="$(python3 -c "
import sys
sys.path.insert(0, '$SCRIPT_DIR')
from task_observation import ObservationError, observation_line
print(observation_line('empty', 'no new PRs', '4h', data={'checked': 3}))
try:
    observation_line('unfinished', 'x', '4h')
except ObservationError as err:
    print('refused:', err)
")"
[ "$out" = $'{"wakeAgent":false,"observation":{"kind":"empty","evidence":"no new PRs","bound":"4h"},"data":{"checked":3}}\nrefused: unfinished requires since' ] \
  || fail "module use: $out"

echo "task_observation: all checks passed"
