from __future__ import annotations

import json
from pathlib import Path
import tempfile

from graphify.extract import extract


COLLISIONS = """\
export interface Foo { value: string }
export function Foo(): string { return 'foo'; }
export function Bar(): string { return 'bar'; }
export interface Bar { value: string }
export function writeMessageOut(): string { return 'write'; }
export interface WriteMessageOut { content: string }
export interface AuthMe { userId: string }
export function authMe(): string { return 'auth'; }
export function streamGroups(): string { return 'groups'; }
export interface StreamGroups { running: string[] }
export interface VerbVerdict { allowed: boolean }
export function verbVerdict(): string { return 'verdict'; }
export function upsertSupportThread(): string { return 'thread'; }
export interface UpsertSupportThread { threadId: string }
"""

CONSUMER = """\
import { Foo, Bar, WriteMessageOut, writeMessageOut, AuthMe, authMe,
  StreamGroups, streamGroups, VerbVerdict, verbVerdict,
  UpsertSupportThread, upsertSupportThread } from './collisions';
class Holder {
  foo!: Foo; bar!: Bar; message!: WriteMessageOut; auth!: AuthMe;
  groups!: StreamGroups; verdict!: VerbVerdict; thread!: UpsertSupportThread;
}
function consume(): string {
  void Holder;
  return [Foo(), Bar(), writeMessageOut(), authMe(), streamGroups(),
    verbVerdict(), upsertSupportThread()].join(':');
}
"""

TYPE_NAMES = [
    "Foo",
    "Bar",
    "WriteMessageOut",
    "AuthMe",
    "StreamGroups",
    "VerbVerdict",
    "UpsertSupportThread",
]

FUNCTION_NAMES = [
    "Foo",
    "Bar",
    "writeMessageOut",
    "authMe",
    "streamGroups",
    "verbVerdict",
    "upsertSupportThread",
]


def run_contract() -> dict[str, int | bool]:
    with tempfile.TemporaryDirectory(prefix="graphify-engine-contract-") as tmp:
        root = Path(tmp)
        (root / "collisions.ts").write_text(COLLISIONS, encoding="utf-8")
        (root / "consumer.ts").write_text(CONSUMER, encoding="utf-8")
        paths = sorted(root.glob("*.ts"))

        def run(cache_name: str) -> dict:
            return extract(
                paths,
                cache_root=root / cache_name,
                root=root,
                parallel=False,
                max_workers=1,
            )

        first = run("cache-one")
        second = run("cache-two")
        if json.dumps(first, sort_keys=True, separators=(",", ":")) != json.dumps(
            second, sort_keys=True, separators=(",", ":")
        ):
            raise AssertionError("Graphify extraction is not deterministic")

        ids = [node["id"] for node in first["nodes"]]
        if len(ids) != len(set(ids)):
            raise AssertionError("Graphify produced duplicate node IDs")
        nodes = {
            (node.get("source_file"), node.get("label")): node["id"]
            for node in first["nodes"]
        }
        type_ids = {nodes[("collisions.ts", name)] for name in TYPE_NAMES}
        function_ids = {
            nodes[("collisions.ts", f"{name}()")]
            for name in FUNCTION_NAMES
        }
        if len(type_ids) != 7 or len(function_ids) != 7 or not type_ids.isdisjoint(function_ids):
            raise AssertionError("Graphify collapsed TypeScript type/value namespace nodes")

        calls = {
            edge["target"]
            for edge in first["edges"]
            if edge.get("relation") == "calls"
            and edge.get("source_file") == "consumer.ts"
        }
        references = {
            edge["target"]
            for edge in first["edges"]
            if edge.get("relation") == "references"
            and edge.get("source_file") == "consumer.ts"
        }
        imports = {
            edge["target"]
            for edge in first["edges"]
            if edge.get("relation") == "imports"
            and edge.get("source_file") == "consumer.ts"
        }
        if not function_ids <= calls:
            raise AssertionError("Graphify failed to resolve TypeScript value-space calls")
        if not type_ids <= references:
            raise AssertionError("Graphify failed to resolve TypeScript type-space references")
        if not type_ids | function_ids <= imports:
            raise AssertionError("Graphify failed to preserve both TypeScript import namespaces")

        return {
            "nodes": len(first["nodes"]),
            "edges": len(first["edges"]),
            "types": len(type_ids),
            "functions": len(function_ids),
            "deterministic": True,
        }


if __name__ == "__main__":
    print(json.dumps(run_contract(), sort_keys=True))
