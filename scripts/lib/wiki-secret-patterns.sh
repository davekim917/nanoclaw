# Two-tier secret-shaped-content patterns for scripts/wiki-pre-push-hook.sh.
# ONE source of truth: scripts/install-wiki-pre-push-hook.sh copies this
# file byte-for-byte to `.git/hooks/nanoclaw-secret-patterns.sh` next to the
# installed hook — never a separately-maintained duplicate. This file is
# fully self-contained (no `source` of anything else) so that copy works
# standing alone inside a repo's `.git/hooks/`, which is the only thing
# bind-mounted into an agent's container for a canonical repository
# (container-runner.ts — see scripts/wiki-pre-push-hook.sh's header for the
# full mount citation); the hook cannot assume nanoclaw-v2's own scripts/
# tree is reachable from in there.
#
# Two tiers instead of one SECRET_RE (contrast scripts/git-safety.sh, which
# keeps its single broad, over-inclusive pattern and is unchanged by this
# file): git-safety.sh refuses the WHOLE commit before anything is staged,
# so a false positive there costs one manual `git diff` and a re-run, never
# a lost push. A `pre-push` hook that BLOCKS is a harder tradeoff — the
# #658 review measured the broad pattern refusing roughly 14 of 150 real
# wiki commits (base64-embedded fonts, a UI string literally containing
# "Hide password"), and a hook with that false-positive rate teaches agents
# to reach for `git push --no-verify`, which defeats the hook far more
# reliably than any pattern gap would.
#
#   SECRET_BLOCK_RE — high-confidence vendor token SHAPES only (a fixed
#                     prefix plus a long enough random-looking suffix).
#                     These essentially never appear by coincidence in
#                     prose, config comments, or binary/font blobs, so
#                     blocking a push on one is safe. Blocks the push
#                     (non-zero exit).
#   SECRET_WARN_RE  — the fuzzier shapes (identifier assignment forms like
#                     `*_PASS=`, loose `password: ...`, connection-string
#                     credentials, JWTs, Stripe/Google/AWS-STS shapes):
#                     still worth a human's attention, but too
#                     collision-prone with ordinary prose/config to block a
#                     push on. Printed to stderr, never blocks.
# A line matching BLOCK often also satisfies a WARN alternative (e.g. the
# generic KEY/TOKEN/SECRET identifier form) — callers check BLOCK first and
# only need WARN for lines that didn't already block, so nothing double-
# reports in both tiers for the same line.
SECRET_BLOCK_RE='(xox[abpre]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9.-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
SECRET_WARN_RE='((sk|rk)_live_[A-Za-z0-9]{10,}|ASIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+|[A-Za-z][A-Za-z0-9+.-]*://[^/@[:space:]:]+:[^/@[:space:]]+@|authorization:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9._-]{10,}|[A-Za-z_][A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PASS)[A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]]|(token|api[_-]?key|password|secret)[^A-Za-z0-9]{0,3}[:=][[:space:]]*[^[:space:]])'

# _wiki_secret_scan_added_lines <unified-diff-text>
# Emits ADDED lines (unified-diff `+` lines, excluding the `+++` file
# header) on stdout. LC_ALL=C throughout this file: under a UTF-8 locale
# (the host's installed units run LANG=en_US.UTF-8; a container's locale is
# not something this hook controls either), GNU grep classifies a diff
# containing an invalid UTF-8 byte as BINARY and silently emits nothing for
# `-c`/plain matching instead of the line — verified empirically while
# building scripts/lib/secret-scan.sh (nanoclaw-v2#658): a line combining
# bytes 0x80-0x82 with a real token counted 0 hits under LANG=en_US.UTF-8,
# 1 under LC_ALL=C. C locale treats every byte as plain text, so that
# misclassification never triggers.
_wiki_secret_scan_added_lines() {
  LC_ALL=C grep -E '^\+' <<<"$1" | LC_ALL=C grep -vE '^\+\+\+ '
}

# secret_scan_block_hits / secret_scan_warn_hits <unified-diff-text>
# Count ADDED lines matching the respective tier, case-insensitively. Never
# fail under `set -e`: an empty/no-match grep would otherwise return 1 and
# abort the caller.
secret_scan_block_hits() {
  _wiki_secret_scan_added_lines "$1" | LC_ALL=C grep -icE "$SECRET_BLOCK_RE" || true
}
secret_scan_warn_hits() {
  _wiki_secret_scan_added_lines "$1" | LC_ALL=C grep -icE "$SECRET_WARN_RE" || true
}
