# Posting order of issue comments, by fullDatabaseId: a BigInt GitHub
# serializes as a digit string. Compared as strings, length first, and never
# through `tonumber`, which is a double on jq 1.6 and rounds ids past 2^53
# together.
def canonical_id: type == "string" and test("\\A[1-9][0-9]*\\z");
def posting_key: [ length, . ];
