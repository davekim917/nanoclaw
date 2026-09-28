def cut_down_exempt:
  test("(^|/)(__tests__|__snapshots__|__mocks__|tests?|spec|fixtures?)/")
  or test("\\.(test|spec)\\.[^/]+$")
  or test("(^|/)test_[^/]*\\.py$")
  or test("_test\\.[^/.]+$")
  or test("(\\.lock(b|file|\\.json)?|-lock\\.(json|yaml))$")
  or test("(^|/)(npm-shrinkwrap\\.json|Package\\.resolved)$");

# Added lines outside tests and lockfiles in a compare response, or "unknown"
# when the listing reaches GitHub's 300-file cap and may be missing files.
def cut_down_lines:
  if (.files | type) != "array" then error("the comparison lists no files")
  elif (.files | length) >= 300 then "unknown"
  elif all(.files[]; (.filename | type) == "string" and (.additions | type) == "number") | not then
    error("a changed file has no filename or added-line count")
  else [ .files[] | select(.filename | cut_down_exempt | not) | .additions ] | add // 0 end;
