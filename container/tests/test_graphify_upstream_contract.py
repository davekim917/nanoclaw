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
TAG = "v0.9.16"
PATCH = Path(__file__).parents[1] / "graphify-v0.9.16-nanoclaw.patch"
GATEWAY = Path(__file__).parents[1] / "graphify-gateway.py"

PINNED_SHA256 = {
    "graphify/detect.py": "d8ef6da01605a1a561c0a2ce0f7b118336eb78ad230fa300927675fef9ea0638",
    "graphify/extract.py": "6773dfb69a70a74ee951fd93f4819c77131a3a78a36bb7e90888f821480cd8d5",
    "graphify/build.py": "b17307b91523651d67297b34d32243592c76058c31dc6cbdb70b108ef94e249c",
    "graphify/cache.py": "aa4642f85cc9e8db04d55f07d97eb8c3e820999c5921751c822c7f973d908fcb",
    "graphify/extractors/base.py": "022d2a0466f9dead9d98ae832e2d04afff21a1e6936fc5397b571c74613b2ba2",
    "graphify/extractors/engine.py": "858b4d6d0b7f864c3358efb0bc1d085800973cf6a7bed87817ab07e4ed865697",
    "graphify/extractors/models.py": "6f4c1180bb4eff19a3df24742d6f686e6c787d51f05f702b5e2f86af4dd550f9",
    "graphify/extractors/resolution.py": "75031e42090994a75b6ac9abc8ca5baf102de62184df0df016c1731da9b460db",
    "graphify/extractors/json_config.py": "d15ea6d9b48cc71e73615c44c72808562ad4a1dbc82d5a340e3ad0c2fb4fc945",
    "graphify/extractors/fortran.py": "8caf869d542e5c1fbd491ed35cca07d1f8505386083a47ef8dfa87482c83cf75",
    "graphify/export.py": "5ad339b97c3954ab26cab97322741215e27b6b3885138c6fa36b1057ac2d73ce",
    "graphify/manifest_ingest.py": "1f79a52f3c7f7a47d3a5006204bc00310c52d72c0b021200d9d5c477cbdc7f7f",
    "graphify/cli.py": "94bb40726b283145aec3f550e5e815270c2dfbef03393224b08a98b71244a6cc",
    "graphify/mcp_ingest.py": "7553845a7cae7c310803bf37d992b695b27d21e1b827c1c33dbed2b15971be61",
}

PINNED_DISPATCH = frozenset({
    '.py', '.js', '.jsx', '.mjs', '.ts', '.tsx', '.mts', '.cts', '.go', '.rs',
    '.java', '.groovy', '.gradle', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp',
    '.cu', '.cuh', '.metal', '.rb', '.rake', '.cs', '.kt', '.kts', '.scala',
    '.php', '.swift', '.lua', '.luau', '.toc', '.zig', '.ps1', '.psm1', '.psd1',
    '.ex', '.exs', '.m', '.mm', '.jl', '.f', '.F', '.f90', '.F90', '.f95',
    '.F95', '.f03', '.F03', '.f08', '.F08', '.vue', '.svelte', '.astro', '.dart',
    '.v', '.sv', '.svh', '.sql', '.md', '.mdx', '.qmd', '.pas', '.pp', '.dpr',
    '.dpk', '.lpr', '.inc', '.dfm', '.lfm', '.lpk', '.sh', '.bash', '.json',
    '.tf', '.tfvars', '.hcl', '.dm', '.dme', '.dmi', '.dmm', '.dmf', '.sln',
    '.slnx', '.csproj', '.fsproj', '.vbproj', '.xaml', '.razor', '.cshtml',
    '.cls', '.trigger',
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

    def test_patch_applies_exactly_once_to_v0916(self):
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

    def test_sequential_patch_removes_required_task_creation(self):
        text = PATCH.read_text(encoding="utf-8")
        self.assertEqual(text.count("NANOCLAW_GRAPHIFY_SEQUENTIAL"), 2)
        self.assertIn('parallel = False', text)
        self.assertIn('raw = map(_stat_and_hash, all_files)', text)
        self.assertIn('-    if cache_root is not None:', text)
        self.assertIn('+    source_root: Path | None = None,', text)
        self.assertIn('+    if source_root is not None:', text)
        self.assertIn('source path escapes explicit source_root', text)
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
        self.assertIn("h.update(rel.as_posix().lower().encode())", cache)
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
                ["source_root", "parallel", "max_workers"],
            )

            # Execute the exact patched function until its first cache lookup.
            # This proves the NanoClaw-only source anchor remains separate from
            # the external cache location and is part of the pinned signature.
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
                        source_root=checkout_one,
                        parallel=False,
                        max_workers=1,
                    )
            self.assertEqual(captured[0][1:], (checkout_one, external.resolve()))
            with mock.patch.dict(os.environ, {"NANOCLAW_GRAPHIFY_SEQUENTIAL": "1"}):
                with self.assertRaisesRegex(ValueError, "escapes explicit source_root"):
                    namespace["extract"](
                        [checkout_one / "one/service.py"],
                        cache_root=external,
                        source_root=checkout_two,
                        parallel=False,
                        max_workers=1,
                    )

            # Exercise v0.9.16's real cache implementation: identical content
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
                cache_module._EXTRACTOR_VERSION = "0.9.16"
                for relative in ("one/service.py", "two/service.py"):
                    source = checkout_one / relative
                    payload = {
                        "nodes": [{"id": relative, "source_file": str(source)}],
                        "edges": [],
                    }
                    cache_module.save_cached(source, payload, checkout_one, cache_root=external)
                entries = sorted((external / "graphify-out/cache/ast/v0.9.16").glob("*.json"))
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
    result = extract(sorted(root.glob('*.ts')), cache_root=Path(cache), source_root=root, parallel=False, max_workers=1)
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
