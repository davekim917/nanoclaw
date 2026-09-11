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
#
# [^A-Za-z0-9]{0,6} in the last WARN alternative (not {0,3}): under this
# file's LC_ALL=C (see below), a character class counts BYTES, not
# characters — a single multibyte punctuation character (e.g. a smart
# quote at 3 bytes each in UTF-8) can burn most of a small budget by
# itself. {0,3} let a real match — a curly-quoted "password" : x line —
# slip through under a UTF-8 locale but miss under LC_ALL=C (found and
# fixed the identical regression in scripts/lib/secret-scan.sh,
# nanoclaw-v2#658 round 2; verified empirically there: the exact same
# line counts 0 hits at {0,3} under LC_ALL=C, 1 at {0,6}).
SECRET_BLOCK_RE='(xox[abpre]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9.-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
SECRET_WARN_RE='((sk|rk)_live_[A-Za-z0-9]{10,}|ASIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+|[A-Za-z][A-Za-z0-9+.-]*://[^/@[:space:]:]+:[^/@[:space:]]+@|authorization:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9._-]{10,}|[A-Za-z_][A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PASS)[A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[^[:space:]]|(token|api[_-]?key|password|secret)[^A-Za-z0-9]{0,6}[:=][[:space:]]*[^[:space:]])'

# _wiki_secret_scan_added_lines <unified-diff-text>
# Emits ADDED lines (unified-diff `+` lines) on stdout, excluding the
# `+++` file-header line. LC_ALL=C throughout this file: under a UTF-8
# locale (the host's installed units run LANG=en_US.UTF-8; a container's
# locale is not something this hook controls either), GNU grep classifies
# a diff containing an invalid UTF-8 byte as BINARY and silently emits
# nothing for `-c`/plain matching instead of the line — verified
# empirically while building scripts/lib/secret-scan.sh (nanoclaw-v2#658):
# a line combining bytes 0x80-0x82 with a real token counted 0 hits under
# LANG=en_US.UTF-8, 1 under LC_ALL=C. C locale treats every byte as plain
# text, so that misclassification never triggers.
#
# The header exclusion is narrow on purpose: an ADDED line is itself
# printed as `+` followed by its own content, so a real added line whose
# content starts with `++ ` (e.g. `++ token=abc123...`) becomes
# `+++ token=abc123...` on the wire — syntactically identical to a
# `+++ ` file-header line. A blanket `^\+\+\+ ` exclusion drops that
# line's content along with the real headers (same bug, same fix, as
# secret-scan.sh's secret_scan_hits — nanoclaw-v2#658 round 2). Matching
# only the shapes `git diff` actually emits for a header — `+++ b/<path>`,
# `+++ "b/<path>"` (git C-quotes a path with non-ASCII bytes), or
# `+++ /dev/null` (file deleted) — means an added line that merely LOOKS
# like a header still gets scanned; any real header shape this pattern
# doesn't recognize also still gets scanned, which is the safe direction.
# scripts/wiki-pre-push-hook.sh pins --src-prefix=a/ --dst-prefix=b/ on
# its `git diff` call specifically so the header always has this shape,
# regardless of a user's diff.noprefix/diff.mnemonicPrefix config.
_wiki_secret_scan_added_lines() {
  LC_ALL=C grep -E '^\+' <<<"$1" | LC_ALL=C grep -vE '^\+\+\+ ("?b/|/dev/null$)'
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
