# An Actions job GitHub never started: completed with no runner ever assigned
# and no step run. That is the billing lockout's shape — "The job was not
# started because recent account payments have failed..." (annotation on check
# run 105741202176, run 35388540873, 2026-09-18: runner_id 0, runner_name "",
# steps []) — against a job that ran and failed, which always has a runner and
# steps (run 35185456083: runner "GitHub Actions 1000006727", 25 steps).
#
# codex-review.sh (never_started_runs, required_status_red) decides with it
# whether a `CI (host)` status may stand in for a required workflow. Loaded
# with `jq -L <this directory>` and `include "never-started";`.
def never_started: .status == "completed" and ((.steps // []) | length) == 0 and (.runner_id // 0) == 0 and (.runner_name // "") == "";
