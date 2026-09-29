# One comment body's answer as an independent-review receipt for head $head:
# {clear, said}, or nothing when it carries no receipt for that head, or only
# clear ones it will not vouch for (not first in the body, or beside another
# marker): those clear nothing and mask nothing. The merge
# gate asks about the PR's head; the churn gate passes "" to judge each receipt
# against the head it names, and one that names none is no receipt.
def independent_verdict($re; $jsonRe; $head):
  [ ltrimstr("﻿") | splits($re) ] as $parts
  | select(($parts | length) > 1)
  | [ range(1; $parts | length) as $i
      | $parts[$i] as $rest
      | (([ $rest | capture($jsonRe) | .json ] | first) // $rest) as $text
      | ([ $text | try fromjson catch null | objects ] | first) as $doc
      | (if $head != "" then $head
         else ($doc.head? | strings) // ([ $text | match("[0-9a-f]{40}") | .string ] | first) end) as $h
      | select(($h != null and ($text | contains($h))) or ($doc != null and ($doc.head | type) != "string"))
      | { clear: ($doc != null and $doc.head == $h and $doc.verdict == "CLEAR" and $doc.blocking_findings == 0
                  and ($text | contains("\\") | not)
                  and all("head", "verdict", "blocking_findings"; . as $k | [ $text | match("\"\($k)\""; "g") ] | length == 1)),
          said: (if $doc == null then "its JSON block does not parse"
                 else "verdict \($doc.verdict // "missing" | tostring), blocking_findings \($doc.blocking_findings // "missing" | tostring)" end) } ] as $receipts
  | ([ $receipts[] | select(.clear | not) ] | first) as $no
  | if $no != null then { clear: false, said: $no.said }
    elif ($parts | length) == 2 and ($receipts | length) == 1 and ($parts[0] | test("\\A[ \t\r\n]*\\z")) then { clear: true, said: "" }
    else empty end;
