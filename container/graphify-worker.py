#!/usr/bin/env python3
"""Private, resource-capped Graphify v0.9.16 extraction/query worker."""
from __future__ import annotations

from collections import deque
from dataclasses import asdict, dataclass
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import sys
import time
from typing import Any, Sequence


GRAPHIFY_VERSION = "0.9.16"
MAX_ADDRESS_SPACE = 1024 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_ASSET_FILE_BYTES = 5 * 1024 * 1024
MAX_ASSET_FILES = 512
MAX_ASSET_BYTES = 16 * 1024 * 1024
MAX_GRAPH_BYTES = 64 * 1024 * 1024
MAX_AST_BYTES = 128 * 1024 * 1024
MAX_TMPFS_BYTES = 192 * 1024 * 1024
MAX_DIAGNOSTIC_BYTES = 64 * 1024
MAX_METADATA_BYTES = 8 * 1024 * 1024
MAX_QUERY_RESULT_BYTES = MAX_DIAGNOSTIC_BYTES
MAX_EDGE_RECONCILIATIONS = MAX_GRAPH_BYTES // 64
MAX_SOURCE_ANCESTORS = 64
MAX_OWNERSHIP_PREFIX_PARTS = 64
THREAD_ENVIRONMENT = (
    "OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "BLIS_NUM_THREADS",
    "RAYON_NUM_THREADS", "POLARS_MAX_THREADS",
)
_METRICS: dict[str, int | float | str] = {}
CONFIG_JSON_NAMES = frozenset({
    "package.json", "tsconfig.json", "jsconfig.json", "composer.json",
    "deno.json", "deno.jsonc", "bower.json", "manifest.json", "app.json",
    "now.json", "vercel.json", "angular.json", "nest-cli.json", "biome.json",
    "biome.jsonc", "renovate.json", ".babelrc", ".babelrc.json",
    ".eslintrc.json", ".prettierrc.json", ".prettierrc", "babel.config.json",
})
CONFIG_JSON_KEYS = frozenset({
    "dependencies", "devDependencies", "peerDependencies", "optionalDependencies",
    "bundleDependencies", "bundledDependencies", "extends", "$ref", "$schema",
    "compilerOptions",
})
MCP_CONFIG_NAMES = frozenset({
    ".mcp.json", "claude_desktop_config.json", "mcp.json", "mcp_servers.json",
})
NON_GRAPH_ASSET_EXTENSIONS = frozenset({".css"})


class WorkerError(RuntimeError):
    pass


class WorkerValidationError(WorkerError):
    pass


@dataclass
class ExtractionStatus:
    detected: list[str]
    applicable: list[str]
    intentional_exclusions: list[str]
    contributed: list[str]
    unsupported: dict[str, str]
    failed: dict[str, str]
    graph_sha256: str = ""
    manifest_sha256: str = ""
    graph_bytes: int = 0


def apply_limits(address_space_bytes: int, file_bytes: int, process_count: int) -> None:
    """Set numerical thread caps and irreversible kernel ceilings."""
    for name in THREAD_ENVIRONMENT:
        os.environ[name] = "1"
    os.environ["NANOCLAW_GRAPHIFY_SEQUENTIAL"] = "1"
    os.environ["GRAPHIFY_MAX_WORKERS"] = "1"
    address_space_bytes = min(int(address_space_bytes), MAX_ADDRESS_SPACE)
    file_bytes = min(int(file_bytes), MAX_FILE_BYTES)
    if address_space_bytes <= 0 or file_bytes <= 0 or int(process_count) != 0:
        raise WorkerValidationError("worker limits must be positive AS/FSIZE and NPROC=0")
    resource.setrlimit(resource.RLIMIT_AS, (address_space_bytes, address_space_bytes))
    resource.setrlimit(resource.RLIMIT_FSIZE, (file_bytes, file_bytes))
    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))


_TASK_GUARDS_INSTALLED = False


def _task_refused(*_args, **_kwargs):
    raise RuntimeError("Graphify worker task creation is forbidden")


def _start_new_thread(_function, _args, _kwargs=None):
    raise RuntimeError("Graphify worker thread creation is forbidden")


def install_task_guards() -> None:
    """Refuse Python subprocess, multiprocessing, executor, and thread starts."""
    global _TASK_GUARDS_INSTALLED
    if _TASK_GUARDS_INSTALLED:
        return
    import _thread
    import concurrent.futures
    import multiprocessing
    import subprocess
    import threading

    subprocess.Popen = _task_refused  # type: ignore[assignment]
    multiprocessing.Process.start = _task_refused  # type: ignore[assignment]
    threading.Thread.start = _task_refused  # type: ignore[assignment]
    _thread.start_new_thread = _start_new_thread  # type: ignore[assignment]
    concurrent.futures.ThreadPoolExecutor.submit = _task_refused  # type: ignore[assignment]
    concurrent.futures.ProcessPoolExecutor.submit = _task_refused  # type: ignore[assignment]

    def audit(event: str, _args: tuple[Any, ...]) -> None:
        if event in {"subprocess.Popen", "os.fork", "os.posix_spawn", "os.posix_spawnp"}:
            raise RuntimeError(f"Graphify worker refused {event}")

    sys.addaudithook(audit)
    _TASK_GUARDS_INSTALLED = True


def _import_graphify():
    """Import the pinned private distribution after limits and task guards."""
    from importlib.metadata import version
    installed = version("graphifyy")
    if installed != GRAPHIFY_VERSION:
        raise WorkerValidationError(f"expected graphifyy {GRAPHIFY_VERSION}, got {installed}")
    from graphify.extract import extract
    return extract


def _safe_relative(root: Path, relative: str) -> Path:
    if not relative or relative.startswith("/") or "\x00" in relative:
        raise WorkerValidationError("invalid source-relative path")
    candidate = root / relative
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root.resolve(strict=True))
    except (OSError, RuntimeError, ValueError) as exc:
        raise WorkerValidationError(f"source path escapes private snapshot: {relative}") from exc
    if not resolved.is_file() or candidate.is_symlink():
        raise WorkerValidationError(f"source is not a regular snapshot file: {relative}")
    return resolved


def _stream_hash(path: Path, cap: int = 5 * 1024 * 1024) -> tuple[str, str, int, bytes]:
    sha = hashlib.sha256(); md5 = hashlib.md5(usedforsecurity=False); total = 0; content = bytearray()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > cap:
                raise WorkerValidationError(f"snapshot file exceeds limit: {path.name}")
            sha.update(chunk); md5.update(chunk); content.extend(chunk)
    return sha.hexdigest(), md5.hexdigest(), total, bytes(content)


def _verified_asset_paths(
    source_root: Path, assets: object, code_paths: set[str]
) -> set[str]:
    if not isinstance(assets, list):
        raise WorkerValidationError("invalid asset descriptor schema")
    if len(assets) > MAX_ASSET_FILES:
        raise WorkerValidationError("asset descriptor exceeds file cap")
    verified: set[str] = set()
    folded: set[str] = set()
    code_folded = {path.casefold() for path in code_paths}
    total = 0
    for item in assets:
        if not isinstance(item, dict) or set(item) != {"path", "sha256", "bytes"}:
            raise WorkerValidationError("invalid asset descriptor schema")
        relative = item.get("path")
        sha256 = item.get("sha256")
        size = item.get("bytes")
        if (
            not isinstance(relative, str)
            or "\\" in relative
            or Path(relative).as_posix() != relative
            or any(part in {"", ".", ".."} for part in Path(relative).parts)
            or not isinstance(sha256, str)
            or re.fullmatch(r"[0-9a-f]{64}", sha256) is None
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
        ):
            raise WorkerValidationError("invalid asset descriptor schema")
        alias = relative.casefold()
        if alias in folded or alias in code_folded:
            raise WorkerValidationError("asset descriptor path is ambiguous or overlaps source")
        marker = _skill_marker_owner(relative)
        if Path(relative).suffix.lower() not in NON_GRAPH_ASSET_EXTENSIONS and marker is None:
            raise WorkerValidationError("asset descriptor extension is not approved")
        if marker is not None:
            prefix, owner = marker
            owned_code = any(
                _skill_source_owner(path) == (prefix, owner) for path in code_paths
            )
            pairing_owner = (
                owner.startswith("add-")
                and any(
                    _pairing_owner(path) == (prefix, owner[4:])
                    for path in code_paths
                )
            )
            if not owned_code and not pairing_owner:
                raise WorkerValidationError("skill marker has no exact source owner")
        path = _safe_relative(source_root, relative)
        actual_sha, _md5, actual_size, _raw = _stream_hash(path, MAX_ASSET_FILE_BYTES)
        if (actual_sha, actual_size) != (sha256, size):
            raise WorkerValidationError(f"private asset snapshot hash mismatch: {relative}")
        total += actual_size
        if total > MAX_ASSET_BYTES:
            raise WorkerValidationError("asset descriptor exceeds byte cap")
        folded.add(alias)
        verified.add(relative)
    return verified


def _intentional_data_json(relative: str, content: bytes) -> bool:
    path = Path(relative)
    if path.suffix.lower() != ".json":
        return False
    if len(content) > 1_048_576:
        raise WorkerValidationError(f"JSON source exceeds v0.9.16 extractor limit: {relative}")
    try:
        value = json.loads(content)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise WorkerValidationError(f"invalid JSON source: {relative}: {exc}") from exc
    exact_name = path.name
    # graphify.extract._get_extractor routes these exact names through the
    # higher-priority MCP ingester before generic .json dispatch.
    if exact_name in MCP_CONFIG_NAMES:
        return False
    name = exact_name.casefold()
    if name in CONFIG_JSON_NAMES or name.endswith((
        ".eslintrc.json", ".prettierrc.json", ".babelrc.json", "tsconfig.json", "jsconfig.json"
    )):
        return False
    if isinstance(value, dict) and any(key in CONFIG_JSON_KEYS for key in value):
        return False
    return True


def _canonical_source(value: object, expected: Sequence[str]) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    # Graphify's patched source anchor emits repository-relative paths. Reject
    # absolute/parent traversal instead of transforming them into a different
    # repository name; leading-dot names such as .mcp.json are semantic.
    parts = normalized.split("/")
    if normalized.startswith("/") or (parts and parts[0].endswith(":")) or ".." in parts:
        return None
    if normalized in expected:
        return normalized
    matches = [item for item in expected if Path(item).name == Path(normalized).name]
    return matches[0] if len(matches) == 1 else None


def _edge_endpoints(edge: dict) -> tuple[object, object]:
    return edge.get("source", edge.get("from")), edge.get("target", edge.get("to"))


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _edge_sort_key(edge: dict) -> tuple[str, ...]:
    return (
        str(edge.get("source", "")), str(edge.get("target", "")),
        str(edge.get("relation", "")), str(edge.get("context", "")),
        str(edge.get("source_file", "")), str(edge.get("source_location", "")),
        _canonical_json(edge),
    )


def _line_number(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"L([1-9][0-9]*)", value)
    return int(match.group(1)) if match else None


def _is_ast_import(edge: dict) -> bool:
    return (
        edge.get("_origin") == "ast"
        and edge.get("confidence") == "EXTRACTED"
        and edge.get("context") == "import"
        and edge.get("relation") in {"imports", "imports_from"}
        and _line_number(edge.get("source_location")) is not None
    )


def _safe_ownership_parts(relative: str) -> tuple[str, ...] | None:
    path = Path(relative)
    parts = path.parts
    if (
        not relative
        or "\\" in relative
        or "\x00" in relative
        or path.is_absolute()
        or path.as_posix() != relative
        or any(part in {"", ".", ".."} for part in parts)
    ):
        return None
    return parts


def _pairing_owner(relative: str) -> tuple[tuple[str, ...], str] | None:
    parts = _safe_ownership_parts(relative)
    if parts is None or len(parts) < 2 or parts[-2] != "setup":
        return None
    channel = re.fullmatch(r"pair-([a-z0-9-]+)\.ts", parts[-1])
    prefix = parts[:-2]
    if channel is None or len(prefix) > MAX_OWNERSHIP_PREFIX_PARTS:
        return None
    return prefix, channel.group(1)


def _skill_source_owner(relative: str) -> tuple[tuple[str, ...], str] | None:
    parts = _safe_ownership_parts(relative)
    if parts is None:
        return None
    candidates: list[tuple[tuple[str, ...], str]] = []
    for index in range(len(parts) - 3):
        if parts[index:index + 2] != (".claude", "skills"):
            continue
        owner = parts[index + 2]
        if re.fullmatch(r"[a-z0-9][a-z0-9._-]*", owner) is not None:
            candidates.append((parts[:index], owner))
    if len(candidates) != 1 or len(candidates[0][0]) > MAX_OWNERSHIP_PREFIX_PARTS:
        return None
    return candidates[0]


def _skill_marker_owner(relative: str) -> tuple[tuple[str, ...], str] | None:
    parts = _safe_ownership_parts(relative)
    if (
        parts is None
        or len(parts) < 4
        or parts[-4:-2] != (".claude", "skills")
        or parts[-1] != "SKILL.md"
        or re.fullmatch(r"[a-z0-9][a-z0-9._-]*", parts[-2]) is None
        or len(parts[:-4]) > MAX_OWNERSHIP_PREFIX_PARTS
    ):
        return None
    return parts[:-4], parts[-2]


def _relocatable_skill_source(source_root: Path, relative: str) -> bool:
    ownership = _skill_source_owner(relative)
    if ownership is None:
        return False
    prefix, owner = ownership
    return source_root.joinpath(
        *prefix, ".claude", "skills", owner, "SKILL.md"
    ).is_file()


def _optional_pairing_source(source_root: Path, relative: str, specifier: str) -> bool:
    ownership = _pairing_owner(relative)
    if ownership is None:
        return False
    prefix, channel = ownership
    return (
        specifier == f"../src/channels/{channel}-pairing.js"
        and source_root.joinpath(
            *prefix, ".claude", "skills", f"add-{channel}", "SKILL.md"
        ).is_file()
    )


def _source_node_maps(nodes: list[dict]) -> tuple[dict[str, str], dict[tuple[str, str], list[str]]]:
    files: dict[str, list[str]] = {}
    symbols: dict[tuple[str, str], list[str]] = {}
    for node in nodes:
        source = node.get("source_file")
        node_id = node.get("id")
        if not isinstance(source, str) or not isinstance(node_id, str):
            continue
        label = str(node.get("label", "")).strip()
        if label == Path(source).name:
            files.setdefault(source, []).append(node_id)
        symbol = label.strip("()").lstrip(".")
        if symbol:
            symbols.setdefault((source, symbol), []).append(node_id)
    unique_files = {
        source: ids[0] for source, ids in files.items() if len(set(ids)) == 1
    }
    return unique_files, symbols


def _js_reconciliation_facts(
    source_root: Path,
    applicable: set[str],
    symbols: dict[tuple[str, str], list[str]],
    relevant_sources: set[str],
) -> tuple[dict[tuple[str, int, str], set[str]], dict[tuple[str, int], tuple[str, Path | None, set[str], set[str]]], Any, Any, Any]:
    from graphify.extractors.base import _file_stem, _make_id, _read_text
    from graphify.extractors.resolution import (
        _js_module_specifier,
        _js_named_specifiers,
        _parse_js_tree,
        _resolve_js_module_path,
        _walk_js_tree,
    )

    suffixes = {".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"}
    paths = [
        source_root / relative
        for relative in sorted(relevant_sources & applicable)
        if Path(relative).suffix in suffixes
    ]
    named: dict[tuple[str, int, str], set[str]] = {}

    statements: dict[tuple[str, int], tuple[str, Path | None, set[str], set[str]]] = {}
    for path in paths:
        parsed = _parse_js_tree(path)
        if parsed is None:
            continue
        source_bytes, root = parsed
        relative = path.relative_to(source_root).as_posix()
        for node in _walk_js_tree(root):
            specifier = None
            if node.type == "import_statement":
                specifier = _js_module_specifier(node, source_bytes)
            elif node.type == "call_expression":
                function = node.child_by_field_name("function")
                if function is None and node.children:
                    function = node.children[0]
                if function is not None and _read_text(function, source_bytes) == "import":
                    arguments = node.child_by_field_name("arguments")
                    if arguments is not None:
                        for argument in arguments.children:
                            if argument.type == "string":
                                specifier = _read_text(argument, source_bytes).strip("'\" ")
                                break
                            if argument.type == "template_string" and not any(
                                child.type == "template_substitution" for child in argument.children
                            ):
                                specifier = _read_text(argument, source_bytes).strip("`")
                                break
            if specifier is None:
                continue
            resolved = _resolve_js_module_path(specifier, path.parent)
            pinned_named_targets: set[str] = set()
            imported_names: set[str] = set()
            if node.type == "import_statement" and resolved is not None:
                target_stem = _file_stem(resolved)
                imported_names.update(
                    imported_name
                    for imported_name, _local_name in _js_named_specifiers(
                        node, source_bytes, "import_specifier"
                    )
                )
                pinned_named_targets.update(
                    _make_id(target_stem, imported_name)
                    for imported_name in imported_names
                )
                try:
                    target_relative = resolved.resolve().relative_to(source_root.resolve()).as_posix()
                except ValueError:
                    target_relative = ""
                if target_relative in applicable:
                    canonical_stem = _file_stem(Path(target_relative))
                    for imported_name in imported_names:
                        matches = set(symbols.get((target_relative, imported_name), []))
                        if not matches:
                            continue
                        for pinned_target in {
                            _make_id(target_stem, imported_name),
                            _make_id(canonical_stem, imported_name),
                        }:
                            named.setdefault(
                                (relative, node.start_point[0] + 1, pinned_target), set()
                            ).update(matches)
            statements[(relative, node.start_point[0] + 1)] = (
                specifier,
                resolved,
                pinned_named_targets,
                imported_names,
            )
    return named, statements, _make_id, _resolve_js_module_path, _file_stem


def _python_import_at(source_root: Path, relative: str, line: int) -> tuple[str, int] | None:
    try:
        tree = ast.parse((source_root / relative).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, SyntaxError):
        return None
    for node in ast.walk(tree):
        if getattr(node, "lineno", None) != line:
            continue
        if isinstance(node, ast.Import) and node.names:
            return node.names[0].name, 0
        if isinstance(node, ast.ImportFrom):
            return node.module or "", node.level
    return None


def _normalize_extracted_graph(
    raw_nodes: list,
    raw_edges: list,
    source_root: Path,
    expected_paths: Sequence[str],
    intentional_paths: Sequence[str],
    verified_assets: set[str] | frozenset[str] = frozenset(),
) -> dict:
    """Reconcile only pinned v0.9.16 unresolved-edge shapes, fail closed otherwise."""
    expected = set(expected_paths)
    intentional = set(intentional_paths)
    applicable = expected - intentional
    nodes: list[dict] = []
    node_ids: set[str] = set()
    for raw in raw_nodes:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str) or not raw["id"]:
            raise WorkerValidationError("graph contains invalid node")
        node = dict(raw)
        if node["id"] in node_ids:
            raise WorkerValidationError("graph contains duplicate node id")
        node_ids.add(node["id"])
        canonical = _canonical_source(node.get("source_file"), expected_paths)
        if canonical:
            node["source_file"] = canonical
        nodes.append(node)

    edges: list[dict] = []
    dangling: list[dict] = []
    for raw in raw_edges:
        if not isinstance(raw, dict):
            raise WorkerValidationError("graph contains invalid link")
        edge = dict(raw)
        source, target = _edge_endpoints(edge)
        if not isinstance(source, str) or not source or not isinstance(target, str) or not target:
            raise WorkerValidationError("graph contains invalid link endpoint")
        edge["source"] = source
        edge["target"] = target
        edge.pop("from", None)
        edge.pop("to", None)
        canonical = _canonical_source(edge.get("source_file"), expected_paths)
        if canonical:
            edge["source_file"] = canonical
        if source in node_ids and target in node_ids:
            edges.append(edge)
        else:
            dangling.append(edge)

    _METRICS.update({
        "graph_raw_edges": len(raw_edges),
        "graph_raw_dangling_edges": len(dangling),
        "graph_output_edges": len(edges),
        "graph_reconciled_edges": 0,
        "graph_deduped_edges": 0,
        "graph_repaired_local_import_edges": 0,
        "graph_repaired_caller_edges": 0,
        "graph_dropped_external_import_edges": 0,
        "graph_dropped_template_import_edges": 0,
        "graph_dropped_python_import_edges": 0,
        "graph_dropped_shell_source_edges": 0,
        "graph_dropped_non_graph_asset_edges": 0,
        "graph_dropped_unrepresented_local_symbol_edges": 0,
        "graph_dropped_optional_pairing_edges": 0,
    })
    if len(dangling) > MAX_EDGE_RECONCILIATIONS:
        raise WorkerValidationError("edge reconciliation exceeds absolute safety cap")
    if not dangling:
        unique_edges = {_canonical_json(edge): edge for edge in edges}
        _METRICS["graph_deduped_edges"] = len(edges) - len(unique_edges)
        _METRICS["graph_output_edges"] = len(unique_edges)
        return {
            "nodes": sorted(nodes, key=lambda node: (node["id"], _canonical_json(node))),
            "links": sorted(unique_edges.values(), key=_edge_sort_key),
        }

    file_nodes, symbols = _source_node_maps(nodes)
    relevant_js_sources = {
        str(edge.get("source_file"))
        for edge in dangling
        if isinstance(edge.get("source_file"), str)
    }
    named_js, js_statements, make_id, resolve_js, file_stem = _js_reconciliation_facts(
        source_root, applicable, symbols, relevant_js_sources
    )
    valid_callers: dict[tuple[str, str, str, str, str], set[str]] = {}
    file_source_by_id = {node_id: source for source, node_id in file_nodes.items()}
    valid_local_module_groups: dict[tuple[str, int], set[str]] = {}
    dangling_module_groups: dict[tuple[str, int], set[str]] = {}
    for edge in dangling:
        edge_line = _line_number(edge.get("source_location"))
        edge_source_file = edge.get("source_file")
        if (
            edge.get("relation") == "imports_from"
            and _is_ast_import(edge)
            and isinstance(edge_source_file, str)
            and edge_line is not None
        ):
            dangling_module_groups.setdefault(
                (edge_source_file, edge_line), set()
            ).add(str(edge.get("target")))
    for edge in edges:
        edge_line = _line_number(edge.get("source_location"))
        edge_source_file = edge.get("source_file")
        module_target_file = file_source_by_id.get(str(edge.get("target")))
        if (
            edge.get("relation") == "imports_from"
            and _is_ast_import(edge)
            and isinstance(edge_source_file, str)
            and edge_line is not None
            and module_target_file is not None
        ):
            valid_local_module_groups.setdefault(
                (edge_source_file, edge_line), set()
            ).add(module_target_file)
        if edge.get("relation") != "calls":
            continue
        key = (
            str(edge.get("target")), str(edge.get("source_file")),
            str(edge.get("source_location")), str(edge.get("context")),
            str(edge.get("confidence")),
        )
        valid_callers.setdefault(key, set()).add(str(edge["source"]))

    repaired: list[dict] = []
    repaired_named_js: set[tuple[str, int, str]] = set()
    for edge in dangling:
        source, target = edge["source"], edge["target"]
        source_missing = source not in node_ids
        target_missing = target not in node_ids
        if source_missing and target_missing:
            raise WorkerValidationError("graph link has two missing endpoints")
        relative = edge.get("source_file")
        line = _line_number(edge.get("source_location"))
        if not isinstance(relative, str) or relative not in applicable or line is None:
            raise WorkerValidationError("dangling edge lacks owned source evidence")

        if source_missing:
            if (
                edge.get("relation") == "indirect_call"
                and edge.get("context") == "argument"
                and edge.get("confidence") == "INFERRED"
                and edge.get("_origin") == "ast"
                and target in node_ids
                and source == make_id(str(source_root / relative))
                and relative in file_nodes
            ):
                fixed = dict(edge); fixed["source"] = file_nodes[relative]
                repaired.append(fixed)
                _METRICS["graph_repaired_caller_edges"] += 1
                continue
            if edge.get("relation") == "calls" and target in node_ids:
                key = (
                    target, relative, str(edge.get("source_location")),
                    str(edge.get("context")), str(edge.get("confidence")),
                )
                callers = valid_callers.get(key, set())
                if len(callers) == 1:
                    fixed = dict(edge); fixed["source"] = next(iter(callers))
                    repaired.append(fixed)
                    _METRICS["graph_repaired_caller_edges"] += 1
                    continue
            raise WorkerValidationError("unresolved graph caller is not uniquely owned")

        if not target_missing or not _is_ast_import(edge) or source not in node_ids:
            raise WorkerValidationError("dangling edge is not a pinned unresolved import")

        suffix = Path(relative).suffix.lower()
        if suffix in {".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"}:
            named_targets = (
                named_js.get((relative, line, target), set())
                if edge.get("relation") == "imports"
                else set()
            )
            if named_targets:
                group = (relative, line, target)
                if group not in repaired_named_js:
                    repaired_named_js.add(group)
                    for named_target in sorted(named_targets):
                        fixed = dict(edge); fixed["target"] = named_target
                        repaired.append(fixed)
                        _METRICS["graph_repaired_local_import_edges"] += 1
                continue
            statement = js_statements.get((relative, line))
            if statement is None:
                raise WorkerValidationError(
                    f"unresolved JS import lacks an exact AST statement: {relative}:L{line}"
                )
            specifier, resolved, pinned_named_targets, imported_names = statement
            is_relative = specifier.startswith((".", "/"))
            resolved_path: Path | None = resolved.resolve() if resolved is not None else None
            resolved_relative: str | None = None
            if resolved_path is not None:
                try:
                    resolved_relative = resolved_path.relative_to(source_root.resolve()).as_posix()
                except ValueError:
                    resolved_relative = None
            pinned_module_targets = (
                {make_id(str(resolved_path))} if resolved_path is not None else {make_id("ref", specifier)}
            )
            if resolved_relative is not None:
                pinned_module_targets.add(make_id(file_stem(Path(resolved_relative))))
            if is_relative and resolved_relative not in applicable:
                spelled = ((source_root / relative).parent / specifier)
                esm_candidates: set[str] = set()
                suffixes = (".ts", ".tsx", ".mts", ".cts") if spelled.suffix == ".js" else (
                    (".tsx",) if spelled.suffix == ".jsx" else ()
                )
                for suffix in suffixes:
                    candidate = spelled.with_suffix(suffix)
                    try:
                        candidate_relative = candidate.resolve().relative_to(source_root.resolve()).as_posix()
                    except ValueError:
                        continue
                    if candidate_relative in applicable and candidate.is_file():
                        esm_candidates.add(candidate_relative)
                if len(esm_candidates) == 1:
                    resolved_relative = next(iter(esm_candidates))
            if resolved_relative in applicable:
                if edge.get("relation") == "imports":
                    pinned_to_actual = {
                        make_id(file_stem(resolved_path), imported_name): set(
                            symbols.get((resolved_relative, imported_name), [])
                        )
                        for imported_name in imported_names
                    }
                    actual_targets = pinned_to_actual.get(target, set())
                    if not actual_targets:
                        if (
                            target in pinned_named_targets
                            and (
                                resolved_relative in valid_local_module_groups.get((relative, line), set())
                                or bool(
                                    pinned_module_targets
                                    & dangling_module_groups.get((relative, line), set())
                                )
                            )
                        ):
                            _METRICS["graph_dropped_unrepresented_local_symbol_edges"] += 1
                            continue
                        raise WorkerValidationError(
                            "resolved local named import has no exact symbol: "
                            f"{relative}:L{line} target={resolved_relative} names={sorted(imported_names)}"
                        )
                    for actual_target in sorted(actual_targets):
                        fixed = dict(edge); fixed["target"] = actual_target
                        repaired.append(fixed)
                        _METRICS["graph_repaired_local_import_edges"] += 1
                    continue
                if target not in pinned_module_targets:
                    raise WorkerValidationError(
                        "local module import target does not match pinned id: "
                        f"{relative}:L{line} target={target} expected={sorted(pinned_module_targets)}"
                    )
                file_target = file_nodes.get(resolved_relative)
                if file_target is None:
                    raise WorkerValidationError("resolved local import has no unique file node")
                fixed = dict(edge); fixed["target"] = file_target
                repaired.append(fixed)
                _METRICS["graph_repaired_local_import_edges"] += 1
                continue
            if resolved_relative in intentional:
                _METRICS["graph_dropped_non_graph_asset_edges"] += 1
                continue
            if resolved_relative in verified_assets:
                if (
                    not is_relative
                    or Path(specifier).suffix.lower() not in NON_GRAPH_ASSET_EXTENSIONS
                    or edge.get("relation") != "imports_from"
                    or bool(imported_names)
                    or resolved_path is None
                    or not resolved_path.is_file()
                    or resolved_path.is_symlink()
                    or target not in pinned_module_targets
                ):
                    raise WorkerValidationError(
                        f"verified asset import does not match pinned AST target: {relative}:L{line}"
                    )
                _METRICS["graph_dropped_non_graph_asset_edges"] += 1
                continue
            if not is_relative and resolve_js(specifier, (source_root / relative).parent) is None:
                if target != make_id("ref", specifier):
                    raise WorkerValidationError("external JS import target does not match pinned id")
                _METRICS["graph_dropped_external_import_edges"] += 1
                continue
            if is_relative and imported_names and resolved_path is not None:
                candidate_files: set[str] | None = None
                for imported_name in imported_names:
                    matching_files = {
                        source_file
                        for source_file, symbol_name in symbols
                        if symbol_name == imported_name and source_file in applicable
                    }
                    candidate_files = (
                        matching_files
                        if candidate_files is None
                        else candidate_files & matching_files
                    )
                if candidate_files is not None and len(candidate_files) == 1:
                    moved_relative = next(iter(candidate_files))
                    if edge.get("relation") == "imports_from":
                        if target not in pinned_module_targets:
                            raise WorkerValidationError("moved module import target does not match pinned id")
                        moved_target = file_nodes.get(moved_relative)
                        if moved_target is None:
                            raise WorkerValidationError("moved local import has no unique file node")
                        fixed = dict(edge); fixed["target"] = moved_target
                        repaired.append(fixed)
                        _METRICS["graph_repaired_local_import_edges"] += 1
                        continue
                    pinned_to_actual: dict[str, set[str]] = {}
                    for imported_name in imported_names:
                        pinned_to_actual[make_id(file_stem(resolved_path), imported_name)] = set(
                            symbols.get((moved_relative, imported_name), [])
                        )
                    actual_targets = pinned_to_actual.get(target, set())
                    if actual_targets:
                        for actual_target in sorted(actual_targets):
                            fixed = dict(edge); fixed["target"] = actual_target
                            repaired.append(fixed)
                            _METRICS["graph_repaired_local_import_edges"] += 1
                        continue
            if (
                is_relative
                and _relocatable_skill_source(source_root, relative)
                and (resolved_path is None or not resolved_path.is_file())
                and target in (
                    pinned_named_targets
                    | pinned_module_targets
                )
            ):
                _METRICS["graph_dropped_template_import_edges"] += 1
                continue
            if (
                is_relative
                and _optional_pairing_source(source_root, relative, specifier)
                and (resolved_path is None or not resolved_path.is_file())
                and target in (pinned_named_targets | pinned_module_targets)
            ):
                _METRICS["graph_dropped_optional_pairing_edges"] += 1
                continue
            raise WorkerValidationError(
                "unresolved relative JS import is outside the template exception: "
                f"{relative}:L{line} relation={edge.get('relation')} target={target}"
            )

        if suffix == ".py":
            imported = _python_import_at(source_root, relative, line)
            if imported is None:
                raise WorkerValidationError("unresolved Python import lacks an exact AST statement")
            module, level = imported
            local = source_root / module.replace(".", "/")
            local_exists = local.is_file() or local.with_suffix(".py").is_file() or (local / "__init__.py").is_file()
            if level != 0 or local_exists or target != make_id(module):
                raise WorkerValidationError("unresolved Python import is not external/stdlib")
            _METRICS["graph_dropped_python_import_edges"] += 1
            continue

        if suffix in {".sh", ".bash"}:
            try:
                source_line = (source_root / relative).read_text(encoding="utf-8").splitlines()[line - 1].strip()
            except (OSError, UnicodeError, IndexError):
                raise WorkerValidationError("unresolved shell source lacks an exact line")
            match = re.match(r"^(?:source|\.)\s+(.+?)\s*$", source_line)
            raw_target = match.group(1).strip("'\"") if match else ""
            local_candidates: set[str] = set()
            if raw_target and not any(marker in raw_target for marker in ("$", "`")):
                raw_path = Path(raw_target)
                candidates: list[Path] = []
                if not raw_path.is_absolute():
                    source_parent = (source_root / relative).parent
                    if ".." in raw_path.parts:
                        candidates.extend((source_root / raw_path, source_parent / raw_path))
                    else:
                        ancestor = source_parent
                        resolved_root = source_root.resolve()
                        for _depth in range(MAX_SOURCE_ANCESTORS):
                            candidates.append(ancestor / raw_path)
                            if ancestor.resolve() == resolved_root:
                                break
                            parent = ancestor.parent
                            if parent == ancestor:
                                break
                            ancestor = parent
                for candidate in candidates:
                    try:
                        resolved_candidate = candidate.resolve(strict=True)
                        candidate_relative = resolved_candidate.relative_to(
                            source_root.resolve(strict=True)
                        ).as_posix()
                    except (OSError, RuntimeError, ValueError):
                        continue
                    if (
                        candidate_relative in applicable
                        and resolved_candidate.is_file()
                        and not candidate.is_symlink()
                    ):
                        local_candidates.add(candidate_relative)
                if len(local_candidates) > 1:
                    raise WorkerValidationError(
                        f"literal shell source is not uniquely resolved: {relative}:L{line}"
                    )
                if len(local_candidates) == 1:
                    if target != make_id(raw_target):
                        raise WorkerValidationError("literal shell source target does not match pinned id")
                    local_relative = next(iter(local_candidates))
                    local_target = file_nodes.get(local_relative)
                    if local_target is None:
                        raise WorkerValidationError("resolved shell source has no unique file node")
                    fixed = dict(edge); fixed["target"] = local_target
                    repaired.append(fixed)
                    _METRICS["graph_repaired_local_import_edges"] += 1
                    continue
            if not raw_target or not any(marker in raw_target for marker in ("$", "`")) or target != make_id(raw_target):
                raise WorkerValidationError(
                    f"unresolved shell source is not variable-expanded: {relative}:L{line}"
                )
            _METRICS["graph_dropped_shell_source_edges"] += 1
            continue
        raise WorkerValidationError("dangling edge language is not approved for reconciliation")

    _METRICS["graph_reconciled_edges"] = len(dangling)
    edges.extend(repaired)
    unique_edges = {_canonical_json(edge): edge for edge in edges}
    deduped_edges = len(edges) - len(unique_edges)
    _METRICS["graph_deduped_edges"] = deduped_edges
    ordered_nodes = sorted(nodes, key=lambda node: (node["id"], _canonical_json(node)))
    ordered_edges = sorted(unique_edges.values(), key=_edge_sort_key)
    final_ids = {node["id"] for node in ordered_nodes}
    if any(edge["source"] not in final_ids or edge["target"] not in final_ids for edge in ordered_edges):
        raise WorkerValidationError("graph normalization left a dangling endpoint")
    _METRICS["graph_output_edges"] = len(ordered_edges)
    repaired_edges = int(_METRICS["graph_repaired_local_import_edges"]) + int(
        _METRICS["graph_repaired_caller_edges"]
    )
    expected_output_edges = len(raw_edges) - len(dangling) + repaired_edges - deduped_edges
    if expected_output_edges != len(ordered_edges):
        raise WorkerValidationError("graph edge accounting invariant failed")
    return {"nodes": ordered_nodes, "links": ordered_edges}


def validate_candidate(
    graph: dict,
    expected_files: list[dict],
    source_contents: dict[str, str],
    intentional_exclusions: list[str],
    extraction_errors: dict[str, str],
) -> ExtractionStatus:
    detected = sorted(item["path"] for item in expected_files)
    intentional = sorted(intentional_exclusions)
    if len(detected) != len(set(detected)) or not set(intentional).issubset(detected):
        raise WorkerValidationError("detected/intentional source sets are invalid")
    if set(extraction_errors) - set(detected):
        raise WorkerValidationError("extractor errors contain an unknown source")
    nodes = graph.get("nodes")
    links = graph.get("links")
    if not isinstance(nodes, list) or not isinstance(links, list) or not nodes:
        raise WorkerValidationError("graph schema is invalid or zero-node")
    node_ids: set[str] = set()
    represented: set[str] = set()
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get("id"), str) or not node["id"]:
            raise WorkerValidationError("graph contains invalid node")
        if node["id"] in node_ids:
            raise WorkerValidationError("graph contains duplicate node id")
        node_ids.add(node["id"])
        source = _canonical_source(node.get("source_file"), detected)
        if source:
            node["source_file"] = source
            represented.add(source)
    for link in links:
        if not isinstance(link, dict):
            raise WorkerValidationError("graph contains invalid link")
        source = link.get("source", link.get("from")); target = link.get("target", link.get("to"))
        if source not in node_ids or target not in node_ids:
            raise WorkerValidationError("graph link endpoint is missing")
        link["source"] = source; link["target"] = target
        link.pop("from", None); link.pop("to", None)
        source_file = _canonical_source(link.get("source_file"), detected)
        if source_file:
            link["source_file"] = source_file
    applicable = sorted(set(detected) - set(intentional))
    contributed = sorted(set(applicable) & represented)
    missing = sorted(set(applicable) - set(contributed))
    failed = {path: extraction_errors.get(path, "applicable source contributed no source_file node") for path in missing}
    failed.update(extraction_errors)
    unsupported: dict[str, str] = {}
    if failed:
        raise WorkerValidationError("incomplete extraction: " + "; ".join(f"{k}: {v}" for k, v in sorted(failed.items())))
    # When callers provide source text, validate the MD5 contract too. Actual
    # extraction always does; unit-level schema checks may intentionally omit it.
    for item in expected_files:
        text = source_contents.get(item["path"])
        if text is None:
            continue
        raw = text.encode("utf-8")
        if hashlib.md5(raw, usedforsecurity=False).hexdigest() != item["md5"]:
            raise WorkerValidationError(f"manifest MD5 mismatch: {item['path']}")
    return ExtractionStatus(detected, applicable, intentional, contributed, unsupported, failed)


def _write_bounded_json(path: Path, value: object, cap: int) -> tuple[int, str]:
    encoder = json.JSONEncoder(sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(); total = 0
    with path.open("x", encoding="utf-8") as stream:
        for piece in encoder.iterencode(value):
            raw = piece.encode("utf-8")
            total += len(raw)
            if total > cap:
                raise WorkerValidationError(f"artifact exceeds limit: {path.name}")
            digest.update(raw); stream.write(piece)
    return total, digest.hexdigest()


def extract_candidate(descriptor: dict) -> ExtractionStatus:
    source_root = Path(descriptor["source_root"])
    output_root = Path(descriptor["output_root"])
    if not source_root.is_dir() or source_root.is_symlink():
        raise WorkerValidationError("private source snapshot is unavailable")
    output_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if output_root.is_symlink():
        raise WorkerValidationError("candidate output may not be a symlink")
    expected = descriptor.get("files")
    if not isinstance(expected, list) or not expected:
        raise WorkerValidationError("empty or invalid extraction descriptor")
    raw_assets = descriptor.get("assets")
    if not isinstance(raw_assets, list):
        raise WorkerValidationError("missing or invalid asset descriptor")
    paths: list[Path] = []
    contents: dict[str, str] = {}
    intentional: list[str] = []
    manifest: dict[str, str] = {}
    source_bytes = 0
    code_paths: set[str] = set()
    for item in expected:
        if not isinstance(item, dict) or set(item) != {"path", "sha256", "md5", "bytes", "graphify_hash"}:
            raise WorkerValidationError("invalid source descriptor schema")
        path = _safe_relative(source_root, item["path"])
        if item["path"] in code_paths:
            raise WorkerValidationError("duplicate source descriptor path")
        code_paths.add(item["path"])
        sha, md5, size, raw = _stream_hash(path)
        if (sha, md5, size) != (item["sha256"], item["md5"], item["bytes"]):
            raise WorkerValidationError(f"private source snapshot hash mismatch: {item['path']}")
        manifest[item["path"]] = md5
        source_bytes += size
        if path.suffix.lower() == ".json":
            contents[item["path"]] = raw.decode("utf-8")
        if _intentional_data_json(item["path"], raw):
            intentional.append(item["path"])
        else:
            paths.append(path)
    verified_assets = _verified_asset_paths(source_root, raw_assets, code_paths)
    asset_bytes = sum(item["bytes"] for item in raw_assets)
    if source_bytes + asset_bytes > MAX_INPUT_BYTES:
        raise WorkerValidationError("source and asset descriptor exceeds input cap")
    if not paths:
        raise WorkerValidationError("zero applicable sources")

    extract = _import_graphify()
    try:
        result = extract(
            paths,
            cache_root=output_root,
            source_root=source_root,
            parallel=False,
            max_workers=1,
        )
    except Exception as exc:
        raise WorkerValidationError(f"Graphify AST extraction failed: {exc}") from exc
    if not isinstance(result, dict):
        raise WorkerValidationError("Graphify returned invalid extraction schema")
    raw_nodes = result.get("nodes"); raw_edges = result.get("edges")
    if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
        raise WorkerValidationError("Graphify returned invalid nodes/edges")
    extraction_errors: dict[str, str] = {}
    # Normalize the exact-patched source-root attribution before validation.
    expected_paths = [item["path"] for item in expected]
    for item in raw_nodes + raw_edges:
        if isinstance(item, dict):
            canonical = _canonical_source(item.get("source_file"), expected_paths)
            if canonical:
                item["source_file"] = canonical
    graph = _normalize_extracted_graph(
        raw_nodes,
        raw_edges,
        source_root,
        expected_paths,
        intentional,
        verified_assets,
    )
    status = validate_candidate(graph, expected, contents, intentional, extraction_errors)

    graph_path = output_root / "graph.json"
    manifest_path = output_root / "manifest.json"
    status_path = output_root / "status.json"
    for path in (graph_path, manifest_path, status_path):
        path.unlink(missing_ok=True)
    graph_bytes, status.graph_sha256 = _write_bounded_json(graph_path, graph, MAX_GRAPH_BYTES)
    status.graph_bytes = graph_bytes
    manifest_bytes, status.manifest_sha256 = _write_bounded_json(manifest_path, manifest, MAX_METADATA_BYTES)

    # Retain only exact current-version AST entries, under the supervisor's live
    # namespace. Everything else produced under graphify-out is debris.
    # Flush Graphify's registered stat-index writer before deleting that private
    # scratch namespace; its atexit callback is then a no-op and cannot recreate
    # graphify-out after the supervisor has validated the candidate.
    from graphify import cache as graphify_cache
    graphify_cache._flush_stat_index()
    produced_ast = output_root / "graphify-out" / "cache" / "ast" / f"v{GRAPHIFY_VERSION}"
    live_ast = output_root / "ast"
    if live_ast.exists():
        import shutil
        shutil.rmtree(live_ast)
    if produced_ast.is_dir():
        os.replace(produced_ast, live_ast)
    import shutil
    shutil.rmtree(output_root / "graphify-out", ignore_errors=True)
    ast_bytes = sum(p.stat().st_size for p in live_ast.glob("*.json")) if live_ast.is_dir() else 0
    if ast_bytes > MAX_AST_BYTES:
        raise WorkerValidationError("AST cache exceeds 128 MiB")
    status_bytes, _ = _write_bounded_json(status_path, asdict(status), MAX_METADATA_BYTES)
    input_bytes = source_bytes + asset_bytes
    tmpfs_high_water = input_bytes + graph_bytes + manifest_bytes + status_bytes + ast_bytes
    if tmpfs_high_water > MAX_TMPFS_BYTES:
        raise WorkerValidationError("private source/output generation exceeds 192 MiB")
    _METRICS.update({
        "input_bytes": input_bytes,
        "asset_files": len(verified_assets),
        "asset_bytes": asset_bytes,
        "graph_bytes": graph_bytes,
        "ast_bytes": ast_bytes,
        "tmpfs_high_water_bytes": tmpfs_high_water,
    })
    return status


def _load_owned_graph(graph_path: Path) -> dict:
    if graph_path.name != "graph.json" or not graph_path.is_file() or graph_path.is_symlink():
        raise WorkerValidationError("gateway-owned graph is unavailable")
    size = graph_path.stat().st_size
    if size <= 0 or size > MAX_GRAPH_BYTES:
        raise WorkerValidationError("gateway-owned graph size is invalid")
    try:
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise WorkerValidationError(f"gateway-owned graph is invalid: {exc}") from exc
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list) or not isinstance(graph.get("links"), list):
        raise WorkerValidationError("gateway-owned graph schema is invalid")
    return graph


def _match_nodes(nodes: list[dict], term: str) -> list[dict]:
    needle = term.casefold()
    return sorted(
        [node for node in nodes if needle in str(node.get("id", "")).casefold() or needle in str(node.get("label", "")).casefold()],
        key=lambda node: (str(node.get("label", "")).casefold(), str(node.get("id", ""))),
    )


def run_query(graph_path: Path, command: str, arguments: list[str]) -> str:
    graph = _load_owned_graph(graph_path)
    _METRICS["graph_bytes"] = graph_path.stat().st_size
    nodes = [n for n in graph["nodes"] if isinstance(n, dict)]
    links = [e for e in graph["links"] if isinstance(e, dict)]
    by_id = {str(n.get("id")): n for n in nodes if n.get("id")}
    if command == "query":
        matches = _match_nodes(nodes, arguments[0])[:50]
        return "\n".join(f"{n.get('id')}\t{n.get('label', '')}\t{n.get('source_file', '')}" for n in matches) + ("\n" if matches else "")
    if command == "explain":
        matches = _match_nodes(nodes, arguments[0])
        if not matches:
            return "No matching node.\n"
        node = matches[0]; nid = str(node["id"])
        connected = [e for e in links if e.get("source") == nid or e.get("target") == nid]
        return json.dumps({"node": node, "connections": connected[:100]}, sort_keys=True, ensure_ascii=False) + "\n"
    if command == "path":
        starts = _match_nodes(nodes, arguments[0]); ends = _match_nodes(nodes, arguments[1])
        if not starts or not ends:
            return "No path.\n"
        start = str(starts[0]["id"]); target = str(ends[0]["id"])
        adjacency: dict[str, list[str]] = {}
        for edge in links:
            a = str(edge.get("source", "")); b = str(edge.get("target", ""))
            adjacency.setdefault(a, []).append(b)
        queue = deque([(start, [start])]); seen = {start}
        while queue:
            current, route = queue.popleft()
            if current == target:
                return " -> ".join(str(by_id.get(n, {}).get("label", n)) for n in route) + "\n"
            for nxt in sorted(adjacency.get(current, [])):
                if nxt not in seen:
                    seen.add(nxt); queue.append((nxt, route + [nxt]))
        return "No path.\n"
    if command == "affected":
        matches = _match_nodes(nodes, arguments[0])
        if not matches:
            return ""
        start = str(matches[0]["id"]); reverse: dict[str, list[str]] = {}
        for edge in links:
            reverse.setdefault(str(edge.get("target", "")), []).append(str(edge.get("source", "")))
        queue = deque([start]); seen = {start}; found: list[str] = []
        while queue:
            current = queue.popleft()
            for nxt in sorted(reverse.get(current, [])):
                if nxt not in seen:
                    seen.add(nxt); found.append(nxt); queue.append(nxt)
        return "\n".join(f"{nid}\t{by_id.get(nid, {}).get('label', '')}" for nid in found) + ("\n" if found else "")
    raise WorkerValidationError("unsupported private query operation")


def _telemetry(started: float, mode: str, reason: str) -> dict:
    values: dict[str, int | float | str] = {
        "mode": mode, "duration_ms": round((time.monotonic() - started) * 1000, 3), "reason": reason,
    }
    values.update(_METRICS)
    try:
        for line in Path("/proc/self/status").read_text(encoding="ascii").splitlines():
            if line.startswith("VmRSS:"):
                values["worker_rss_kib"] = int(line.split()[1])
            elif line.startswith("VmSize:"):
                values["worker_virtual_kib"] = int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    for name in ("memory.current", "memory.peak"):
        try:
            values["cgroup_" + name.replace(".", "_")] = int((Path("/sys/fs/cgroup") / name).read_text().strip())
        except (OSError, ValueError):
            pass
    return values


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    started = time.monotonic(); mode = "invalid"; reason = "invalid_descriptor"
    try:
        if len(args) != 1:
            raise WorkerValidationError("worker requires one JSON descriptor")
        descriptor_path = Path(args[0])
        if not descriptor_path.is_file() or descriptor_path.is_symlink() or descriptor_path.stat().st_size > MAX_METADATA_BYTES:
            raise WorkerValidationError("invalid worker descriptor path or size")
        descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
        if not isinstance(descriptor, dict):
            raise WorkerValidationError("invalid worker descriptor schema")
        limits = descriptor.get("limits", {})
        apply_limits(
            limits.get("address_space_bytes", MAX_ADDRESS_SPACE),
            limits.get("file_bytes", MAX_FILE_BYTES),
            limits.get("process_count", 0),
        )
        install_task_guards()
        mode = descriptor.get("operation", "invalid")
        if descriptor.get("graphify_version", GRAPHIFY_VERSION) != GRAPHIFY_VERSION:
            raise WorkerValidationError("descriptor Graphify version mismatch")
        if mode == "extract":
            extract_candidate(descriptor)
        elif mode == "query":
            command = descriptor.get("command")
            arguments = descriptor.get("arguments")
            expected = 2 if command == "path" else 1
            if command not in {"query", "path", "explain", "affected"} or not isinstance(arguments, list) or len(arguments) != expected:
                raise WorkerValidationError("invalid private query descriptor")
            output = run_query(Path(descriptor["graph"]), command, arguments)
            if len(output.encode("utf-8")) > MAX_QUERY_RESULT_BYTES:
                raise WorkerValidationError("query result exceeds 64 KiB output limit")
            sys.stdout.write(output)
        else:
            raise WorkerValidationError("unsupported private operation")
        reason = "ok"
        return 0
    except (WorkerError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        reason = type(exc).__name__
        print(f"graphify-worker: {exc}", file=sys.stderr)
        return 2
    finally:
        print("NANOCLAW_GRAPHIFY_TELEMETRY " + json.dumps(_telemetry(started, mode, reason), sort_keys=True), file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
