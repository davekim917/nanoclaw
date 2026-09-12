# A PR body as merge-check reads its statement lines (`Fixes-PR:`,
# `Review-notes:`): with every code fence and HTML comment cut, since a line
# inside either is an example or a template, not a statement. Fences follow
# CommonMark: up to 3 spaces, then 3+ backticks or 3+ tildes; only a bare run
# of the same character, at least as long, closes one; an unclosed fence runs
# to the end, as GitHub renders it.
def unfenced:
  reduce split("\n")[] as $line ({out: [], fence: null};
    ($line | capture("^ {0,3}(?<run>`{3,}|~{3,})") // null) as $open
    | if .fence == null then
        if $open then .fence = $open.run else .out += [$line] end
      elif $open and ($open.run[0:1] == .fence[0:1]) and (($open.run | length) >= (.fence | length))
           and ($line | test("^ {0,3}" + $open.run + "[ \t]*\r?$")) then .fence = null
      else . end)
  | .out | join("\n");
# Exactly one string, or an error: each caller turns it into ONE verdict line,
# and a refactor that yields none or two (`.body | values | …`) must fail
# loudly rather than leave a check with nothing to read. The callers also
# accept only an exact verdict, for a module that is wrong altogether.
def pr_body_text:
  [ .body // "" | unfenced | gsub("<!--[\\s\\S]*?(-->|$)"; "") ]
  | if length == 1 and (.[0] | type) == "string" then .[0]
    else error("pr_body_text must yield exactly one string, got \(length)") end;
