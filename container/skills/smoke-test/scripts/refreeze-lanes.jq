# refreeze-lanes.jq — which required lanes a pair re-freeze left un-redispatched.
#
# A lane dispatched before `smoke-pair-identity.sh refreeze` gathered its
# evidence against the OLD pair. The one sanctioned way to retire that
# evidence is `smoke-run-scaffold.sh redispatch`, which bumps the lane's
# `.lanes[].generation` in the completion contract (smoke-run-scaffold.sh:596-604);
# `contract --regenerate` bumps every lane at once (:400-414). So `refreeze`
# records the contract's lane generations at that moment (`rl_lane_snapshot`),
# and a lane counts as redispatched after the re-freeze exactly when its
# contract generation is now ABOVE its snapshot generation
# (`rl_stale_after_refreeze`).
#
# Two gates read this one definition, so they cannot disagree about it:
# `smoke-pair-identity.sh finish` and `smoke-evidence-barrier.sh`'s `lanes` and
# `synthesis` phases. Use with `jq -L <this dir>` and `include "refreeze-lanes";`.
# Written for jq 1.6, the container's Debian jq.

# markers/<id>.json -> <id>, the barrier's own `basename "$marker" .json`
# (smoke-evidence-barrier.sh, the requiredLaneMarkers loop).
def rl_lane_id: sub("^.*/"; "") | sub("\\.json$"; "");

# The generation a contract assigns lane $id, read exactly as the scaffold's
# marker verb (smoke-run-scaffold.sh:522-524) and the barrier's
# expected_generation read it: 1 when the contract has no lanes[] entry, or no
# generation, for that id.
def rl_lane_generation($id):
  [.lanes[]? | select(type == "object") | select(.id == $id) | (.generation // 1)][0] // 1;

def rl_positive_int: type == "number" and . >= 1 and . == floor;

def rl_contract_ok:
  type == "object"
  and (.sourceSha | type == "string")
  and (.requiredLaneMarkers | type == "array")
  and all(.requiredLaneMarkers[]; type == "string" and length > 0);

# Input: the parsed contract, or null when the run has none yet. Output: the
# object `refreeze` stores as identity.json's `refreezeLaneSnapshot`, or
# {error} when the contract cannot be read (refreeze then writes nothing).
# A snapshot covers EVERY required lane, started or not: nothing on disk tells
# a lane still in flight on the old pair from one never started, and
# redispatching an unstarted lane costs one generation bump.
def rl_lane_snapshot:
  if . == null then {contractPresent: false, sourceSha: null, lanes: []}
  elif (rl_contract_ok | not) then {error: "completion-contract.json does not read as a contract"}
  else . as $c
    | [ $c.requiredLaneMarkers[] | rl_lane_id as $id
        | {id: $id, generation: ($c | rl_lane_generation($id))} ] as $lanes
    | ([ $lanes[] | select(.generation | rl_positive_int | not) | .id ]) as $bad
    | if ($bad | length) == 0
      then {contractPresent: true, sourceSha: $c.sourceSha, lanes: $lanes}
      else {error: ("completion-contract.json has a lane generation that is not a positive integer: " + ($bad | join(", ")))}
      end
  end;

# Input: identity.json. True once `refreeze` has run: it appends to history[]
# and bumps freezeGeneration, so either one set means a re-freeze happened.
def rl_refrozen:
  ((.history // []) | if type == "array" then length > 0 else true end)
  or ((.freezeGeneration // 1) != 1);

# Input: identity.json. $contract: the parsed contract, null when the run has
# none, or any non-object when it could not be parsed.
# Output: {refrozen, stale: [lane ids, contract order], error: string|null}.
# Every doubt answers `error`, never an empty `stale`: a missing snapshot, a
# malformed one, or a contract that vanished after the snapshot was taken.
def rl_stale_after_refreeze($contract):
  if (rl_refrozen | not) then {refrozen: false, stale: [], error: null}
  else .refreezeLaneSnapshot as $s
  | if ($s | type) != "object" or ($s.contractPresent | type) != "boolean" then
      {refrozen: true, stale: [], error: "identity.json records a re-freeze but no lane snapshot (refreezeLaneSnapshot), so nothing shows the lanes were redispatched after it"}
    elif $s.contractPresent == false then
      # No contract at the re-freeze means no lane had been dispatched yet;
      # SKILL.md requires the contract before any dispatch.
      {refrozen: true, stale: [], error: null}
    elif ($s.sourceSha | type) != "string" or ($s.lanes | type) != "array"
         or (all($s.lanes[]; type == "object" and (.id | type == "string") and (.generation | rl_positive_int)) | not) then
      {refrozen: true, stale: [], error: "identity.json's refreezeLaneSnapshot is malformed"}
    elif $contract == null then
      {refrozen: true, stale: [], error: "completion-contract.json is missing, but the re-freeze snapshotted one, so the redispatched lanes cannot be told apart"}
    elif ($contract | rl_contract_ok | not) then
      {refrozen: true, stale: [], error: "completion-contract.json does not read as a contract"}
    elif $contract.sourceSha != $s.sourceSha then
      # Re-scaffolded on another build after the re-freeze: the barrier's
      # sourceSha check already refuses every marker written before that.
      {refrozen: true, stale: [], error: null}
    else
      ([ $s.lanes[] | {key: .id, value: .generation} ] | from_entries) as $snap
      | {refrozen: true, error: null,
         stale: [ $contract.requiredLaneMarkers[] | rl_lane_id as $id
                  | select($snap | has($id))
                  | ($contract | rl_lane_generation($id)) as $g
                  | select(($g | rl_positive_int | not) or $g <= $snap[$id])
                  | $id ]}
    end
  end;
