from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


UPSTREAM = Path("/tmp/graphify-design")
INTEGRATION_PATH = Path(__file__).parents[1] / "graphify-integration.json"
INTEGRATION = json.loads(INTEGRATION_PATH.read_text(encoding="utf-8"))
TAG = INTEGRATION["upstream"]["tag"]
VERSION = INTEGRATION["package"]["version"]
PATCH = Path(__file__).parents[2] / INTEGRATION["patch"]["path"]
GATEWAY = Path(__file__).parents[1] / "graphify-gateway.py"

PINNED_SHA256 = INTEGRATION["sourceSha256"]

PINNED_DISPATCH = frozenset({
    '.py', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.go', '.rs',
    '.java', '.groovy', '.gradle', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp',
    '.cu', '.cuh', '.metal', '.rb', '.rake', '.cs', '.kt', '.kts', '.scala',
    '.php', '.swift', '.lua', '.luau', '.toc', '.zig', '.ps1', '.psm1', '.psd1',
    '.ex', '.exs', '.m', '.mm', '.jl', '.f', '.F', '.f90', '.F90', '.f95',
    '.F95', '.f03', '.F03', '.f08', '.F08', '.vue', '.svelte', '.astro', '.dart',
    '.v', '.sv', '.svh', '.sql', '.md', '.mdx', '.qmd', '.pas', '.pp', '.dpr',
    '.dpk', '.lpr', '.inc', '.dfm', '.lfm', '.lpk', '.sh', '.bash', '.json',
    '.tf', '.tfvars', '.hcl', '.dm', '.dme', '.dmi', '.dmm', '.dmf', '.sln',
    '.slnx', '.csproj', '.fsproj', '.vbproj', '.xaml', '.razor', '.cshtml',
    '.cls', '.trigger', '.skill',
})


def show(path: str) -> str:
    result = subprocess.run(
        ["git", "show", f"{TAG}:{path}"], cwd=UPSTREAM,
        check=True, stdout=subprocess.PIPE, text=True,
    )
    return result.stdout


def load_gateway():
    spec = importlib.util.spec_from_file_location("graphify_contract_gateway", GATEWAY)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class UpstreamContractTest(unittest.TestCase):
    def _materialize(self, root: Path) -> None:
        for relative in (
            "graphify/detect.py",
            "graphify/extract.py",
            "graphify/extractors/engine.py",
            "graphify/extractors/resolution.py",
        ):
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(show(relative), encoding="utf-8")

    def test_manifest_patch_and_upstream_identity_are_exact(self):
        self.assertEqual(hashlib.sha256(PATCH.read_bytes()).hexdigest(), INTEGRATION["patch"]["sha256"])
        commit = subprocess.run(
            ["git", "rev-parse", f"{TAG}^{{commit}}"], cwd=UPSTREAM,
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        self.assertEqual(commit, INTEGRATION["upstream"]["commit"])
        skill = show(INTEGRATION["upstream"]["skillPath"])
        self.assertEqual(hashlib.sha256(skill.encode()).hexdigest(), INTEGRATION["upstream"]["skillSha256"])
        allowed = {"adopted", "implemented-differently", "deferred", "rejected"}
        self.assertTrue(INTEGRATION["capabilities"])
        self.assertTrue(all(item["status"] in allowed and item["note"] for item in INTEGRATION["capabilities"]))

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._materialize(root)
            first = subprocess.run(["git", "apply", "--check", str(PATCH)], cwd=root, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            subprocess.run(["git", "apply", str(PATCH)], cwd=root, check=True)
            second = subprocess.run(["git", "apply", "--check", str(PATCH)], cwd=root, capture_output=True, text=True)
            self.assertNotEqual(second.returncode, 0)
            # Exact-context drift must fail too.
            extract = root / "graphify/extract.py"
            extract.write_text(extract.read_text().replace("NanoClaw worker", "drifted worker", 1), encoding="utf-8")
            reverse = subprocess.run(["git", "apply", "--reverse", "--check", str(PATCH)], cwd=root, capture_output=True, text=True)
            self.assertNotEqual(reverse.returncode, 0)

    def test_manifest_tracks_semantic_prompt_and_watch_drift(self):
        surfaces = INTEGRATION["upstream"]["semanticSurfaces"]
        required = {
            "codex-extraction-spec",
            "detector",
            "extractor",
            "codex-watch",
            "watcher",
            "codex-transcribe",
            "transcriber",
            "inert-wrapper",
        }
        self.assertEqual(set(surfaces), required)
        for surface, pinned in surfaces.items():
            with self.subTest(surface=surface):
                content = show(pinned["path"])
                self.assertEqual(hashlib.sha256(content.encode()).hexdigest(), pinned["sha256"])

    def test_every_upstream_capability_is_classified(self):
        inventory = set(INTEGRATION["upstreamCapabilities"])
        classified = {item["id"]: item for item in INTEGRATION["capabilities"]}
        self.assertEqual(inventory, set(classified))
        self.assertEqual(len(INTEGRATION["upstreamCapabilities"]), len(inventory))
        for capability in inventory:
            with self.subTest(capability=capability):
                self.assertIn(classified[capability]["status"], {
                    "adopted", "implemented-differently", "deferred", "rejected"
                })
                self.assertTrue(classified[capability]["note"])

        expected = {
            "semantic-document-extraction": "adopted",
            "pdf-preprocessing": "adopted",
            "office-preprocessing": "adopted",
            "image-semantic-extraction": "adopted",
            "media-transcription": "deferred",
            "automatic-index-freshness": "implemented-differently",
            "watch": "implemented-differently",
            "extract": "adopted",
        }
        self.assertEqual(
            {capability: classified[capability]["status"] for capability in expected},
            expected,
        )
        self.assertIn("verified local", classified["image-semantic-extraction"]["note"])
        self.assertIn("Codex attachment", classified["image-semantic-extraction"]["note"])
        self.assertIn("offline", classified["media-transcription"]["note"])

    def test_agent_environment_cannot_override_the_integration_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            hostile = Path(tmp) / "hostile.json"
            hostile.write_text(json.dumps({"schemaVersion": 1, "package": {"version": "999.0.0"}}))
            with mock.patch.dict(os.environ, {"NANOCLAW_GRAPHIFY_MANIFEST": str(hostile)}):
                gateway = load_gateway()
            self.assertEqual(gateway.GRAPHIFY_VERSION, VERSION)

    def test_sequential_patch_removes_required_task_creation(self):
        text = PATCH.read_text(encoding="utf-8")
        self.assertEqual(text.count("NANOCLAW_GRAPHIFY_SEQUENTIAL"), 2)
        self.assertIn('parallel = False', text)
        self.assertIn('raw = map(_stat_and_hash, all_files)', text)
        self.assertIn('+    if anchor_root is not None:', text)
        self.assertIn('source path escapes explicit root', text)
        self.assertNotIn('+    source_root:', text)
        self.assertEqual(text.count("diff --git"), 4)
        self.assertIn("type_colliding_callables", text)
        self.assertIn("callable_symbol_nodes", text)
        self.assertIn("callable_candidates", text)
        self.assertNotIn("graphify/cli.py", text)

    def test_contract_inventory_matches_pinned_upstream(self):
        sources = {path: show(path) for path in PINNED_SHA256}
        for path, expected in PINNED_SHA256.items():
            self.assertEqual(hashlib.sha256(sources[path].encode()).hexdigest(), expected, path)

        detect_tree = ast.parse(sources["graphify/detect.py"])
        code_extensions = None
        for node in detect_tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "CODE_EXTENSIONS" for t in node.targets):
                code_extensions = frozenset(ast.literal_eval(node.value))
        self.assertEqual(code_extensions, load_gateway().CODE_EXTENSIONS)

        extract_tree = ast.parse(sources["graphify/extract.py"])
        dispatch = None
        for node in extract_tree.body:
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "_DISPATCH":
                assert isinstance(node.value, ast.Dict)
                dispatch = frozenset(ast.literal_eval(key) for key in node.value.keys)
        self.assertEqual(dispatch, PINNED_DISPATCH)

        cache = sources["graphify/cache.py"]
        self.assertIn("h.update(content)", cache)
        self.assertIn('h.update(b"\\x00")', cache)
        self.assertIn("salt = resolved.relative_to(Path(root).resolve()).as_posix().lower()", cache)
        self.assertIn("h.update(salt.encode())", cache)
        json_source = sources["graphify/extractors/json_config.py"]
        self.assertIn('"skipped": "data json (not a config/manifest)"', json_source)
        self.assertIn('"skipped": "data json (non-object root)"', json_source)
        fortran = sources["graphify/extractors/fortran.py"]
        self.assertIn('subprocess.run(', fortran)
        self.assertIn('_FORTRAN_CPP_EXTS = {".F", ".F90", ".F95", ".F03", ".F08"}', fortran)
        self.assertIn("with ThreadPoolExecutor() as pool:", sources["graphify/detect.py"])
        mcp = sources["graphify/mcp_ingest.py"]
        for name in (".mcp.json", "claude_desktop_config.json", "mcp.json", "mcp_servers.json"):
            self.assertIn(f'"{name}"', mcp)
        self.assertIn("for env_name in env.keys()", mcp)
        self.assertNotIn("env.values()", mcp)
        self.assertLess(
            sources["graphify/extract.py"].index("if is_mcp_config_path(path):"),
            sources["graphify/extract.py"].index("suffix = path.suffix", sources["graphify/extract.py"].index("def _get_extractor")),
        )
        self.assertIn('["git", "rev-parse", "HEAD"]', sources["graphify/export.py"])
        build = sources["graphify/build.py"]
        self.assertIn('"does not match any node id" not in e', build)
        self.assertIn("skip edges to external/stdlib nodes - expected, not an error", build)
        # Pin the upstream soft-failure diagnostics that the worker promotes to hard failures.
        for diagnostic in (
            "produced zero nodes", "classified as code but graphify has no AST",
            "not installed", "AST extraction failed",
        ):
            self.assertIn(diagnostic, sources["graphify/extract.py"] + sources["graphify/cli.py"])

    def test_patched_extract_external_cache_duplicate_basenames_are_portable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._materialize(root)
            subprocess.run(["git", "apply", str(PATCH)], cwd=root, check=True)
            patched_source = (root / "graphify/extract.py").read_text(encoding="utf-8")
            tree = ast.parse(patched_source)
            function = next(
                node for node in tree.body
                if isinstance(node, ast.FunctionDef) and node.name == "extract"
            )
            self.assertEqual(
                [argument.arg for argument in function.args.kwonlyargs],
                ["root", "parallel", "max_workers"],
            )

            # Execute the exact patched function until its first cache lookup.
            # This proves upstream's explicit source anchor remains separate
            # from the external cache location and is part of the pinned signature.
            executable = ast.Module(
                body=[ast.ImportFrom(
                    module="__future__", names=[ast.alias(name="annotations", asname=None)], level=0
                ), function],
                type_ignores=[],
            )
            ast.fix_missing_locations(executable)
            captured = []

            class LookupReached(Exception):
                pass

            def load_cached(path, source_anchor, cache_root=None):
                captured.append((Path(path), Path(source_anchor), Path(cache_root)))
                raise LookupReached

            namespace = {
                "Path": Path,
                "os": os,
                "_check_tree_sitter_version": lambda: None,
                "_raise_recursion_limit": lambda: None,
                "_WORKSPACE_PACKAGE_CACHE": {},
                "_XAML_CSHARP_CLASS_CACHE": {},
                "_get_extractor": lambda _path: object(),
                "_JS_CACHE_BYPASS_SUFFIXES": set(),
                "load_cached": load_cached,
            }
            exec(compile(executable, "patched-extract.py", "exec"), namespace)
            checkout_one = root / "checkout-one"
            checkout_two = root / "checkout-two"
            for checkout in (checkout_one, checkout_two):
                for relative in ("one/service.py", "two/service.py"):
                    path = checkout / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("def service():\n    return 1\n")
            external = root / "external-cache"
            with mock.patch.dict(os.environ, {"NANOCLAW_GRAPHIFY_SEQUENTIAL": "1"}):
                with self.assertRaises(LookupReached):
                    namespace["extract"](
                        [checkout_one / "one/service.py", checkout_one / "two/service.py"],
                        cache_root=external,
                        root=checkout_one,
                        parallel=False,
                        max_workers=1,
                    )
            self.assertEqual(captured[0][1:], (checkout_one, external.resolve()))
            with mock.patch.dict(os.environ, {"NANOCLAW_GRAPHIFY_SEQUENTIAL": "1"}):
                with self.assertRaisesRegex(ValueError, "escapes explicit root"):
                    namespace["extract"](
                        [checkout_one / "one/service.py"],
                        cache_root=external,
                        root=checkout_two,
                        parallel=False,
                        max_workers=1,
                    )

            # Exercise the pinned upstream cache implementation: identical content
            # at duplicate basenames receives distinct relative-path keys, and
            # the same external cache re-anchors cleanly in another checkout.
            package = types.ModuleType("graphify")
            package.__path__ = []
            paths_module = types.ModuleType("graphify.paths")
            paths_module.GRAPHIFY_OUT = "graphify-out"
            cache_module = types.ModuleType("graphify.cache")
            cache_module.__package__ = "graphify"
            with mock.patch.dict(sys.modules, {
                "graphify": package,
                "graphify.paths": paths_module,
                "graphify.cache": cache_module,
            }):
                exec(compile(show("graphify/cache.py"), "graphify/cache.py", "exec"), cache_module.__dict__)
                cache_module._EXTRACTOR_VERSION = VERSION
                for relative in ("one/service.py", "two/service.py"):
                    source = checkout_one / relative
                    payload = {
                        "nodes": [{"id": relative, "source_file": str(source)}],
                        "edges": [],
                    }
                    cache_module.save_cached(source, payload, checkout_one, cache_root=external)
                entries = sorted((external / f"graphify-out/cache/ast/v{VERSION}").glob("*.json"))
                self.assertEqual(len(entries), 2)
                stored_sources = sorted(
                    json.loads(entry.read_text())["nodes"][0]["source_file"] for entry in entries
                )
                self.assertEqual(stored_sources, ["one/service.py", "two/service.py"])
                loaded_sources = []
                for relative in ("one/service.py", "two/service.py"):
                    loaded = cache_module.load_cached(
                        checkout_two / relative, checkout_two, cache_root=external
                    )
                    self.assertIsNotNone(loaded)
                    loaded_sources.append(loaded["nodes"][0]["source_file"])
                self.assertEqual(
                    sorted(loaded_sources),
                    sorted(str(checkout_two / relative) for relative in ("one/service.py", "two/service.py")),
                )

    def test_patched_typescript_type_value_namespaces_are_order_independent(self):
        image = os.environ.get("NANOCLAW_GRAPHIFY_TEST_IMAGE")
        if not image:
            self.skipTest("set NANOCLAW_GRAPHIFY_TEST_IMAGE to exercise the installed pinned image")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            upstream = root / "upstream"
            fixture = root / "fixture"
            upstream.mkdir()
            fixture.mkdir()
            self._materialize(upstream)
            subprocess.run(["git", "apply", str(PATCH)], cwd=upstream, check=True)
            (fixture / "collisions.ts").write_text(
                """\
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
""",
                encoding="utf-8",
            )
            (fixture / "consumer.ts").write_text(
                """\
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
""",
                encoding="utf-8",
            )
            probe = root / "probe.py"
            probe.write_text(
                """\
from pathlib import Path
import json
from graphify.extract import extract

root = Path('/fixture')
def run(cache):
    result = extract(sorted(root.glob('*.ts')), cache_root=Path(cache), root=root, parallel=False, max_workers=1)
    return json.loads(json.dumps(result, sort_keys=True, separators=(',', ':')))
first = run('/tmp/first')
second = run('/tmp/second')
assert first == second
ids = [node['id'] for node in first['nodes']]
assert len(ids) == len(set(ids))
nodes = {(node.get('source_file'), node.get('label')): node['id'] for node in first['nodes']}
type_names = ['Foo', 'Bar', 'WriteMessageOut', 'AuthMe', 'StreamGroups', 'VerbVerdict', 'UpsertSupportThread']
function_names = ['Foo', 'Bar', 'writeMessageOut', 'authMe', 'streamGroups', 'verbVerdict', 'upsertSupportThread']
type_ids = {nodes[('collisions.ts', name)] for name in type_names}
function_ids = {nodes[('collisions.ts', name + '()')] for name in function_names}
assert len(type_ids) == 7 and len(function_ids) == 7 and type_ids.isdisjoint(function_ids)
calls = {edge['target'] for edge in first['edges'] if edge.get('relation') == 'calls' and edge.get('source_file') == 'consumer.ts'}
references = {edge['target'] for edge in first['edges'] if edge.get('relation') == 'references' and edge.get('source_file') == 'consumer.ts'}
imports = {edge['target'] for edge in first['edges'] if edge.get('relation') == 'imports' and edge.get('source_file') == 'consumer.ts'}
assert function_ids <= calls
assert type_ids <= references
assert type_ids | function_ids <= imports
print(json.dumps({'nodes': len(first['nodes']), 'edges': len(first['edges']), 'types': sorted(type_ids), 'functions': sorted(function_ids)}, sort_keys=True))
""",
                encoding="utf-8",
            )
            command = [
                "docker", "run", "--rm", "--network", "none",
                "--entrypoint", "/opt/graphify/bin/python",
                "-v", f"{fixture}:/fixture:ro",
                "-v", f"{probe}:/probe.py:ro",
                "-v", f"{upstream / 'graphify/extract.py'}:/opt/graphify/lib/python3.11/site-packages/graphify/extract.py:ro",
                "-v", f"{upstream / 'graphify/extractors/engine.py'}:/opt/graphify/lib/python3.11/site-packages/graphify/extractors/engine.py:ro",
                "-v", f"{upstream / 'graphify/extractors/resolution.py'}:/opt/graphify/lib/python3.11/site-packages/graphify/extractors/resolution.py:ro",
                image, "/probe.py",
            ]
            result = subprocess.run(command, text=True, capture_output=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertEqual(len(summary["types"]), 7)
            self.assertEqual(len(summary["functions"]), 7)


if __name__ == "__main__":
    unittest.main()
