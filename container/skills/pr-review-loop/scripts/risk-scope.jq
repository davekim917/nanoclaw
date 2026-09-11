# risk:high's globs from .github/labeler.yml, and the match actions/labeler v7
# makes against them. codex-review.sh includes this module to compute a
# risk-scoped PR's verdict from its changed files (`jq -L <this dir> 'include
# "risk-scope"; …'`); scripts/risk-scope.test.ts replays it against every
# tracked path. Plain jq, so the host and an agent container run the same code.

# The globs under the one `risk:high` key, read from the raw YAML. Only the
# shape scripts/labeler-config.test.ts pins is read — one rule holding one
# `any-glob-to-any-file` block list of quoted globs:
#
#   risk:high:
#   - changed-files:
#     - any-glob-to-any-file:
#       - 'src/router.ts'
#
# Anything else is an error, which codex-review.sh turns into a `review`
# verdict: a second rule (the labeler ANDs rules), another match option, a flow
# list, a plain, escaped or multi-line scalar, an anchor, a repeated key. Blank
# lines and comments may sit anywhere, as YAML allows.
def risk_high_globs:
  def key: "^(risk:high|'risk:high'|\"risk:high\")[ \t]*:";
  def tail: "([ \t]+(#.*)?)?$";
  def shape: error("risk:high in .github/labeler.yml is not the one shape codex-review.sh reads (- changed-files: - any-glob-to-any-file: - '<glob>' ...)");
  [ split("\n")[] | sub("\r$"; "") ] as $lines
  | [ range($lines | length) | select($lines[.] | test(key)) ] as $at
  | if ($at | length) != 1 then error("risk:high is defined \($at | length) times in .github/labeler.yml")
    elif ($lines[$at[0]] | test(key + tail) | not) then shape
    else . end
  # The key's block runs to the next line that opens a top-level entry;
  # comments and `- ` entries at column 0 still belong to it.
  | $lines[$at[0] + 1:]
  | .[:(map(test("^[^ \t#-]")) | index(true)) // length]
  | map(select(test("^[ \t]*(#.*)?$") | not)) as $body
  | (($body[0] // "") | capture("^(?<dash> *)-(?<gap> +)changed-files:" + tail) // shape) as $rule
  | (($body[1] // "") | capture("^(?<dash> *)-(?<gap> +)any-glob-to-any-file:" + tail) // shape) as $option
  # A child sequence starts at or right of its key's column; anything left of
  # it is a sibling — a second match option, or a second rule.
  | if ($option.dash | length) < ($rule.dash + "-" + $rule.gap | length) then shape else . end
  | [ $body[2:][]
      | capture("^(?<dash> *)-(?<gap> +)(?:'(?<single>(?:[^']|'')*)'|\"(?<double>[^\"\\\\]*)\")" + tail) // shape ] as $items
  | if ($items | length) == 0
       or ([ $items[].dash ] | unique | length) != 1
       or ($items[0].dash | length) < ($option.dash + "-" + $option.gap | length)
    then shape else . end
  | [ $items[] | if .single != null then .single | gsub("''"; "'") else .double end ];

# One glob as a regex over a whole path, matching as minimatch `{dot: true}`
# does — what actions/labeler v7 builds: `new Minimatch(g, {dot})`
# (src/changedFiles.ts:229 at tag v7), with its `dot` input defaulting to true
# (action.yml:17-19), which .github/workflows/risk-label.yml leaves alone. Only
# the syntax labeler.yml uses is supported: literal characters, `*`, `?`, and
# `**` as a whole segment. Braces, classes, extglobs, escapes, negation,
# comments, and empty, `.` or `..` segments are errors, which codex-review.sh
# turns into a `review` verdict instead of a guess.
def glob_regex:
  # Under dot: true a wildcard may match a name that starts with a dot, but a
  # segment it opens never matches `.` or `..`, and neither does `**`.
  def notraverse: "(?!\\.\\.?(?:/|\\z))";
  def any_segment: notraverse + "[^/]*";
  def segment:
    if . == "*" then notraverse + "[^/]+"
    else (if test("^[*?]") then notraverse else "" end)
      + ([ explode[] | [.] | implode
           | if . == "*" then "[^/]*"
             elif . == "?" then "[^/]"
             elif test("[.^$|+]") then "\\" + .
             else . end ]
         | join(""))
    end;
  if type != "string" or . == "" then error("risk:high holds an empty glob")
  elif test("[\\[\\]{}()\\\\]|^[!#]|^/|/$|//|(^|/)\\.\\.?(/|$)") then error("risk:high glob \(tojson) uses syntax codex-review.sh does not match")
  else
    # Consecutive `**` segments match what one does.
    (split("/") | reduce .[] as $s ([]; if $s == "**" and .[-1] == "**" then . else . + [$s] end)) as $segs
    | ($segs | length) as $n
    | reduce range($n) as $i ("";
        $segs[$i] as $s
        | if $s != "**" then . + (if $i > 0 and $segs[$i - 1] != "**" then "/" else "" end) + ($s | segment)
          # `**` matches zero or more whole segments, so it carries its own
          # slashes: `a/**/b` matches `a/b`, and `a/**` does not match `a`.
          elif $i < $n - 1 then . + (if $i > 0 then "/" else "" end) + "(?:" + any_segment + "/)*"
          elif $i > 0 then . + "(?:/" + any_segment + ")+"
          else . + any_segment + "(?:/" + any_segment + ")*" end)
    | "\\A" + . + "\\z"
  end;

# The input paths that any of $regexes (each from glob_regex) matches.
def matching($regexes): [ .[] | select(. as $path | any($regexes[]; . as $re | $path | test($re))) ];
