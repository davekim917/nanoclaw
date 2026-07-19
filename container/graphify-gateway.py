#!/usr/bin/env python3
"""Policy-enforcing, freshness-atomic supervisor for NanoClaw Graphify reads.

This executable deliberately uses only the Python standard library.  The
Graphify distribution is importable only by the private worker interpreter.
"""
from __future__ import annotations

import contextlib
from dataclasses import asdict, dataclass
import datetime as _dt
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import shlex
import stat
import subprocess
import sys
import tempfile
import time
from typing import Callable, Iterator, Sequence


GRAPHIFY_VERSION = "0.9.16"
PUBLIC_VERSION = "nanoclaw-graphify 0.9.16"
WORKTREE_ROOT = Path("/workspace/worktrees")
CACHE_BASE = Path("/workspace/.cache/graphify")
SOURCE_STAGE_ROOT = Path("/workspace/.graphify-stage")
RUNTIME_DIR = Path("/run/nanoclaw-graphify")
WORKER_LOCK = RUNTIME_DIR / "worker.lock"
WORKER_PYTHON = Path("/opt/graphify/bin/python")
WORKER_SCRIPT = Path("/opt/graphify/graphify-worker.py")
CGROUP_MEMORY_CURRENT = Path("/sys/fs/cgroup/memory.current")
CGROUP_MEMORY_MAX = Path("/sys/fs/cgroup/memory.max")
MOUNTINFO_PATH = Path("/proc/self/mountinfo")

REFRESH_SECONDS = 900.0
QUERY_SECONDS = 120.0
TERM_GRACE_SECONDS = 5.0
LOCK_POLL_SECONDS = 0.02
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_CODE_FILES = 4000
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_ASSET_FILES = 512
MAX_ASSET_BYTES = 16 * 1024 * 1024
MAX_GRAPH_BYTES = 64 * 1024 * 1024
MAX_AST_BYTES = 128 * 1024 * 1024
MAX_TMPFS_BYTES = 192 * 1024 * 1024
MAX_DIAGNOSTIC_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_METADATA_BYTES = 8 * 1024 * 1024
MAX_STATE_BYTES = MAX_METADATA_BYTES
MAX_MOUNTINFO_BYTES = 1024 * 1024
MAX_OWNERSHIP_PREFIX_PARTS = 64
WORKER_RESERVE_BYTES = 1024 * 1024 * 1024
OUTPUT_RESERVE_BYTES = 384 * 1024 * 1024
RUNNER_RESERVE_BYTES = 512 * 1024 * 1024

# Exact graphify/detect.py v0.9.16 CODE_EXTENSIONS.  Keep the case-sensitive
# spellings: capital-F Fortran is detected and then policy-rejected because its
# upstream extractor shells out to cpp.
CODE_EXTENSIONS = frozenset({
    '.py', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.ejs', '.ets',
    '.go', '.rs', '.java', '.groovy', '.gradle', '.cpp', '.cc', '.cxx', '.c',
    '.h', '.hpp', '.cu', '.cuh', '.metal', '.rb', '.rake', '.swift', '.kt',
    '.kts', '.cs', '.scala', '.php', '.lua', '.luau', '.toc', '.zig', '.ps1',
    '.psm1', '.psd1', '.ex', '.exs', '.m', '.mm', '.jl', '.vue', '.svelte',
    '.astro', '.dart', '.v', '.sv', '.svh', '.sql', '.r', '.f', '.F', '.f90',
    '.F90', '.f95', '.F95', '.f03', '.F03', '.f08', '.F08', '.pas', '.pp',
    '.dpr', '.dpk', '.lpr', '.inc', '.dfm', '.lfm', '.lpk', '.sh', '.bash',
    '.json', '.tf', '.tfvars', '.hcl', '.dm', '.dme', '.dmi', '.dmm', '.dmf',
    '.sln', '.slnx', '.csproj', '.fsproj', '.vbproj', '.xaml', '.razor',
    '.cshtml', '.cls', '.trigger',
})

# The v0.9.16 in-process dispatch.  Deliberately excludes .r (detected but no
# extractor), ambiguous MATLAB .m (checked by the worker), and capital-F forms.
IN_PROCESS_EXTENSIONS = frozenset(
    CODE_EXTENSIONS - {'.ejs', '.ets', '.r', '.F', '.F90', '.F95', '.F03', '.F08'}
)
PACKAGE_MANIFEST_NAMES = frozenset({"apm.yml", "apm.yaml", "pyproject.toml", "go.mod", "pom.xml"})
CAPITAL_F_EXTENSIONS = frozenset({'.F', '.F90', '.F95', '.F03', '.F08'})
IGNORED_DIRS = frozenset({
    ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build",
    "target", "__pycache__", ".venv", "venv", "graphify-out",
})
NON_GRAPH_ASSET_EXTENSIONS = frozenset({".css"})
ASSET_REFERENCE_SOURCE_EXTENSIONS = frozenset({
    ".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte",
})
QUOTED_RELATIVE_CSS = re.compile(
    rb"(?P<quote>['\"])(?P<specifier>\.{1,2}/[^'\"\r\n\x00]+\.css)(?P=quote)",
    re.IGNORECASE,
)
_TELEMETRY: dict[str, int | float | str] = {}


class GatewayError(RuntimeError):
    pass


class PolicyError(GatewayError):
    pass


class SourceChanged(GatewayError):
    pass


class DeadlineExpired(GatewayError):
    pass


class ValidationError(GatewayError):
    pass


class AdmissionError(GatewayError):
    pass


@dataclass(frozen=True)
class QueryCommand:
    name: str
    arguments: tuple[str, ...] = ()


@dataclass(frozen=True)
class ManagedRepo:
    root: Path
    cache_key: str
    cache_root: Path


@dataclass(frozen=True)
class MountInfo:
    mount_id: int
    mountpoint: str
    options: frozenset[str]
    filesystem: str


@dataclass(frozen=True)
class SourceFile:
    path: str
    sha256: str
    md5: str
    bytes: int
    graphify_hash: str


@dataclass(frozen=True)
class AssetFile:
    path: str
    sha256: str
    bytes: int


@dataclass(frozen=True)
class SourceGeneration:
    files: tuple[SourceFile, ...]
    total_bytes: int
    fingerprint: str
    assets: tuple[AssetFile, ...] = ()
    asset_total_bytes: int = 0


@dataclass(frozen=True)
class AcceptedSourceState:
    files: tuple[SourceFile, ...]
    graphify_version: str
    total_bytes: int
    fingerprint: str
    accepted_at: str
    assets: tuple[AssetFile, ...] = ()
    asset_total_bytes: int = 0

    @classmethod
    def from_generation(cls, generation: SourceGeneration) -> "AcceptedSourceState":
        return cls(
            files=generation.files,
            graphify_version=GRAPHIFY_VERSION,
            total_bytes=generation.total_bytes,
            fingerprint=generation.fingerprint,
            accepted_at=_dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            assets=generation.assets,
            asset_total_bytes=generation.asset_total_bytes,
        )

    def to_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, value: dict) -> "AcceptedSourceState":
        required = {
            "files", "graphify_version", "total_bytes", "fingerprint", "accepted_at",
            "assets", "asset_total_bytes",
        }
        if set(value) != required or value["graphify_version"] != GRAPHIFY_VERSION:
            raise ValidationError("invalid source-state schema or Graphify version")
        files = tuple(SourceFile(**item) for item in value["files"])
        assets = tuple(AssetFile(**item) for item in value["assets"])
        state = cls(
            files, value["graphify_version"], value["total_bytes"], value["fingerprint"],
            value["accepted_at"], assets, value["asset_total_bytes"],
        )
        if not state.accepted_at.endswith("Z"):
            raise ValidationError("source-state accepted_at is not UTC ISO-8601")
        return state


HELP = """Usage: graphify COMMAND [ARGS]

Fresh, read-only code intelligence for the current managed worktree.

Commands:
  query TEXT       search graph nodes
  path FROM TO     find a shortest dependency path
  explain NODE     describe a node and its connections
  affected NODE    list transitive dependents
  help             show this help
  version          show the pinned Graphify version

Run graphify COMMAND --help for this same side-effect-free syntax summary.

The private index is refreshed automatically from current source before every
read. Output/cache paths, graph selection, extraction, update, watch, hooks,
MCP, global graphs, daemons, networking, and query history are not exposed.
"""


def parse_public_command(argv: Sequence[str]) -> QueryCommand:
    args = list(argv)
    read_commands = {"query", "path", "explain", "affected"}
    if not args:
        return QueryCommand("help")
    if args == ["--help"] or args == ["-h"]:
        return QueryCommand("help")
    if args == ["--version"]:
        return QueryCommand("version")
    if len(args) == 2 and args[0] in read_commands and args[1] in {"--help", "-h"}:
        return QueryCommand("help")
    name = args[0]
    allowed = read_commands | {"help", "version"}
    if name not in allowed:
        raise PolicyError(f"unsupported command: {name}")
    rest = tuple(args[1:])
    if name in {"help", "version"}:
        if rest:
            raise PolicyError(f"{name} takes no arguments")
        return QueryCommand(name)
    if os.environ.get("GRAPHIFY_OUT"):
        raise PolicyError("GRAPHIFY_OUT is forbidden")
    forbidden = {"--graph", "--out", "--global", "--mcp", "--watch", "--hooks"}
    if any(a in forbidden or a.startswith("--graph=") or a.startswith("--out=") for a in rest):
        raise PolicyError("graph/output/global overrides are forbidden")
    if any(a.startswith("-") for a in rest):
        raise PolicyError("public query flags are not supported")
    expected = 2 if name == "path" else 1
    if len(rest) != expected or any(not a for a in rest):
        raise PolicyError(f"{name} requires exactly {expected} argument(s)")
    return QueryCommand(name, rest)


def _decode_mountinfo_field(value: str) -> str:
    return re.sub(
        r"\\([0-7]{3})",
        lambda match: chr(int(match.group(1), 8)),
        value,
    )


def _read_mountinfo() -> dict[str, MountInfo]:
    try:
        with MOUNTINFO_PATH.open("r", encoding="utf-8") as stream:
            raw = stream.read(MAX_MOUNTINFO_BYTES + 1)
    except OSError as exc:
        raise PolicyError(f"cannot verify Graphify runtime mounts: {exc}") from exc
    if len(raw.encode("utf-8")) > MAX_MOUNTINFO_BYTES:
        raise PolicyError("cannot verify Graphify runtime mounts: mount table is too large")

    mounts: dict[str, MountInfo] = {}
    for line in raw.splitlines():
        left, separator, right = line.partition(" - ")
        left_fields = left.split()
        right_fields = right.split()
        if not separator or len(left_fields) < 6 or len(right_fields) < 3:
            raise PolicyError("cannot verify Graphify runtime mounts: malformed mount table")
        try:
            mount_id = int(left_fields[0])
        except ValueError as exc:
            raise PolicyError("cannot verify Graphify runtime mounts: invalid mount identifier") from exc
        mountpoint = _decode_mountinfo_field(left_fields[4])
        entry = MountInfo(
            mount_id=mount_id,
            mountpoint=mountpoint,
            options=frozenset(left_fields[5].split(",")),
            filesystem=right_fields[0],
        )
        previous = mounts.get(mountpoint)
        if previous is None or previous.mount_id < mount_id:
            mounts[mountpoint] = entry
    return mounts


def _required_mount(path: Path, label: str, mounts: dict[str, MountInfo]) -> MountInfo:
    if path.is_symlink():
        raise PolicyError(f"required Graphify runtime topology is unavailable: {label} is symlinked")
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise PolicyError(f"required Graphify runtime topology is unavailable: {label} is missing") from exc
    if not resolved.is_dir() or resolved != path:
        raise PolicyError(f"required Graphify runtime topology is unavailable: {label} is not a direct directory")
    mount = mounts.get(str(resolved))
    if mount is None:
        raise PolicyError(f"required Graphify runtime topology is unavailable: {label} is not a dedicated mount")
    if "rw" not in mount.options or not os.access(resolved, os.W_OK | os.X_OK):
        raise PolicyError(f"required Graphify runtime topology is unavailable: {label} is not writable")
    return mount


def validate_runtime_topology() -> None:
    """Fail closed unless every host-enforced Graphify boundary is active."""
    mounts = _read_mountinfo()
    _required_mount(CACHE_BASE, "cache root", mounts)
    _required_mount(RUNTIME_DIR, "fleet worker-lock root", mounts)
    stage_mount = _required_mount(SOURCE_STAGE_ROOT, "staging root", mounts)
    if stage_mount.filesystem != "tmpfs":
        raise PolicyError("required Graphify runtime topology is unavailable: staging root is not tmpfs")
    stage_stat = SOURCE_STAGE_ROOT.stat()
    if stage_stat.st_uid != os.geteuid() or stat.S_IMODE(stage_stat.st_mode) != 0o700:
        raise PolicyError("required Graphify runtime topology is unavailable: staging tmpfs is not private")
    filesystem = os.statvfs(SOURCE_STAGE_ROOT)
    capacity = filesystem.f_frsize * filesystem.f_blocks
    if capacity <= 0 or capacity > MAX_TMPFS_BYTES:
        raise PolicyError("required Graphify runtime topology is unavailable: staging tmpfs exceeds 192 MiB")


def _git_toplevel(cwd: Path) -> Path:
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--show-toplevel"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=5, check=False, env={"PATH": os.environ.get("PATH", "")},
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PolicyError(f"cannot resolve Git worktree: {exc}") from exc
    if result.returncode or not result.stdout.strip():
        raise PolicyError("current directory is not a Git worktree")
    return Path(result.stdout.strip()).resolve(strict=True)


def resolve_managed_repo(cwd: os.PathLike[str] | str) -> ManagedRepo:
    try:
        requested = Path(cwd).resolve(strict=True)
        managed = WORKTREE_ROOT.resolve(strict=True)
    except OSError as exc:
        raise PolicyError(f"managed worktree path is missing: {exc}") from exc
    try:
        requested.relative_to(managed)
    except ValueError as exc:
        raise PolicyError("cwd escapes managed worktree root") from exc
    top = _git_toplevel(requested)
    if top.parent != managed or top == managed:
        raise PolicyError("Git root must be a direct child of /workspace/worktrees")
    try:
        requested.relative_to(top)
    except ValueError as exc:
        raise PolicyError("cwd does not belong to resolved Git root") from exc
    key = hashlib.sha256(os.fsencode(str(top))).hexdigest()
    return ManagedRepo(top, key, CACHE_BASE / key)


def _hash_file(path: Path, relative: str) -> tuple[str, str, int, str]:
    sha = hashlib.sha256()
    md5 = hashlib.md5(usedforsecurity=False)
    graphify = hashlib.sha256()
    total = 0
    try:
        with path.open("rb") as stream:
            while True:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_FILE_BYTES:
                    raise PolicyError(f"source file exceeds 5 MiB: {relative}")
                sha.update(chunk)
                md5.update(chunk)
                graphify.update(chunk)
    except PolicyError:
        raise
    except OSError as exc:
        raise PolicyError(f"cannot read source file {relative}: {exc}") from exc
    graphify.update(b"\x00")
    graphify.update(relative.lower().encode("utf-8"))
    return sha.hexdigest(), md5.hexdigest(), total, graphify.hexdigest()


def _is_detected(path: Path) -> bool:
    if path.name.lower() in PACKAGE_MANIFEST_NAMES:
        return True
    # detect.classify_file lowercases the suffix. Preserve the actual suffix as
    # well so capital-F preprocessing can be refused explicitly.
    suffix = path.suffix
    if suffix in CODE_EXTENSIONS or suffix.lower() in CODE_EXTENSIONS:
        return True
    return not suffix and _shebang_interpreter(path) is not None


def _shebang_interpreter(path: Path) -> str | None:
    try:
        with path.open("rb") as stream:
            first = stream.read(256).split(b"\n", 1)[0]
        if not first.startswith(b"#!"):
            return None
        parts = shlex.split(first[2:].decode("utf-8", errors="replace"))
    except (OSError, ValueError):
        return None
    if not parts:
        return None
    interpreter = Path(parts[0]).name
    if interpreter != "env":
        return interpreter
    args = parts[1:]
    # The pinned detector supports the common env flag/assignment forms.  This
    # bounded parser is intentionally conservative: an unknown option is still
    # detected as unsupported rather than silently omitted from the generation.
    index = 0
    while index < len(args):
        value = args[index]
        if value in {"-S", "--split-string"} and index + 1 < len(args):
            try:
                unpacked = shlex.split(" ".join(args[index + 1:]))
            except ValueError:
                return "<unsupported-env-shebang>"
            return Path(unpacked[0]).name if unpacked else "<unsupported-env-shebang>"
        if value.startswith("-S") and len(value) > 2:
            try:
                unpacked = shlex.split(value[2:] + " " + " ".join(args[index + 1:]))
            except ValueError:
                return "<unsupported-env-shebang>"
            return Path(unpacked[0]).name if unpacked else "<unsupported-env-shebang>"
        if value in {"-u", "-C", "-P", "-a", "--unset", "--chdir", "--argv0"}:
            index += 2
            continue
        if value.startswith("-"):
            index += 1
            continue
        if "=" in value:
            index += 1
            continue
        return Path(value).name
    return "<unsupported-env-shebang>"


def _validate_extractor(path: Path, relative: str) -> None:
    suffix = path.suffix
    if not suffix:
        interpreter = _shebang_interpreter(path)
        if interpreter not in {
            "python", "python2", "python3", "bash", "sh", "dash", "zsh", "ksh",
            "node", "nodejs", "ruby", "lua", "php", "julia",
        }:
            raise PolicyError(f"detected shebang has no in-process extractor: {relative}")
        return
    if suffix in CAPITAL_F_EXTENSIONS:
        raise PolicyError(f"capital-F Fortran requires forbidden cpp subprocess: {relative}")
    lowered = suffix.lower()
    if path.name.lower() in PACKAGE_MANIFEST_NAMES:
        return
    if lowered in {".ejs", ".ets", ".r"}:
        raise PolicyError(f"detected code has no in-process extractor: {relative}")
    if lowered == ".m":
        try:
            head = path.read_bytes()[:256 * 1024]
        except OSError as exc:
            raise PolicyError(f"cannot inspect ambiguous source {relative}: {exc}") from exc
        if not any(marker in head for marker in (b"@interface", b"@protocol", b"@implementation", b"@import", b"#import")):
            raise PolicyError(f"detected .m source has no applicable in-process extractor: {relative}")
    if lowered not in IN_PROCESS_EXTENSIONS:
        raise PolicyError(f"detected code has no pinned in-process extractor: {relative}")


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


def _inventory_referenced_assets(root: Path, files: Sequence[SourceFile]) -> tuple[tuple[AssetFile, ...], int]:
    referenced: set[str] = set()
    resolved_root = root.resolve(strict=True)

    def add_regular_support_file(candidate: Path) -> None:
        try:
            resolved = candidate.resolve(strict=True)
            relative = resolved.relative_to(resolved_root).as_posix()
        except (OSError, RuntimeError, ValueError):
            return
        lexical = Path(os.path.abspath(candidate))
        if lexical == resolved and resolved.is_file() and not resolved.is_symlink():
            referenced.add(relative)

    for item in files:
        skill_owner = _skill_source_owner(item.path)
        if skill_owner is not None:
            prefix, owner = skill_owner
            add_regular_support_file(
                root.joinpath(*prefix, ".claude", "skills", owner, "SKILL.md")
            )
        pairing_owner = _pairing_owner(item.path)
        if pairing_owner is not None:
            prefix, channel = pairing_owner
            add_regular_support_file(
                root.joinpath(
                    *prefix, ".claude", "skills", f"add-{channel}", "SKILL.md"
                )
            )
        if Path(item.path).suffix.lower() not in ASSET_REFERENCE_SOURCE_EXTENSIONS:
            continue
        source = root / item.path
        try:
            content = source.read_bytes()
        except OSError as exc:
            raise PolicyError(f"cannot inspect asset references in {item.path}: {exc}") from exc
        for match in QUOTED_RELATIVE_CSS.finditer(content):
            try:
                specifier = match.group("specifier").decode("utf-8")
            except UnicodeError as exc:
                raise PolicyError(f"asset reference is not UTF-8 in {item.path}") from exc
            candidate = source.parent / specifier
            try:
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(resolved_root)
            except (OSError, RuntimeError, ValueError):
                # Missing/escaping imports receive no proof and the worker will
                # reject the exact AST edge rather than trusting regex alone.
                continue
            lexical = Path(os.path.abspath(candidate))
            if lexical != resolved or not resolved.is_file() or resolved.is_symlink():
                continue
            if resolved.suffix.lower() not in NON_GRAPH_ASSET_EXTENSIONS or _is_detected(resolved):
                continue
            add_regular_support_file(candidate)

    assets: list[AssetFile] = []
    total = 0
    for relative in sorted(referenced):
        if len(assets) >= MAX_ASSET_FILES:
            raise PolicyError("referenced asset corpus exceeds 512 files")
        sha, _md5, size, _graphify_hash = _hash_file(root / relative, relative)
        total += size
        if total > MAX_ASSET_BYTES:
            raise PolicyError("referenced asset corpus exceeds 16 MiB")
        assets.append(AssetFile(relative, sha, size))
    return tuple(assets), total


def inventory_source(repo_root: os.PathLike[str] | str) -> SourceGeneration:
    root = Path(repo_root).resolve(strict=True)
    records: list[SourceFile] = []
    total = 0
    walk_errors: list[OSError] = []

    def onerror(error: OSError) -> None:
        walk_errors.append(error)

    try:
        walker = os.walk(root, topdown=True, followlinks=False, onerror=onerror)
        for dirpath, dirnames, filenames in walker:
            retained_dirs: list[str] = []
            for name in sorted(dirnames):
                if name in IGNORED_DIRS:
                    continue
                directory = Path(dirpath) / name
                if directory.is_symlink():
                    try:
                        target = directory.resolve(strict=True)
                        target.relative_to(root)
                    except (OSError, RuntimeError, ValueError) as exc:
                        raise PolicyError(f"symlinked source directory escapes or is broken: {directory.relative_to(root)}") from exc
                    # Internal directory symlinks remain deliberately unwalked.
                    continue
                retained_dirs.append(name)
            dirnames[:] = retained_dirs
            for name in sorted(filenames):
                path = Path(dirpath) / name
                if path.is_symlink():
                    try:
                        target = path.resolve(strict=True)
                        target.relative_to(root)
                    except (OSError, RuntimeError, ValueError) as exc:
                        raise PolicyError(f"symlinked source file escapes or is broken: {path.relative_to(root)}") from exc
                    # Internal file symlinks are never followed or indexed.
                    continue
                if not _is_detected(path):
                    continue
                try:
                    relative = path.relative_to(root).as_posix()
                except ValueError as exc:
                    raise PolicyError("inventory path escaped source root") from exc
                _validate_extractor(path, relative)
                sha, md5, size, graphify_hash = _hash_file(path, relative)
                total += size
                if len(records) >= MAX_CODE_FILES:
                    raise PolicyError("source corpus exceeds 4000 code files")
                if total > MAX_INPUT_BYTES:
                    raise PolicyError("source corpus exceeds 64 MiB")
                records.append(SourceFile(relative, sha, md5, size, graphify_hash))
    except GatewayError:
        raise
    except OSError as exc:
        raise PolicyError(f"source walk failed: {exc}") from exc
    if walk_errors:
        raise PolicyError(f"source walk incomplete: {walk_errors[0]}")
    records.sort(key=lambda item: item.path)
    assets, asset_total = _inventory_referenced_assets(root, records)
    if total + asset_total > MAX_INPUT_BYTES:
        raise PolicyError("source and referenced assets exceed 64 MiB")
    return SourceGeneration(
        tuple(records), total, _generation_fingerprint(records, assets), assets, asset_total
    )


def _generation_fingerprint(
    files: Sequence[SourceFile], assets: Sequence[AssetFile] = ()
) -> str:
    digest = hashlib.sha256()
    for item in files:
        digest.update(item.path.encode("utf-8")); digest.update(b"\0")
        digest.update(item.sha256.encode("ascii")); digest.update(b"\0")
        digest.update(str(item.bytes).encode("ascii")); digest.update(b"\n")
    for item in assets:
        digest.update(b"asset\0")
        digest.update(item.path.encode("utf-8")); digest.update(b"\0")
        digest.update(item.sha256.encode("ascii")); digest.update(b"\0")
        digest.update(str(item.bytes).encode("ascii")); digest.update(b"\n")
    return digest.hexdigest()


def require_equal_inventory(expected: SourceGeneration, actual: SourceGeneration) -> None:
    if expected != actual:
        raise SourceChanged("live source generation changed")


def retry_changed_refresh(operation: Callable[[int], int], deadline: float) -> int:
    last: SourceChanged | None = None
    for attempt in range(3):
        if time.monotonic() >= deadline:
            raise DeadlineExpired("refresh deadline expired")
        try:
            return operation(attempt)
        except SourceChanged as exc:
            last = exc
    assert last is not None
    raise last


@contextlib.contextmanager
def deadline_lock(path: Path, deadline: float) -> Iterator[float]:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
    started = time.monotonic()
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DeadlineExpired(f"lock wait expired: {path.name}")
                time.sleep(min(LOCK_POLL_SECONDS, remaining))
        yield time.monotonic() - started
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def wait_process(process: subprocess.Popen, deadline: float) -> int:
    while True:
        code = process.poll()
        if code is not None:
            return code
        # Reserve the last five seconds of the public budget for the mandated
        # TERM grace and possible KILL/reap, so teardown itself cannot overrun.
        if time.monotonic() >= deadline - TERM_GRACE_SECONDS:
            _terminate_group(process, deadline)
            raise DeadlineExpired("worker deadline expired")
        time.sleep(min(0.02, max(0.0, deadline - TERM_GRACE_SECONDS - time.monotonic())))


def _terminate_group(process: subprocess.Popen, kill_deadline: float | None = None) -> None:
    if process.poll() is not None:
        process.wait()
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    grace = kill_deadline if kill_deadline is not None else time.monotonic() + TERM_GRACE_SECONDS
    while process.poll() is None and time.monotonic() < grace:
        time.sleep(0.02)
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait()


def _read_cgroup_number(path: Path) -> int | None:
    try:
        raw = path.read_text(encoding="ascii").strip()
    except OSError:
        return None
    if raw == "max":
        return None
    try:
        return int(raw)
    except ValueError as exc:
        raise AdmissionError(f"invalid cgroup value in {path.name}") from exc


def enforce_memory_admission() -> None:
    current = _read_cgroup_number(CGROUP_MEMORY_CURRENT)
    maximum = _read_cgroup_number(CGROUP_MEMORY_MAX)
    if current is None or maximum is None:
        raise AdmissionError("finite cgroup memory.current and memory.max are required")
    required = WORKER_RESERVE_BYTES + OUTPUT_RESERVE_BYTES + RUNNER_RESERVE_BYTES
    if current + required > maximum:
        raise AdmissionError("insufficient cgroup memory headroom for Graphify worker")


def _safe_empty_dir(path: Path) -> None:
    if path.is_symlink():
        raise PolicyError(f"refusing symlink staging directory: {path}")
    if path.exists():
        _remove_tree(path)
    path.mkdir(parents=True, mode=0o700)


def _remove_tree(path: Path) -> None:
    """Remove an owned private tree, including a read-only source snapshot."""
    if not path.exists():
        return
    for dirpath, dirnames, filenames in os.walk(path, topdown=False, followlinks=False):
        directory = Path(dirpath)
        for name in filenames:
            try:
                os.chmod(directory / name, 0o600, follow_symlinks=False)
            except OSError:
                pass
        for name in dirnames:
            try:
                os.chmod(directory / name, 0o700, follow_symlinks=False)
            except OSError:
                pass
    try:
        os.chmod(path, 0o700, follow_symlinks=False)
    except OSError:
        pass
    shutil.rmtree(path, ignore_errors=False)


def capture_source(repo_root: Path, destination: Path, generation: SourceGeneration) -> None:
    _safe_empty_dir(destination)
    try:
        for item in (*generation.files, *generation.assets):
            source = repo_root / item.path
            target = destination / item.path
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            sha = hashlib.sha256()
            with source.open("rb") as src, target.open("xb") as dst:
                copied = 0
                while True:
                    chunk = src.read(64 * 1024)
                    if not chunk:
                        break
                    copied += len(chunk); sha.update(chunk); dst.write(chunk)
            if copied != item.bytes or sha.hexdigest() != item.sha256:
                raise SourceChanged(f"source mutated during capture: {item.path}")
        captured = inventory_source(destination)
        require_equal_inventory(generation, captured)
        require_equal_inventory(generation, inventory_source(repo_root))
        # The worker receives a read-only snapshot, never a writable mirror of
        # live source. Cleanup restores owner permissions via _remove_tree.
        for dirpath, _dirnames, filenames in os.walk(destination, topdown=False):
            directory = Path(dirpath)
            for name in filenames:
                os.chmod(directory / name, 0o400)
            os.chmod(directory, 0o500)
    except Exception:
        try:
            _remove_tree(destination)
        except OSError:
            pass
        raise


def seed_ast_cache(live: Path, destination: Path, generation: SourceGeneration) -> int:
    """Stream-copy only AST entries proven identical by accepted source state."""
    _safe_empty_dir(destination)
    old_ast = live / "ast"
    if not _validate_live(live) or not old_ast.is_dir():
        return 0
    prior = _load_state(live)
    if prior is None:
        return 0
    current_folded: dict[str, int] = {}
    prior_folded: dict[str, int] = {}
    for item in generation.files:
        current_folded[item.path.casefold()] = current_folded.get(item.path.casefold(), 0) + 1
    for item in prior.files:
        prior_folded[item.path.casefold()] = prior_folded.get(item.path.casefold(), 0) + 1
    if any(count != 1 for count in current_folded.values()) or any(
        count != 1 for count in prior_folded.values()
    ):
        return 0
    prior_by_path = {item.path: item for item in prior.files}
    total = 0
    for item in generation.files:
        previous = prior_by_path.get(item.path)
        if previous is None or previous.graphify_hash != item.graphify_hash:
            continue
        entry = old_ast / f"{item.graphify_hash}.json"
        if not entry.is_file() or entry.is_symlink():
            continue
        remaining = MAX_AST_BYTES - total
        if remaining <= 0:
            break
        total += _bounded_copy_file(entry, destination / entry.name, remaining)
    return total


def _stream_hash(path: Path, cap: int) -> tuple[int, str, bytes, bytes]:
    digest = hashlib.sha256(); total = 0; first = b""; last = b""
    try:
        with path.open("rb") as stream:
            while True:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    break
                if not first:
                    first = chunk[:64]
                last = (last + chunk)[-64:]
                total += len(chunk)
                if total > cap:
                    raise ValidationError(f"candidate artifact exceeds {cap} bytes")
                digest.update(chunk)
    except ValidationError:
        raise
    except OSError as exc:
        raise ValidationError(f"cannot read candidate artifact: {exc}") from exc
    return total, digest.hexdigest(), first, last


def _read_bounded_json(path: Path, cap: int) -> object:
    data = bytearray()
    try:
        with path.open("rb") as stream:
            while True:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > cap:
                    raise ValidationError(f"JSON artifact exceeds {cap} bytes: {path.name}")
        return json.loads(data)
    except ValidationError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValidationError(f"invalid bounded JSON artifact {path.name}: {exc}") from exc


def validate_candidate(candidate: Path, expected: SourceGeneration | None) -> dict:
    allowed_entries = {"graph.json", "manifest.json", "status.json", "source-state.json", "ast"}
    try:
        entries = list(candidate.iterdir())
    except OSError as exc:
        raise ValidationError(f"cannot enumerate candidate namespace: {exc}") from exc
    if any(entry.name not in allowed_entries or entry.is_symlink() for entry in entries):
        raise ValidationError("candidate contains unexpected or symlinked artifacts")
    graph = candidate / "graph.json"
    manifest = candidate / "manifest.json"
    status_path = candidate / "status.json"
    if not graph.is_file() or not manifest.is_file() or not status_path.is_file():
        if expected is None and graph.is_file():
            _, _, first, last = _stream_hash(graph, MAX_GRAPH_BYTES)
            if first.lstrip()[:1] != b"{" or last.rstrip()[-1:] != b"}":
                raise ValidationError("candidate graph is not a JSON object")
        raise ValidationError("candidate is missing graph, manifest, or status")
    graph_size, graph_sha, first, last = _stream_hash(graph, MAX_GRAPH_BYTES)
    if graph_size == 0 or first.lstrip()[:1] != b"{" or last.rstrip()[-1:] != b"}":
        raise ValidationError("candidate graph is not a JSON object")
    manifest_size, manifest_sha, _, _ = _stream_hash(manifest, MAX_METADATA_BYTES)
    status_size, _, _, _ = _stream_hash(status_path, MAX_METADATA_BYTES)
    candidate_total = graph_size + manifest_size + status_size
    if not manifest_size or not status_size:
        raise ValidationError("empty candidate metadata")
    try:
        status = _read_bounded_json(status_path, MAX_METADATA_BYTES)
        manifest_data = _read_bounded_json(manifest, MAX_METADATA_BYTES)
    except (GatewayError, OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValidationError(f"invalid candidate metadata: {exc}") from exc
    status_fields = {
        "detected", "applicable", "intentional_exclusions", "contributed",
        "unsupported", "failed", "graph_sha256", "manifest_sha256", "graph_bytes",
    }
    if not isinstance(status, dict) or set(status) != status_fields:
        raise ValidationError("candidate status schema is invalid")
    if not isinstance(manifest_data, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in manifest_data.items()
    ):
        raise ValidationError("candidate manifest schema is invalid")
    if any(
        not isinstance(status[field], list)
        or not all(isinstance(value, str) for value in status[field])
        for field in ("detected", "applicable", "intentional_exclusions", "contributed")
    ) or any(
        not isinstance(status[field], dict)
        or not all(isinstance(key, str) and isinstance(value, str) for key, value in status[field].items())
        for field in ("unsupported", "failed")
    ):
        raise ValidationError("candidate status collection types are invalid")
    if (
        not isinstance(status["graph_sha256"], str)
        or not isinstance(status["manifest_sha256"], str)
        or not isinstance(status["graph_bytes"], int)
    ):
        raise ValidationError("candidate status scalar types are invalid")
    if status.get("graph_sha256") != graph_sha or status.get("manifest_sha256") != manifest_sha:
        raise ValidationError("candidate artifact hash mismatch")
    if status.get("graph_bytes") != graph_size:
        raise ValidationError("candidate graph size mismatch")
    if status.get("failed") or status.get("unsupported"):
        raise ValidationError("worker reported incomplete extraction")
    if expected is not None:
        expected_paths = [item.path for item in expected.files]
        if status.get("detected") != expected_paths:
            raise ValidationError("worker detected set differs from source generation")
        reconciled = sorted(status.get("contributed", []) + status.get("intentional_exclusions", []))
        if reconciled != expected_paths:
            raise ValidationError("worker did not reconcile every detected source")
        expected_md5 = {item.path: item.md5 for item in expected.files}
        if manifest_data != expected_md5:
            raise ValidationError("candidate manifest does not match generation MD5 values")
        ast = candidate / "ast"
        if ast.exists():
            if not ast.is_dir() or ast.is_symlink():
                raise ValidationError("candidate AST cache is not a private directory")
            allowed_hashes = {item.graphify_hash for item in expected.files}
            ast_total = 0
            for entry in sorted(ast.iterdir(), key=lambda item: item.name):
                if (
                    not entry.is_file() or entry.is_symlink() or entry.suffix != ".json"
                    or entry.stem not in allowed_hashes
                ):
                    raise ValidationError("candidate AST cache contains an invalid entry")
                size, _sha, _first, _last = _stream_hash(entry, MAX_AST_BYTES)
                ast_total += size
                if ast_total > MAX_AST_BYTES:
                    raise ValidationError("candidate AST cache exceeds 128 MiB")
            candidate_total += ast_total
    if candidate_total > MAX_TMPFS_BYTES:
        raise ValidationError("candidate exceeds the validated tmpfs output quota")
    return status


def _bounded_copy_file(source: Path, target: Path, cap: int) -> int:
    copied = 0
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        with source.open("rb") as src, target.open("xb") as dst:
            while True:
                chunk = src.read(64 * 1024)
                if not chunk:
                    break
                copied += len(chunk)
                if copied > cap:
                    raise ValidationError(f"validated artifact exceeds copy cap: {source.name}")
                dst.write(chunk)
    except ValidationError:
        raise
    except OSError as exc:
        raise ValidationError(f"bounded candidate copy failed: {exc}") from exc
    return copied


def copy_validated_candidate(source: Path, persistent_stage: Path, generation: SourceGeneration) -> None:
    """Stream a validated tmpfs candidate into the persistent same-FS stage."""
    validate_candidate(source, generation)
    _safe_empty_dir(persistent_stage)
    try:
        _bounded_copy_file(source / "graph.json", persistent_stage / "graph.json", MAX_GRAPH_BYTES)
        _bounded_copy_file(source / "manifest.json", persistent_stage / "manifest.json", MAX_METADATA_BYTES)
        _bounded_copy_file(source / "status.json", persistent_stage / "status.json", MAX_METADATA_BYTES)
        source_ast = source / "ast"
        ast_total = 0
        if source_ast.is_dir():
            target_ast = persistent_stage / "ast"
            target_ast.mkdir(mode=0o700)
            for entry in sorted(source_ast.iterdir(), key=lambda item: item.name):
                copied = _bounded_copy_file(entry, target_ast / entry.name, MAX_AST_BYTES)
                ast_total += copied
                if ast_total > MAX_AST_BYTES:
                    raise ValidationError("validated AST cache exceeds persistent copy cap")
        validate_candidate(persistent_stage, generation)
    except Exception:
        shutil.rmtree(persistent_stage, ignore_errors=True)
        raise


def _validate_live(path: Path) -> bool:
    try:
        state = AcceptedSourceState.from_json(
            _read_bounded_json(path / "source-state.json", MAX_STATE_BYTES)
        )
        if (
            state.total_bytes != sum(item.bytes for item in state.files)
            or state.asset_total_bytes != sum(item.bytes for item in state.assets)
            or state.fingerprint != _generation_fingerprint(state.files, state.assets)
        ):
            raise ValidationError("source-state fingerprint or byte count is invalid")
        validate_candidate(path, SourceGeneration(
            state.files, state.total_bytes, state.fingerprint,
            state.assets, state.asset_total_bytes,
        ))
    except (GatewayError, OSError, json.JSONDecodeError, TypeError, ValueError):
        return False
    return True


def recover_cache(cache_root: Path) -> None:
    live = cache_root / "live"; backup = cache_root / "backup"; stage = cache_root / "stage"
    shutil.rmtree(stage, ignore_errors=True)
    if _validate_live(live):
        shutil.rmtree(backup, ignore_errors=True)
        return
    if _validate_live(backup):
        shutil.rmtree(live, ignore_errors=True)
        os.replace(backup, live)
        return
    shutil.rmtree(live, ignore_errors=True)
    shutil.rmtree(backup, ignore_errors=True)


def promote_candidate(cache_root: Path, candidate: Path, state: AcceptedSourceState) -> None:
    live = cache_root / "live"; backup = cache_root / "backup"
    encoded_state = json.dumps(state.to_json(), sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(encoded_state) > MAX_STATE_BYTES:
        raise ValidationError("source-state exceeds metadata limit")
    (candidate / "source-state.json").write_bytes(encoded_state)
    if backup.exists():
        shutil.rmtree(backup)
    if live.exists():
        os.replace(live, backup)
    try:
        os.replace(candidate, live)
        if not _validate_live(live):
            raise ValidationError("promoted live namespace failed validation")
    except Exception:
        if live.exists():
            shutil.rmtree(live, ignore_errors=True)
        if backup.exists() and _validate_live(backup):
            os.replace(backup, live)
        raise
    shutil.rmtree(backup, ignore_errors=True)


def _invoke_worker(descriptor: dict, deadline: float) -> tuple[int, str, str, dict]:
    encoded = json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_REQUEST_BYTES:
        raise PolicyError("worker descriptor exceeds metadata limit")
    SOURCE_STAGE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    request_dir = Path(tempfile.mkdtemp(prefix="request-", dir=SOURCE_STAGE_ROOT))
    os.chmod(request_dir, 0o700)
    request_path = request_dir / "request.json"
    fd = os.open(request_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded)
        process = subprocess.Popen(
            [str(WORKER_PYTHON), str(WORKER_SCRIPT), str(request_path)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True, close_fds=True,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
        )
        try:
            code = wait_process(process, deadline)
            stdout, stderr = process.communicate()
        except Exception:
            if process.poll() is None:
                _terminate_group(process)
            raise
        if len(stdout.encode()) > MAX_DIAGNOSTIC_BYTES or len(stderr.encode()) > MAX_DIAGNOSTIC_BYTES:
            raise ValidationError("worker diagnostics exceed metadata limit")
        telemetry = {}
        for line in stderr.splitlines():
            if line.startswith("NANOCLAW_GRAPHIFY_TELEMETRY "):
                try:
                    telemetry = json.loads(line.split(" ", 1)[1])
                except json.JSONDecodeError:
                    pass
        return code, stdout, stderr, telemetry
    finally:
        shutil.rmtree(request_dir, ignore_errors=True)


def _load_state(live: Path) -> AcceptedSourceState | None:
    try:
        return AcceptedSourceState.from_json(_read_bounded_json(live / "source-state.json", MAX_STATE_BYTES))
    except (OSError, json.JSONDecodeError, TypeError, ValueError, GatewayError):
        return None


def _extract_once(repo: ManagedRepo, generation: SourceGeneration, command: QueryCommand, deadline: float, attempt: int) -> int:
    tmpfs_generation = SOURCE_STAGE_ROOT / repo.cache_key
    host_source = tmpfs_generation / "source"
    tmpfs_candidate = tmpfs_generation / "candidate"
    persistent_candidate = repo.cache_root / "stage"
    try:
        with deadline_lock(WORKER_LOCK, deadline) as global_wait:
            _TELEMETRY["global_wait_ms"] = round(float(_TELEMETRY.get("global_wait_ms", 0)) + global_wait * 1000, 3)
            # Admission must describe the moment the single global worker slot
            # is ours; checking before the wait would admit on stale headroom.
            enforce_memory_admission()
            shutil.rmtree(persistent_candidate, ignore_errors=True)
            # SOURCE_STAGE_ROOT is the Docker tmpfs mountpoint.  Never remove
            # the mount root itself (rmtree can fail with EBUSY); own and clean
            # only this repository's child while holding the global slot.
            SOURCE_STAGE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
            _safe_empty_dir(tmpfs_generation)
            capture_source(repo.root, host_source, generation)
            seed_ast_cache(
                repo.cache_root / "live",
                tmpfs_candidate / "graphify-out" / "cache" / "ast" / f"v{GRAPHIFY_VERSION}",
                generation,
            )
            descriptor = {
                "operation": "extract",
                "source_root": str(host_source),
                "output_root": str(tmpfs_candidate),
                "files": [asdict(item) for item in generation.files],
                "assets": [asdict(item) for item in generation.assets],
                "graphify_version": GRAPHIFY_VERSION,
                "limits": {"address_space_bytes": WORKER_RESERVE_BYTES, "file_bytes": MAX_GRAPH_BYTES, "process_count": 0},
            }
            code, _stdout, stderr, worker_telemetry = _invoke_worker(descriptor, deadline)
            for key in (
                "worker_rss_kib", "worker_virtual_kib", "cgroup_memory_current",
                "cgroup_memory_peak", "tmpfs_high_water_bytes", "input_bytes",
                "graph_bytes", "ast_bytes", "duration_ms",
            ):
                if key in worker_telemetry:
                    _TELEMETRY["worker_" + key if key == "duration_ms" else key] = worker_telemetry[key]
            if code:
                raise ValidationError(f"Graphify extraction worker failed with exit {code}: {stderr[-1024:]}")
            require_equal_inventory(generation, inventory_source(repo.root))
            validate_candidate(tmpfs_candidate, generation)
            _remove_tree(host_source)
            copy_validated_candidate(tmpfs_candidate, persistent_candidate, generation)
            promote_candidate(
                repo.cache_root,
                persistent_candidate,
                AcceptedSourceState.from_generation(generation),
            )
        return _query_cached(repo, generation, command, deadline)
    finally:
        try:
            _remove_tree(tmpfs_generation)
        except OSError:
            pass
        if persistent_candidate.exists():
            shutil.rmtree(persistent_candidate, ignore_errors=True)


def _query_cached(repo: ManagedRepo, generation: SourceGeneration, command: QueryCommand, deadline: float) -> int:
    live = repo.cache_root / "live"
    if not _validate_live(live):
        raise ValidationError("validated live index is unavailable")
    with deadline_lock(WORKER_LOCK, deadline) as global_wait:
        _TELEMETRY["global_wait_ms"] = round(float(_TELEMETRY.get("global_wait_ms", 0)) + global_wait * 1000, 3)
        enforce_memory_admission()
        require_equal_inventory(generation, inventory_source(repo.root))
        require_equal_inventory(generation, inventory_source(repo.root))
        state = _load_state(live)
        if state is None or state.fingerprint != generation.fingerprint:
            raise SourceChanged("cached source-state is not current")
        descriptor = {
            "operation": "query", "command": command.name,
            "arguments": list(command.arguments), "graph": str(live / "graph.json"),
            "limits": {"address_space_bytes": WORKER_RESERVE_BYTES, "file_bytes": MAX_GRAPH_BYTES, "process_count": 0},
        }
        code, stdout, stderr, worker_telemetry = _invoke_worker(descriptor, deadline)
        for key in (
            "worker_rss_kib", "worker_virtual_kib", "cgroup_memory_current",
            "cgroup_memory_peak", "tmpfs_high_water_bytes", "graph_bytes", "duration_ms",
        ):
            if key in worker_telemetry:
                _TELEMETRY["worker_" + key if key == "duration_ms" else key] = worker_telemetry[key]
    if code:
        raise ValidationError(f"Graphify query worker failed with exit {code}: {stderr[-1024:]}")
    sys.stdout.write(stdout)
    return 0


def refresh_index(repo: ManagedRepo, generation: SourceGeneration, command: QueryCommand) -> int:
    # A genuinely cached read owns one 120s budget from its cache-lock wait
    # onward. A changed/missing generation owns the single 900s refresh budget.
    prelock_state = _load_state(repo.cache_root / "live")
    budget = QUERY_SECONDS if prelock_state and prelock_state.fingerprint == generation.fingerprint else REFRESH_SECONDS
    deadline = time.monotonic() + budget
    repo.cache_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with deadline_lock(repo.cache_root / "lock", deadline) as cache_wait:
        _TELEMETRY["cache_wait_ms"] = round(cache_wait * 1000, 3)
        recover_cache(repo.cache_root)
        current = inventory_source(repo.root)
        if generation != current:
            # A caller can wait behind another cache transaction while source
            # changes.  Rebase instead of surfacing a stale-snapshot race, and
            # grant the changed generation its full refresh budget.
            generation = current
            deadline = time.monotonic() + REFRESH_SECONDS
            _TELEMETRY["cache_wait_refresh"] = 1
        state = _load_state(repo.cache_root / "live")
        if state is not None and state.fingerprint == generation.fingerprint:
            _TELEMETRY["mode"] = "cached"
            _TELEMETRY["retry"] = 0
            try:
                return _query_cached(
                    repo, generation, command,
                    min(deadline, time.monotonic() + QUERY_SECONDS),
                )
            except SourceChanged:
                # The source can change while a cached caller waits for the
                # global worker slot. Never bubble that race or query the old
                # graph: rebase onto the fresh generation and enter the normal
                # changed-refresh retry boundary while retaining the cache lock.
                generation = inventory_source(repo.root)
                deadline = time.monotonic() + REFRESH_SECONDS
                _TELEMETRY["mode"] = "refresh"
                _TELEMETRY["post_wait_refresh"] = 1

        def attempt(number: int) -> int:
            _TELEMETRY["mode"] = "refresh"
            _TELEMETRY["retry"] = number
            fresh = inventory_source(repo.root)
            if number == 0:
                require_equal_inventory(generation, fresh)
            return _extract_once(repo, fresh, command, deadline, number)

        return retry_changed_refresh(attempt, deadline)


def main(argv: Sequence[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else list(argv)
    _TELEMETRY.clear()
    started = time.monotonic()
    emit_telemetry = False
    reason = "ok"
    try:
        command = parse_public_command(args)
        if command.name == "help":
            print(HELP, end="")
            return 0
        if command.name == "version":
            print(PUBLIC_VERSION)
            return 0
        emit_telemetry = True
        validate_runtime_topology()
        repo = resolve_managed_repo(Path.cwd())
        inventory_started = time.monotonic()
        generation = inventory_source(repo.root)
        _TELEMETRY["inventory_ms"] = round((time.monotonic() - inventory_started) * 1000, 3)
        _TELEMETRY["source_files"] = len(generation.files)
        _TELEMETRY["source_bytes"] = generation.total_bytes
        _TELEMETRY["asset_files"] = len(generation.assets)
        _TELEMETRY["asset_bytes"] = generation.asset_total_bytes
        return refresh_index(repo, generation, command)
    except (GatewayError, OSError) as exc:
        reason = type(exc).__name__
        guidance = "inspect authoritative source directly and retry Graphify later"
        if isinstance(exc, PolicyError) and "managed worktree" in str(exc):
            guidance += "; create or reuse a managed worktree first"
        print(f"graphify: {exc}; {guidance}.", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        reason = "interrupted"
        print("graphify: interrupted", file=sys.stderr)
        return 130
    finally:
        if emit_telemetry:
            _TELEMETRY["duration_ms"] = round((time.monotonic() - started) * 1000, 3)
            _TELEMETRY["reason"] = reason
            print(
                "NANOCLAW_GRAPHIFY_SUPERVISOR " + json.dumps(_TELEMETRY, sort_keys=True, separators=(",", ":")),
                file=sys.stderr,
            )


if __name__ == "__main__":
    raise SystemExit(main())
