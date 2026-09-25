# Whether a PR-body statement's value shows at least one character, for the
# lines merge-check and audit read a value from (`Review-notes: none (...)`,
# `Replaces:`). Strip every \p{Cf} (format) character first — a zero-width
# space, word joiner or BOM alone must not pass for a value, and a soft hyphen
# or an emoji ZWJ sequence must not sink an otherwise-visible one. A handful of
# codepoints look blank but are not \p{Cf}, so they are named explicitly; a
# combining mark is excluded outright, since a real base character elsewhere
# already satisfies this test on its own, and a combining mark with no base
# must not (#707 P3-b). Loaded with `jq -L <this directory>` and
# `include "visible-text";`.
def has_visible_text:
  gsub("\\p{Cf}"; "")
  | test("[^\\s\\p{Z}\\p{Cc}\\p{M}\\x{2800}\\x{3164}\\x{115F}\\x{1160}\\x{FFA0}]");
