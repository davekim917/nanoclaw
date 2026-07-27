from __future__ import annotations

import contextlib
import errno
import hashlib
import importlib.util
import io
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import tracemalloc
from types import SimpleNamespace
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "graphify-gateway.py"


def load_gateway():
    spec = importlib.util.spec_from_file_location("graphify_gateway", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.gw = load_gateway()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "worktrees"
        self.repo = self.root / "demo"
        self.repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        self.runtime = Path(self.tmp.name) / "run"
        self.cache = Path(self.tmp.name) / "cache"
        self.stage = Path(self.tmp.name) / "stage"
        self.constants = mock.patch.multiple(
            self.gw,
            WORKTREE_ROOT=self.root,
            RUNTIME_DIR=self.runtime,
            CACHE_BASE=self.cache,
            SOURCE_STAGE_ROOT=self.stage,
            WORKER_LOCK=self.runtime / "worker.lock",
        )
        self.constants.start()
        self._validate_runtime_topology = getattr(
            self.gw, "validate_runtime_topology", None
        )
        self.topology = mock.patch.object(
            self.gw, "validate_runtime_topology", create=True
        )
        self.topology.start()

    def tearDown(self):
        self.topology.stop()
        self.constants.stop()
        self.tmp.cleanup()

    def _write_candidate(self, descriptor):
        output = Path(descriptor["output_root"])
        output.mkdir(parents=True, exist_ok=True)
        files = descriptor["files"]
        graph = {
            "nodes": [
                {"id": item["path"], "label": item["path"], "source_file": item["path"]}
                for item in files
            ],
            "links": [],
        }
        graph_bytes = json.dumps(graph, sort_keys=True, separators=(",", ":")).encode()
        manifest_bytes = json.dumps(
            {item["path"]: item["md5"] for item in files},
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        status = {
            "detected": [item["path"] for item in files],
            "applicable": [item["path"] for item in files],
            "contributed": [item["path"] for item in files],
            "intentional_exclusions": [],
            "unsupported": {},
            "failed": {},
            "graph_sha256": hashlib.sha256(graph_bytes).hexdigest(),
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "graph_bytes": len(graph_bytes),
        }
        (output / "graph.json").write_bytes(graph_bytes)
        (output / "manifest.json").write_bytes(manifest_bytes)
        (output / "status.json").write_text(
            json.dumps(status, sort_keys=True, separators=(",", ":")), encoding="utf-8"
        )
        shutil.rmtree(output / "graphify-out", ignore_errors=True)

    def _worker_fake(self, events, repo=None, event_file=None, extract_delay=0.0):
        def invoke(descriptor, _deadline):
            operation = descriptor["operation"]
            events.append(operation)
            if event_file is not None:
                fd = os.open(event_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                try:
                    os.write(fd, operation[0].upper().encode())
                finally:
                    os.close(fd)
            if operation == "extract":
                output = Path(descriptor["output_root"])
                self.assertTrue(output.is_relative_to(self.stage))
                if repo is not None:
                    self.assertFalse((repo.cache_root / "stage").exists())
                if extract_delay:
                    time.sleep(extract_delay)
                self._write_candidate(descriptor)
                return 0, "", "", {"duration_ms": 1}
            return 0, "QUERY\n", "", {"duration_ms": 1}
        return invoke

    @staticmethod
    def _proxy_result(
        returncode=0,
        stdout="",
        stderr="",
        *,
        unavailable=False,
        timed_out=False,
        output_exceeded=False,
    ):
        return SimpleNamespace(
            returncode=returncode,
            stdout=stdout,
            stderr=stderr,
            unavailable=unavailable,
            timed_out=timed_out,
            output_exceeded=output_exceeded,
        )

    def test_workgroup_query_proxies_to_ncl_from_any_cwd(self):
        self.assertEqual(
            self.gw._ncl_argv(self.gw.QueryCommand("query", ("retention decision",))),
            [
                str(self.gw.NCL_BINARY),
                "graphify",
                "query",
                "--query",
                "retention decision",
            ],
        )
        self.assertEqual(
            self.gw._ncl_argv(self.gw.QueryCommand("path", ("decision", "report"))),
            [
                str(self.gw.NCL_BINARY),
                "graphify",
                "path",
                "--from",
                "decision",
                "--to",
                "report",
            ],
        )
        self.assertEqual(
            self.gw._ncl_argv(self.gw.QueryCommand("explain", ("customer_ltv",))),
            [
                str(self.gw.NCL_BINARY),
                "graphify",
                "explain",
                "--node",
                "customer_ltv",
            ],
        )
        self.assertEqual(
            self.gw._ncl_argv(self.gw.QueryCommand("affected", ("authorize",))),
            [
                str(self.gw.NCL_BINARY),
                "graphify",
                "affected",
                "--node",
                "authorize",
            ],
        )
        outside = Path(self.tmp.name) / "knowledge-work"
        outside.mkdir()
        result = self._proxy_result(stdout="workgroup result\n")
        previous = Path.cwd()
        try:
            os.chdir(outside)
            with mock.patch.object(
                self.gw, "_invoke_ncl", return_value=result, create=True
            ) as invoke, mock.patch.object(
                self.gw,
                "resolve_managed_repo",
                side_effect=AssertionError("worktree fallback should not run"),
            ), contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(self.gw.main(["query", "retention decision"]), 0)
        finally:
            os.chdir(previous)

        invoke.assert_called_once_with(
            self.gw.QueryCommand("query", ("retention decision",))
        )
        self.assertEqual(stdout.getvalue(), "workgroup result\n")

    def test_managed_worktree_uses_code_only_fallback_only_when_daemon_unavailable(self):
        (self.repo / "a.py").write_text("value = 1\n")
        unavailable = self._proxy_result(
            returncode=2,
            stderr="graphify daemon unavailable\n",
            unavailable=True,
        )
        with mock.patch.object(
            self.gw, "_invoke_ncl", return_value=unavailable, create=True
        ), mock.patch.object(
            self.gw, "refresh_index", return_value=0
        ) as refresh, contextlib.redirect_stderr(io.StringIO()) as stderr:
            previous = Path.cwd()
            try:
                os.chdir(self.repo)
                self.assertEqual(self.gw.main(["query", "value"]), 0)
            finally:
                os.chdir(previous)

        refresh.assert_called_once()
        self.assertEqual(
            stderr.getvalue().splitlines()[0],
            "graphify: workgroup daemon unavailable; using code-only managed-worktree fallback.",
        )

    def test_forbidden_response_never_falls_back(self):
        forbidden = self._proxy_result(
            returncode=3,
            stderr="forbidden: caller cannot access this workgroup\n",
        )
        with mock.patch.object(
            self.gw, "_invoke_ncl", return_value=forbidden, create=True
        ), mock.patch.object(
            self.gw, "resolve_managed_repo"
        ) as resolve, mock.patch.object(
            self.gw, "refresh_index"
        ) as refresh, contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(
            io.StringIO()
        ) as stderr:
            self.assertEqual(self.gw.main(["query", "private decision"]), 3)

        resolve.assert_not_called()
        refresh.assert_not_called()
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(
            stderr.getvalue(), "forbidden: caller cannot access this workgroup\n"
        )

    def test_status_is_daemon_only(self):
        unavailable = self._proxy_result(
            returncode=2,
            stderr="graphify daemon unavailable\n",
            unavailable=True,
        )
        with mock.patch.object(
            self.gw, "_invoke_ncl", return_value=unavailable, create=True
        ) as invoke, mock.patch.object(
            self.gw, "resolve_managed_repo"
        ) as resolve, mock.patch.object(
            self.gw, "refresh_index"
        ) as refresh, contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(self.gw.main(["status"]), 2)

        invoke.assert_called_once_with(self.gw.QueryCommand("status"))
        resolve.assert_not_called()
        refresh.assert_not_called()
        self.assertEqual(stderr.getvalue(), "graphify daemon unavailable\n")

    def test_proxy_has_bounded_output_and_timeout(self):
        output_script = "import os; os.write(1, b'x' * 65536)"
        with mock.patch.object(
            self.gw,
            "_ncl_argv",
            return_value=[sys.executable, "-c", output_script],
            create=True,
        ), mock.patch.object(
            self.gw, "MAX_PROXY_OUTPUT_BYTES", 1024, create=True
        ):
            result = self.gw._invoke_ncl(self.gw.QueryCommand("query", ("x",)))
        self.assertTrue(result.output_exceeded)
        self.assertLessEqual(
            len(result.stdout.encode()) + len(result.stderr.encode()), 1024
        )

        timeout_script = "import time; time.sleep(30)"
        started = time.monotonic()
        with mock.patch.object(
            self.gw,
            "_ncl_argv",
            return_value=[sys.executable, "-c", timeout_script],
            create=True,
        ), mock.patch.object(
            self.gw, "NCL_TIMEOUT_SECONDS", 0.08, create=True
        ):
            result = self.gw._invoke_ncl(self.gw.QueryCommand("query", ("x",)))
        self.assertTrue(result.timed_out)
        self.assertTrue(result.unavailable)
        self.assertLess(time.monotonic() - started, 1.0)

    def test_proxy_classifies_missing_runtime_mounted_ncl_source_as_unavailable(self):
        self.assertTrue(
            self.gw._response_is_unavailable(
                1,
                "",
                'error: Module not found "/app/src/cli/ncl.ts"\n',
            )
        )
        self.assertFalse(
            self.gw._response_is_unavailable(
                3,
                "",
                'forbidden: Module not found "/app/src/cli/ncl.ts"\n',
            )
        )

    def test_help_and_version_remain_side_effect_free(self):
        for argv in (["help"], ["--help"], ["version"], ["--version"]):
            with self.subTest(argv=argv), mock.patch.object(
                self.gw,
                "_invoke_ncl",
                side_effect=AssertionError("ncl touched"),
                create=True,
            ) as invoke, mock.patch.object(
                self.gw,
                "resolve_managed_repo",
                side_effect=AssertionError("repository touched"),
            ), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(self.gw.main(argv), 0)
            invoke.assert_not_called()

    def test_public_cli_rejects_workgroup_and_path_overrides(self):
        cases = (
            ["query", "needle", "--workgroup", "example-retail"],
            ["query", "needle", "--workgroup=example-retail"],
            ["query", "needle", "--path", "/workspace/group"],
            ["query", "needle", "--path=/workspace/group"],
        )
        for argv in cases:
            with self.subTest(argv=argv), self.assertRaisesRegex(
                self.gw.PolicyError, "workgroup/path overrides are forbidden"
            ):
                self.gw.parse_public_command(argv)

    def test_skill_describes_automatic_knowledge_graph_and_thread_overlay(self):
        skill = (
            Path(__file__).parents[1] / "skills" / "graphify" / "SKILL.md"
        ).read_text(encoding="utf-8")
        for phrase in (
            "automatic workgroup knowledge graph",
            "canonical clones",
            "conversations",
            "thread-local worktree overlay",
            "prior decisions",
            "cross-artifact lineage",
            ".graphifyignore",
            "rare opt-out",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, skill)

    def test_gateway_referenced_css_asset_is_hashed_staged_and_freshness_bound(self):
        source = self.repo / "src/main.tsx"
        asset = self.repo / "src/styles.css"
        unused = self.repo / "src/unused.css"
        source.parent.mkdir(parents=True)
        source.write_text("import './styles.css';\n")
        asset.write_text("body { color: black; }\n")
        unused.write_text("body { color: red; }\n")
        repo = self.gw.resolve_managed_repo(self.repo)
        generation = self.gw.inventory_source(repo.root)
        self.assertEqual([item.path for item in generation.assets], ["src/styles.css"])
        self.assertEqual(generation.asset_total_bytes, asset.stat().st_size)
        original_fingerprint = generation.fingerprint
        events = []

        def invoke(descriptor, _deadline):
            events.append(descriptor["operation"])
            if descriptor["operation"] == "query":
                return 0, "CSS\n", "", {}
            self.assertEqual(descriptor["assets"], [self.gw.asdict(generation.assets[0])])
            staged = Path(descriptor["source_root"])
            self.assertEqual((staged / "src/styles.css").read_text(), asset.read_text())
            self.assertFalse((staged / "src/unused.css").exists())
            self._write_candidate(descriptor)
            return 0, "", "", {}

        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw, "_invoke_worker", side_effect=invoke
        ), contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(
                self.gw.refresh_index(repo, generation, self.gw.QueryCommand("query", ("main",))),
                0,
            )
        self.assertEqual(events, ["extract", "query"])
        self.assertEqual(stdout.getvalue(), "CSS\n")
        state = self.gw._load_state(repo.cache_root / "live")
        self.assertEqual(state.assets, generation.assets)

        asset.write_text("body { color: blue; }\n")
        changed = self.gw.inventory_source(repo.root)
        self.assertNotEqual(changed.fingerprint, original_fingerprint)
        self.assertNotEqual(changed.assets[0].sha256, generation.assets[0].sha256)

    def test_gateway_referenced_css_asset_tamper_and_oversize_fail_closed(self):
        source = self.repo / "src/main.tsx"
        asset = self.repo / "src/styles.css"
        source.parent.mkdir(parents=True)
        source.write_text("import './styles.css';\n")
        asset.write_text("body {}\n")
        generation = self.gw.inventory_source(self.repo)
        asset.write_text("body { color: red; }\n")
        with self.assertRaises(self.gw.SourceChanged):
            self.gw.capture_source(self.repo, self.stage / "snapshot", generation)

        asset.write_bytes(b"x" * (self.gw.MAX_FILE_BYTES + 1))
        with self.assertRaisesRegex(self.gw.PolicyError, "exceeds 5 MiB"):
            self.gw.inventory_source(self.repo)

        asset.unlink()
        absent = self.gw.inventory_source(self.repo)
        self.assertEqual(absent.assets, ())

    def test_gateway_skill_markers_are_owned_hashed_and_not_standalone(self):
        owned = self.repo / ".claude/skills/demo"
        owned_code = owned / "resources/template.ts"
        owned_code.parent.mkdir(parents=True)
        owned_code.write_text("import './missing';\n")
        owned_marker = owned / "SKILL.md"
        owned_marker.write_text("# demo\n")

        pair = self.repo / "setup/pair-chat.ts"
        pair.parent.mkdir()
        pair.write_text("import '../src/channels/chat-pairing.js';\n")
        pair_marker = self.repo / ".claude/skills/add-chat/SKILL.md"
        pair_marker.parent.mkdir(parents=True)
        pair_marker.write_text("# add chat\n")

        standalone = self.repo / ".claude/skills/standalone/SKILL.md"
        standalone.parent.mkdir(parents=True)
        standalone.write_text("# standalone\n")
        wrong_owner = self.repo / ".claude/skills/add-other/SKILL.md"
        wrong_owner.parent.mkdir(parents=True)
        wrong_owner.write_text("# wrong owner\n")

        generation = self.gw.inventory_source(self.repo)
        self.assertEqual(
            [item.path for item in generation.assets],
            [
                ".claude/skills/add-chat/SKILL.md",
                ".claude/skills/demo/SKILL.md",
            ],
        )
        snapshot = self.stage / "skill-snapshot"
        self.gw.capture_source(self.repo, snapshot, generation)
        self.assertTrue((snapshot / ".claude/skills/demo/SKILL.md").is_file())
        self.assertTrue((snapshot / ".claude/skills/add-chat/SKILL.md").is_file())
        self.assertFalse((snapshot / ".claude/skills/standalone/SKILL.md").exists())
        self.assertFalse((snapshot / ".claude/skills/add-other/SKILL.md").exists())

        owned_marker.write_text("# tampered\n")
        with self.assertRaises(self.gw.SourceChanged):
            self.gw.capture_source(self.repo, self.stage / "tampered-skill", generation)

        owned_marker.unlink()
        without_owned_marker = self.gw.inventory_source(self.repo)
        self.assertNotIn(
            ".claude/skills/demo/SKILL.md",
            [item.path for item in without_owned_marker.assets],
        )

    def test_gateway_nested_project_markers_require_same_safe_prefix(self):
        nested_skill = self.repo / "repo/.claude/skills/demo/resources/template.ts"
        nested_skill.parent.mkdir(parents=True)
        nested_skill.write_text("import './missing';\n")
        nested_skill_marker = self.repo / "repo/.claude/skills/demo/SKILL.md"
        nested_skill_marker.write_text("# nested demo\n")

        nested_pair = self.repo / "repo/setup/pair-telegram.ts"
        nested_pair.parent.mkdir(parents=True)
        nested_pair.write_text(
            "import '../src/channels/telegram-pairing.js';\n"
        )
        nested_pair_marker = self.repo / "repo/.claude/skills/add-telegram/SKILL.md"
        nested_pair_marker.parent.mkdir(parents=True)
        nested_pair_marker.write_text("# nested telegram\n")

        wrong_skill_marker = self.repo / ".claude/skills/demo/SKILL.md"
        wrong_skill_marker.parent.mkdir(parents=True)
        wrong_skill_marker.write_text("# wrong-prefix demo\n")
        wrong_pair_marker = self.repo / ".claude/skills/add-telegram/SKILL.md"
        wrong_pair_marker.parent.mkdir(parents=True)
        wrong_pair_marker.write_text("# wrong-prefix telegram\n")

        generation = self.gw.inventory_source(self.repo)
        self.assertEqual(
            [item.path for item in generation.assets],
            [
                "repo/.claude/skills/add-telegram/SKILL.md",
                "repo/.claude/skills/demo/SKILL.md",
            ],
        )
        self.assertIsNone(
            self.gw._pairing_owner("repo/../setup/pair-telegram.ts")
        )
        self.assertIsNone(
            self.gw._skill_source_owner(
                "outer/.claude/skills/first/repo/.claude/skills/second/template.ts"
            )
        )
        bounded_prefix = "/".join(["project"] * 64)
        overlong_prefix = "/".join(["project"] * 65)
        self.assertIsNotNone(
            self.gw._pairing_owner(f"{bounded_prefix}/setup/pair-telegram.ts")
        )
        self.assertIsNone(
            self.gw._pairing_owner(f"{overlong_prefix}/setup/pair-telegram.ts")
        )

        nested_skill_marker.unlink()
        nested_pair_marker.unlink()
        wrong_prefix_only = self.gw.inventory_source(self.repo)
        self.assertEqual(wrong_prefix_only.assets, ())

    def test_gateway_initial_refresh_then_cached_query(self):
        # Approved D13/B2 persistent-cache mount contract. The setUp patch
        # replaces it below, so inspect the source-level default explicitly.
        self.assertIn('CACHE_BASE = Path("/workspace/.cache/graphify")', MODULE_PATH.read_text())
        (self.repo / "a.py").write_text("def a():\n    return 1\n")
        repo = self.gw.resolve_managed_repo(self.repo)
        generation = self.gw.inventory_source(repo.root)
        command = self.gw.QueryCommand("query", ("a",))
        events = []
        validations = []
        original_validate = self.gw.validate_candidate

        def observe_validation(path, expected):
            validations.append(Path(path))
            return original_validate(path, expected)

        original_bounded_copy = self.gw._bounded_copy_file

        def observe_bounded_copy(source, target, cap):
            self.assertFalse((self.stage / repo.cache_key / "source").exists())
            return original_bounded_copy(source, target, cap)

        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw, "_invoke_worker", side_effect=self._worker_fake(events, repo)
        ), mock.patch.object(
            self.gw, "validate_candidate", side_effect=observe_validation
        ), mock.patch.object(
            self.gw, "_bounded_copy_file", side_effect=observe_bounded_copy
        ) as bounded_copy, contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(self.gw.refresh_index(repo, generation, command), 0)
            self.assertEqual(self.gw.refresh_index(repo, generation, command), 0)

        self.assertEqual(events, ["extract", "query", "query"])
        self.assertEqual(stdout.getvalue(), "QUERY\nQUERY\n")
        self.assertTrue(self.gw._validate_live(repo.cache_root / "live"))
        self.assertEqual(
            self.gw._load_state(repo.cache_root / "live").fingerprint,
            generation.fingerprint,
        )
        tmpfs_candidate = self.stage / repo.cache_key / "candidate"
        persistent_candidate = repo.cache_root / "stage"
        tmpfs_index = next(i for i, path in enumerate(validations) if path == tmpfs_candidate)
        persistent_index = next(i for i, path in enumerate(validations) if path == persistent_candidate)
        self.assertLess(tmpfs_index, persistent_index)
        self.assertTrue(all(Path(call.args[1]).is_relative_to(persistent_candidate) for call in bounded_copy.call_args_list))
        self.assertFalse(persistent_candidate.exists())
        self.assertFalse((self.stage / repo.cache_key).exists())
        self.assertTrue(self.stage.is_dir())
        self.assertTrue((repo.cache_root / "lock").exists())
        self.assertEqual(
            [path.relative_to(self.runtime).as_posix() for path in self.runtime.rglob("*") if path.is_file()],
            ["worker.lock"],
        )

    def test_gateway_runtime_topology_requires_exact_mounts_and_bounded_tmpfs(self):
        self.assertIsNotNone(self._validate_runtime_topology)
        for path in (self.cache, self.runtime, self.stage):
            path.mkdir(parents=True, mode=0o700)
            path.chmod(0o700)
        mountinfo = Path(self.tmp.name) / "mountinfo"

        def mount_line(identifier, target, filesystem="ext4", options="rw"):
            return (
                f"{identifier} 1 0:{identifier} / {target} {options},relatime - "
                f"{filesystem} none rw\n"
            )

        valid = "".join(
            (
                mount_line(10, self.cache),
                mount_line(11, self.runtime),
                mount_line(12, self.stage, "tmpfs"),
            )
        )
        mountinfo.write_text(valid, encoding="utf-8")
        bounded = SimpleNamespace(f_frsize=4096, f_blocks=49152)

        with mock.patch.object(
            self.gw, "MOUNTINFO_PATH", mountinfo, create=True
        ), mock.patch.object(self.gw.os, "statvfs", return_value=bounded):
            self._validate_runtime_topology()

            cases = {
                "missing-cache": "".join(
                    (
                        mount_line(11, self.runtime),
                        mount_line(12, self.stage, "tmpfs"),
                    )
                ),
                "missing-runtime": "".join(
                    (
                        mount_line(10, self.cache),
                        mount_line(12, self.stage, "tmpfs"),
                    )
                ),
                "stage-not-tmpfs": "".join(
                    (
                        mount_line(10, self.cache),
                        mount_line(11, self.runtime),
                        mount_line(12, self.stage),
                    )
                ),
                "readonly-cache": "".join(
                    (
                        mount_line(10, self.cache, options="ro"),
                        mount_line(11, self.runtime),
                        mount_line(12, self.stage, "tmpfs"),
                    )
                ),
            }
            for name, contents in cases.items():
                with self.subTest(case=name):
                    mountinfo.write_text(contents, encoding="utf-8")
                    with self.assertRaises(self.gw.PolicyError):
                        self._validate_runtime_topology()

            mountinfo.write_text(valid, encoding="utf-8")
            oversized = SimpleNamespace(f_frsize=4096, f_blocks=49153)
            with mock.patch.object(self.gw.os, "statvfs", return_value=oversized):
                with self.assertRaisesRegex(self.gw.PolicyError, "192 MiB"):
                    self._validate_runtime_topology()

    def test_gateway_query_fails_before_repository_access_without_runtime_topology(self):
        self.gw.validate_runtime_topology.side_effect = self.gw.PolicyError(
            "required Graphify runtime topology is unavailable"
        )
        with mock.patch.object(
            self.gw,
            "resolve_managed_repo",
            side_effect=AssertionError("repository accessed before topology validation"),
        ) as resolve, mock.patch.object(
            self.gw, "inventory_source"
        ) as inventory, mock.patch.object(
            self.gw, "_invoke_worker"
        ) as worker, contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(
            io.StringIO()
        ) as stderr:
            self.assertEqual(self.gw.main(["query", "needle"]), 2)
        self.gw.validate_runtime_topology.assert_called_once_with()
        resolve.assert_not_called()
        inventory.assert_not_called()
        worker.assert_not_called()
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("required Graphify runtime topology", stderr.getvalue())

    def test_gateway_rejects_bypass_and_unmanaged_roots(self):
        for argv in (["extract"], ["update"], ["watch"], ["hooks"], ["mcp"],
                     ["query", "x", "--graph", "x"], ["query", "x", "--out", "x"],
                     ["query", "x", "--help"], ["path", "from", "to", "-h"]):
            with self.subTest(argv=argv), self.assertRaises(self.gw.PolicyError):
                self.gw.parse_public_command(argv)
        with mock.patch.dict(os.environ, {"GRAPHIFY_OUT": "/tmp/x"}):
            with self.assertRaises(self.gw.PolicyError):
                self.gw.parse_public_command(["query", "x"])
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        subprocess.run(["git", "init", "-q", str(outside)], check=True)
        with self.assertRaises(self.gw.PolicyError):
            self.gw.resolve_managed_repo(outside)
        secret_query = "DO_NOT_ECHO_QUERY_7f38"
        with mock.patch.object(
            self.gw, "resolve_managed_repo", side_effect=self.gw.PolicyError("not a managed worktree")
        ), contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(self.gw.main(["query", secret_query]), 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn(secret_query, stderr.getvalue())
        self.assertIn("inspect authoritative source directly and retry Graphify later", stderr.getvalue())
        self.assertIn("create or reuse a managed worktree", stderr.getvalue())

    def test_gateway_symlink_escape_fails_before_any_live_query(self):
        (self.repo / "a.py").write_text("x = 1\n")
        managed = self.gw.resolve_managed_repo(self.repo)
        generation = self.gw.inventory_source(self.repo)
        command = self.gw.QueryCommand("query", ("a",))
        baseline = []
        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw, "_invoke_worker", side_effect=self._worker_fake(baseline, managed)
        ), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.gw.refresh_index(managed, generation, command), 0)
        accepted = self.gw._load_state(managed.cache_root / "live")

        outside = Path(self.tmp.name) / "outside.py"
        outside.write_text("outside = True\n")
        outside_dir = Path(self.tmp.name) / "outside-dir"
        outside_dir.mkdir()
        (outside_dir / "nested.py").write_text("outside = True\n")
        cases = (
            ("outside-file", lambda link: link.symlink_to(outside)),
            ("broken-file", lambda link: link.symlink_to(Path(self.tmp.name) / "missing.py")),
            ("outside-directory", lambda link: link.symlink_to(outside_dir, target_is_directory=True)),
        )
        for name, create in cases:
            with self.subTest(case=name):
                link = self.repo / ("escape-dir" if "directory" in name else "escape.py")
                create(link)
                with mock.patch.object(self.gw, "resolve_managed_repo", return_value=managed), mock.patch.object(
                    self.gw, "_invoke_worker"
                ) as worker, contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
                    self.assertEqual(self.gw.main(["query", "a"]), 2)
                self.assertEqual(stdout.getvalue(), "")
                self.assertIn("symlinked source", stderr.getvalue())
                worker.assert_not_called()
                self.assertEqual(self.gw._load_state(managed.cache_root / "live"), accepted)
                link.unlink()

    def test_gateway_help_and_version_are_side_effect_free(self):
        help_forms = [["help"], ["--help"], ["-h"]]
        help_forms.extend(
            [command, flag]
            for command in ("query", "path", "explain", "affected", "status")
            for flag in ("--help", "-h")
        )
        for argv in [*help_forms, ["version"], ["--version"]]:
            with self.subTest(argv=argv), mock.patch.object(
                self.gw, "resolve_managed_repo", side_effect=AssertionError("git touched")
            ), mock.patch.object(
                self.gw, "inventory_source", side_effect=AssertionError("source touched")
            ), mock.patch.object(
                self.gw, "_invoke_worker", side_effect=AssertionError("worker touched")
            ), contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(self.gw.main(argv), 0)
                if argv != ["version"] and argv != ["--version"]:
                    self.assertIn("Usage: graphify COMMAND [ARGS]", stdout.getvalue())
        self.assertFalse(self.cache.exists())
        self.assertFalse(self.runtime.exists())
        self.assertFalse(self.stage.exists())
        self.gw.validate_runtime_topology.assert_not_called()

    def test_gateway_worker_requests_stay_private_and_support_near_4000_files(self):
        script = Path(self.tmp.name) / "request-reader.py"
        script.write_text(
            "import json,sys; p=sys.argv[1]; json.load(open(p)); print(p)\n",
            encoding="utf-8",
        )
        secret_query = "query-text-must-not-enter-shared-runtime"
        descriptor = {
            "operation": "query",
            "command": "query",
            "arguments": [secret_query],
            "graph": "/owned/graph.json",
        }
        files = [
            {
                "path": f"pkg/{index:04d}.py",
                "sha256": "a" * 64,
                "md5": "b" * 32,
                "bytes": 1,
                "graphify_hash": "c" * 64,
            }
            for index in range(3999)
        ]
        large_descriptor = {"operation": "contract", "files": files}
        encoded = json.dumps(large_descriptor, sort_keys=True, separators=(",", ":")).encode()
        self.assertGreater(len(encoded), self.gw.MAX_DIAGNOSTIC_BYTES)
        self.assertLess(len(encoded), self.gw.MAX_REQUEST_BYTES)

        with mock.patch.object(self.gw, "WORKER_PYTHON", Path(sys.executable)), mock.patch.object(
            self.gw, "WORKER_SCRIPT", script
        ):
            code, stdout, stderr, _telemetry = self.gw._invoke_worker(
                descriptor, time.monotonic() + 10
            )
            self.assertEqual(code, 0, stderr)
            request_path = Path(stdout.strip())
            self.assertTrue(request_path.is_relative_to(self.stage))
            self.assertFalse(request_path.is_relative_to(self.runtime))
            self.assertFalse(request_path.exists())
            code, _stdout, stderr, _telemetry = self.gw._invoke_worker(
                large_descriptor, time.monotonic() + 10
            )
            self.assertEqual(code, 0, stderr)

        runtime_content = b""
        if self.runtime.exists():
            runtime_content = b"".join(
                path.read_bytes() for path in self.runtime.rglob("*") if path.is_file()
            )
        self.assertNotIn(secret_query.encode(), runtime_content)
        self.assertFalse(any(self.stage.iterdir()))

    def test_gateway_cached_query_low_headroom_never_starts_worker(self):
        (self.repo / "a.py").write_text("x = 1\n")
        managed = self.gw.resolve_managed_repo(self.repo)
        generation = self.gw.inventory_source(self.repo)
        command = self.gw.QueryCommand("query", ("a",))
        events = []
        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw, "_invoke_worker", side_effect=self._worker_fake(events, managed)
        ), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.gw.refresh_index(managed, generation, command), 0)
        live = managed.cache_root / "live"
        accepted = self.gw._load_state(live)
        graph = (live / "graph.json").read_bytes()

        with mock.patch.object(
            self.gw, "enforce_memory_admission", side_effect=self.gw.AdmissionError("low headroom")
        ), mock.patch.object(self.gw, "_invoke_worker") as worker, contextlib.redirect_stdout(io.StringIO()) as stdout:
            with self.assertRaises(self.gw.AdmissionError):
                self.gw.refresh_index(managed, generation, command)
        worker.assert_not_called()
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(self.gw._load_state(live), accepted)
        self.assertEqual((live / "graph.json").read_bytes(), graph)

    def test_gateway_dirty_untracked_deleted_and_data_json_freshness(self):
        py = self.repo / "tracked.py"
        js = self.repo / "data.json"
        py.write_text("x=1\n")
        js.write_text('[{"datum": 1}]')
        one = self.gw.inventory_source(self.repo)
        py.write_text("x=2\n")
        two = self.gw.inventory_source(self.repo)
        self.assertNotEqual(one.fingerprint, two.fingerprint)
        py.unlink()
        three = self.gw.inventory_source(self.repo)
        self.assertNotEqual(two.fingerprint, three.fingerprint)
        self.assertEqual([f.path for f in three.files], ["data.json"])

    def test_gateway_aba_and_mutation_during_worker_wait(self):
        p = self.repo / "a.py"
        p.write_text("A")
        a = self.gw.inventory_source(self.repo)
        p.write_text("B")
        self.assertNotEqual(a, self.gw.inventory_source(self.repo))
        p.write_text("A")
        self.assertEqual(a, self.gw.inventory_source(self.repo))
        p.write_text("C")
        with self.assertRaises(self.gw.SourceChanged):
            self.gw.require_equal_inventory(a, self.gw.inventory_source(self.repo))
        p.write_text("A")
        managed = self.gw.resolve_managed_repo(self.repo)
        command = self.gw.QueryCommand("query", ("a",))
        events = []
        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw, "_invoke_worker", side_effect=self._worker_fake(events, managed)
        ), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.gw.refresh_index(managed, a, command), 0)

        context = multiprocessing.get_context("fork")

        def hold_then_mutate(lock_path, source_path, contents, ready, delay):
            with self.gw.deadline_lock(Path(lock_path), time.monotonic() + 5):
                ready.send("locked")
                time.sleep(delay)
                Path(source_path).write_text(contents)
            ready.close()

        # Source changes while the cached caller is blocked on the one global
        # worker slot. The old graph must not be queried; refresh rebases to B.
        worker_parent, worker_child = context.Pipe(duplex=False)
        worker_holder = context.Process(
            target=hold_then_mutate,
            args=(self.gw.WORKER_LOCK, p, "B", worker_child, 0.35),
        )
        worker_holder.start()
        self.assertEqual(worker_parent.recv(), "locked")
        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw, "_extract_once", return_value=17
        ) as extract:
            self.assertEqual(self.gw.refresh_index(managed, a, command), 17)
        worker_holder.join(3)
        self.assertEqual(worker_holder.exitcode, 0)
        extracted_generation = extract.call_args.args[1]
        self.assertEqual(extracted_generation, self.gw.inventory_source(self.repo))
        self.assertNotEqual(extracted_generation, a)
        self.assertEqual(events, ["extract", "query"])
        self.assertEqual(self.gw._TELEMETRY.get("post_wait_refresh"), 1)

        # Repeat at the per-repository cache lock. This is a real separate
        # process flock holder, not a sequential re-acquisition in one caller.
        b = self.gw.inventory_source(self.repo)
        cache_parent, cache_child = context.Pipe(duplex=False)
        cache_holder = context.Process(
            target=hold_then_mutate,
            args=(managed.cache_root / "lock", p, "C", cache_child, 0.15),
        )
        cache_holder.start()
        self.assertEqual(cache_parent.recv(), "locked")
        with mock.patch.object(self.gw, "_extract_once", return_value=23) as extract:
            self.assertEqual(self.gw.refresh_index(managed, b, command), 23)
        cache_holder.join(3)
        self.assertEqual(cache_holder.exitcode, 0)
        extracted_generation = extract.call_args.args[1]
        self.assertEqual(extracted_generation, self.gw.inventory_source(self.repo))
        self.assertNotEqual(extracted_generation, b)
        self.assertEqual(self.gw._TELEMETRY.get("cache_wait_refresh"), 1)

    def test_gateway_post_extract_and_alternating_mutations_retry(self):
        source = self.repo / "a.py"
        source.write_text("value = 'A'\n")
        managed = self.gw.resolve_managed_repo(self.repo)
        command = self.gw.QueryCommand("query", ("a",))
        generation_a = self.gw.inventory_source(self.repo)
        baseline_events = []
        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw, "_invoke_worker", side_effect=self._worker_fake(baseline_events, managed)
        ), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.gw.refresh_index(managed, generation_a, command), 0)
        live = managed.cache_root / "live"
        accepted_a = self.gw._load_state(live)

        source.write_text("value = 'B'\n")
        generation_b = self.gw.inventory_source(self.repo)
        extraction_snapshots = []
        live_during_failed_attempts = []
        operations = []
        queried_states = []

        def racing_worker(descriptor, _deadline):
            operation = descriptor["operation"]
            operations.append(operation)
            if operation == "extract":
                snapshot = (Path(descriptor["source_root"]) / "a.py").read_text()
                extraction_snapshots.append(snapshot)
                live_during_failed_attempts.append(self.gw._load_state(live))
                self._write_candidate(descriptor)
                # B -> C -> B is an ABA sequence. Each valid-but-stale
                # candidate must be discarded before persistent promotion.
                if len(extraction_snapshots) == 1:
                    source.write_text("value = 'C'\n")
                elif len(extraction_snapshots) == 2:
                    source.write_text("value = 'B'\n")
                return 0, "", "", {}
            queried_states.append(self.gw._load_state(Path(descriptor["graph"]).parent))
            return 0, "ACCEPTED\n", "", {}

        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw, "_invoke_worker", side_effect=racing_worker
        ), contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(self.gw.refresh_index(managed, generation_b, command), 0)

        self.assertEqual(
            extraction_snapshots,
            ["value = 'B'\n", "value = 'C'\n", "value = 'B'\n"],
        )
        self.assertEqual(operations, ["extract", "extract", "extract", "query"])
        self.assertEqual(live_during_failed_attempts, [accepted_a, accepted_a, accepted_a])
        accepted_b = self.gw._load_state(live)
        self.assertEqual(queried_states, [accepted_b])
        self.assertEqual(accepted_b.fingerprint, generation_b.fingerprint)
        self.assertEqual(accepted_b.fingerprint, self.gw.inventory_source(self.repo).fingerprint)
        self.assertEqual(stdout.getvalue(), "ACCEPTED\n")
        self.assertEqual(self.gw._TELEMETRY.get("retry"), 2)

    def test_gateway_concurrent_same_worktree_callers_coalesce(self):
        (self.repo / "a.py").write_text("x = 1\n")
        managed = self.gw.resolve_managed_repo(self.repo)
        generation = self.gw.inventory_source(self.repo)
        command = self.gw.QueryCommand("query", ("a",))
        event_file = Path(self.tmp.name) / "worker-events"
        context = multiprocessing.get_context("fork")

        def caller():
            with contextlib.redirect_stdout(io.StringIO()):
                result = self.gw.refresh_index(managed, generation, command)
            if result != 0:
                raise AssertionError(result)

        events = []
        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw,
            "_invoke_worker",
            side_effect=self._worker_fake(
                events, managed, event_file=str(event_file), extract_delay=0.2
            ),
        ):
            callers = [context.Process(target=caller) for _ in range(2)]
            for process in callers:
                process.start()
            for process in callers:
                process.join(5)

        self.assertEqual([process.exitcode for process in callers], [0, 0])
        operations = event_file.read_text(encoding="ascii")
        self.assertEqual(operations.count("E"), 1)
        self.assertEqual(operations.count("Q"), 2)
        self.assertTrue(self.gw._validate_live(managed.cache_root / "live"))

    def test_gateway_mixed_media_and_oversized_corpus_failures(self):
        self.assertEqual(self.gw.MAX_FILE_BYTES, 5 * 1024 * 1024)
        self.assertEqual(self.gw.MAX_CODE_FILES, 4000)
        self.assertEqual(self.gw.MAX_INPUT_BYTES, 64 * 1024 * 1024)
        (self.repo / "ok.py").write_text("x=1")
        (self.repo / "image.png").write_bytes(b"not indexed")
        self.assertEqual(len(self.gw.inventory_source(self.repo).files), 1)
        (self.repo / "huge.py").write_bytes(b"x" * (self.gw.MAX_FILE_BYTES + 1))
        with mock.patch.object(self.gw, "_invoke_worker") as worker:
            with self.assertRaises(self.gw.PolicyError):
                self.gw.inventory_source(self.repo)
        worker.assert_not_called()
        (self.repo / "huge.py").unlink()

        for index in range(3):
            (self.repo / f"count-{index}.py").write_text("x")
        with mock.patch.object(self.gw, "MAX_CODE_FILES", 2), mock.patch.object(
            self.gw, "_invoke_worker"
        ) as worker:
            with self.assertRaisesRegex(self.gw.PolicyError, "4000 code files"):
                self.gw.inventory_source(self.repo)
        worker.assert_not_called()
        for index in range(3):
            (self.repo / f"count-{index}.py").unlink()

        (self.repo / "aggregate.py").write_text("12345678")
        with mock.patch.object(self.gw, "MAX_INPUT_BYTES", 8), mock.patch.object(
            self.gw, "_invoke_worker"
        ) as worker:
            with self.assertRaisesRegex(self.gw.PolicyError, "64 MiB"):
                self.gw.inventory_source(self.repo)
        worker.assert_not_called()

    def test_gateway_case_alias_cache_seed_filter(self):
        live = self.cache / "live"
        old = live / "ast"
        old.mkdir(parents=True)
        graphify_hash = "a" * 64
        good = old / f"{graphify_hash}.json"
        good.write_bytes(b"{}")

        def generation(*paths):
            files = tuple(
                self.gw.SourceFile(path, str(index + 1) * 64, "b" * 32, 2, graphify_hash)
                for index, path in enumerate(paths)
            )
            return self.gw.SourceGeneration(files, 2 * len(files), "f" * 64)

        prior = generation("Foo.py")
        dest = Path(self.tmp.name) / "seed"
        with mock.patch.object(self.gw, "_validate_live", return_value=True), mock.patch.object(
            self.gw, "_load_state", return_value=self.gw.AcceptedSourceState.from_generation(prior)
        ), mock.patch.object(self.gw.json, "loads", side_effect=AssertionError("AST payload parsed")):
            copied = self.gw.seed_ast_cache(live, dest, prior)
        self.assertEqual(copied, good.stat().st_size)
        self.assertTrue((dest / good.name).exists())

        # Exact-case continuity is required even when Graphify's lower-cased
        # cache key happens to collide.
        with mock.patch.object(self.gw, "_validate_live", return_value=True), mock.patch.object(
            self.gw, "_load_state", return_value=self.gw.AcceptedSourceState.from_generation(prior)
        ):
            self.assertEqual(self.gw.seed_ast_cache(live, dest, generation("foo.py")), 0)

        prior_collision = generation("Foo.py", "foo.py")
        with mock.patch.object(self.gw, "_validate_live", return_value=True), mock.patch.object(
            self.gw, "_load_state", return_value=self.gw.AcceptedSourceState.from_generation(prior_collision)
        ):
            self.assertEqual(self.gw.seed_ast_cache(live, dest, generation("Foo.py")), 0)
        with mock.patch.object(self.gw, "_validate_live", return_value=True), mock.patch.object(
            self.gw, "_load_state", return_value=self.gw.AcceptedSourceState.from_generation(prior)
        ):
            self.assertEqual(self.gw.seed_ast_cache(live, dest, generation("Foo.py", "foo.py")), 0)

        # A multi-megabyte entry is copied in bounded chunks without json.loads
        # or a whole-entry allocation in the supervisor.
        good.write_bytes(b"x" * (8 * 1024 * 1024))
        tracemalloc.start()
        with mock.patch.object(self.gw, "_validate_live", return_value=True), mock.patch.object(
            self.gw, "_load_state", return_value=self.gw.AcceptedSourceState.from_generation(prior)
        ), mock.patch.object(self.gw.json, "loads", side_effect=AssertionError("AST payload parsed")):
            copied = self.gw.seed_ast_cache(live, dest, prior)
        _current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        self.assertEqual(copied, 8 * 1024 * 1024)
        self.assertLess(peak, 2 * 1024 * 1024)

    def test_gateway_failure_preserves_live_but_never_queries_it(self):
        source = self.repo / "a.py"
        source.write_text("old = 1\n")
        managed = self.gw.resolve_managed_repo(self.repo)
        old_generation = self.gw.inventory_source(self.repo)
        command = self.gw.QueryCommand("query", ("a",))
        initial_events = []
        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw, "_invoke_worker", side_effect=self._worker_fake(initial_events, managed)
        ), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.gw.refresh_index(managed, old_generation, command), 0)
        live = managed.cache_root / "live"
        old_state = self.gw._load_state(live)
        old_graph = (live / "graph.json").read_bytes()
        source.write_text("new = 2\n")
        new_generation = self.gw.inventory_source(self.repo)

        def invalid_worker(descriptor, _deadline):
            operations.append(descriptor["operation"])
            self._write_candidate(descriptor)
            (Path(descriptor["output_root"]) / "graph.json").write_text("{}")
            return 0, "", "", {}

        def raising_worker(exception):
            def invoke(descriptor, _deadline):
                operations.append(descriptor["operation"])
                raise exception
            return invoke

        real_replace = self.gw.os.replace
        persistent_stage = managed.cache_root / "stage"

        def fail_promotion(source_path, target_path):
            if Path(source_path) == persistent_stage and Path(target_path) == live:
                raise OSError(errno.ENOSPC, "simulated promotion ENOSPC")
            return real_replace(source_path, target_path)

        faults = (
            ("invalid", invalid_worker, None, None),
            ("timeout", raising_worker(self.gw.DeadlineExpired("simulated timeout")), None, None),
            ("enospc", raising_worker(OSError(errno.ENOSPC, "simulated ENOSPC")), None, None),
            ("low-headroom", self._worker_fake([], managed), self.gw.AdmissionError("low headroom"), None),
            ("promotion", self._worker_fake([], managed), None, fail_promotion),
        )
        for name, worker, admission_error, replace in faults:
            with self.subTest(fault=name):
                operations = []
                if name in {"low-headroom", "promotion"}:
                    worker = self._worker_fake(operations, managed)
                with contextlib.ExitStack() as stack:
                    if admission_error is None:
                        stack.enter_context(mock.patch.object(self.gw, "enforce_memory_admission"))
                    else:
                        stack.enter_context(mock.patch.object(
                            self.gw, "enforce_memory_admission", side_effect=admission_error
                        ))
                    stack.enter_context(mock.patch.object(self.gw, "_invoke_worker", side_effect=worker))
                    if replace is not None:
                        stack.enter_context(mock.patch.object(self.gw.os, "replace", side_effect=replace))
                    with self.assertRaises(Exception):
                        self.gw.refresh_index(managed, new_generation, command)
                self.assertNotIn("query", operations)
                self.assertTrue(self.gw._validate_live(live))
                self.assertEqual(self.gw._load_state(live), old_state)
                self.assertEqual((live / "graph.json").read_bytes(), old_graph)
                self.assertFalse(persistent_stage.exists())

    def test_gateway_recovery_discards_valid_json_with_wrong_status_schema(self):
        (self.repo / "a.py").write_text("x = 1\n")
        managed = self.gw.resolve_managed_repo(self.repo)
        generation = self.gw.inventory_source(self.repo)
        events = []
        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw, "_invoke_worker", side_effect=self._worker_fake(events, managed)
        ), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(
                self.gw.refresh_index(managed, generation, self.gw.QueryCommand("query", ("a",))),
                0,
            )
        live = managed.cache_root / "live"
        (live / "status.json").write_text("[]", encoding="utf-8")
        self.assertFalse(self.gw._validate_live(live))
        self.gw.recover_cache(managed.cache_root)
        self.assertFalse(live.exists())

    def test_gateway_main_enospc_is_concise_and_never_reads_stale_live(self):
        source = self.repo / "a.py"
        source.write_text("old = 1\n")
        managed = self.gw.resolve_managed_repo(self.repo)
        old_generation = self.gw.inventory_source(self.repo)
        command = self.gw.QueryCommand("query", ("a",))
        baseline = []
        with mock.patch.object(self.gw, "enforce_memory_admission"), mock.patch.object(
            self.gw, "_invoke_worker", side_effect=self._worker_fake(baseline, managed)
        ), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.gw.refresh_index(managed, old_generation, command), 0)
        live = managed.cache_root / "live"
        old_state = self.gw._load_state(live)
        source.write_text("new = 2\n")
        operations = []

        def enospc(descriptor, _deadline):
            operations.append(descriptor["operation"])
            raise OSError(errno.ENOSPC, "simulated tmpfs ENOSPC")

        with mock.patch.object(self.gw, "resolve_managed_repo", return_value=managed), mock.patch.object(
            self.gw, "enforce_memory_admission"
        ), mock.patch.object(
            self.gw, "_invoke_worker", side_effect=enospc
        ), contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
            secret_query = "DO_NOT_ECHO_QUERY_91bc"
            self.assertEqual(self.gw.main(["query", secret_query]), 2)
        self.assertEqual(operations, ["extract"])
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("ENOSPC", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())
        self.assertNotIn(secret_query, stderr.getvalue())
        self.assertIn("inspect authoritative source directly and retry Graphify later", stderr.getvalue())
        self.assertEqual(self.gw._load_state(live), old_state)

    def test_gateway_timeout_terminates_refresh_and_query_process_groups(self):
        script = (
            "import signal,subprocess,sys,time;"
            "ignore=sys.argv[1]=='ignore';"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN) if ignore else None;"
            "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);"
            "print(child.pid,flush=True);time.sleep(30)"
        )
        for operation, mode in (("refresh", "normal"), ("query", "ignore")):
            with self.subTest(operation=operation, mode=mode):
                process = subprocess.Popen(
                    [sys.executable, "-c", script, mode],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    start_new_session=True,
                )
                assert process.stdout is not None
                descendant = int(process.stdout.readline().strip())
                try:
                    with self.assertRaises(self.gw.DeadlineExpired):
                        self.gw.wait_process(process, time.monotonic() + 0.12)
                    self.assertIsNotNone(process.poll())
                    # A just-killed orphan can briefly remain a zombie until
                    # PID 1 reaps it. SIGKILL delivery to a descendant can also
                    # lag the already-reaped group leader by a scheduler tick,
                    # so poll briefly; a persistently runnable survivor fails.
                    stat = Path(f"/proc/{descendant}/stat")
                    reap_deadline = time.monotonic() + 0.5
                    while True:
                        try:
                            state = stat.read_text().split()[2]
                        except OSError as exc:
                            # The proc entry can disappear between lookup and
                            # read. That is successful teardown; no other read
                            # failure is accepted.
                            if exc.errno not in {errno.ENOENT, errno.ESRCH}:
                                raise
                            break
                        if state == "Z":
                            break
                        if time.monotonic() >= reap_deadline:
                            self.fail(f"descendant remained runnable after group teardown: {state}")
                        time.sleep(0.01)
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, 9)
                        process.wait()
                    if process.stdout is not None:
                        process.stdout.close()
                    if process.stderr is not None:
                        process.stderr.close()

    def test_gateway_cache_lock_and_worker_slot_wait_timeouts(self):
        for name in ("lock", "worker.lock"):
            lock = Path(self.tmp.name) / name
            with self.gw.deadline_lock(lock, time.monotonic() + 1):
                with self.assertRaises(self.gw.DeadlineExpired):
                    with self.gw.deadline_lock(lock, time.monotonic() + 0.02):
                        pass


if __name__ == "__main__":
    unittest.main()
