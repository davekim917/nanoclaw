from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest
from unittest import mock
import zipfile


MODULE_PATH = Path(__file__).parents[1] / "graphify-worker.py"
GATEWAY_PATH = Path(__file__).parents[1] / "graphify-gateway.py"


def load_worker():
    spec = importlib.util.spec_from_file_location("graphify_worker", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_gateway():
    spec = importlib.util.spec_from_file_location("graphify_worker_test_gateway", GATEWAY_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _source_item(self, root: Path, relative: str) -> dict:
        raw = (root / relative).read_bytes()
        graphify = hashlib.sha256(raw + b"\0" + relative.lower().encode()).hexdigest()
        return {
            "path": relative,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "md5": hashlib.md5(raw, usedforsecurity=False).hexdigest(),
            "bytes": len(raw),
            "graphify_hash": graphify,
        }

    def _asset_item(self, root: Path, relative: str) -> dict:
        raw = (root / relative).read_bytes()
        return {
            "path": relative,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
        }

    def _preprocess_item(self, root: Path, relative: str) -> dict:
        raw = (root / relative).read_bytes()
        return {
            "path": relative,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
        }

    def _preprocess_descriptor(self, source_root: Path, output_root: Path, relative: str) -> dict:
        return {
            "source_root": str(source_root),
            "output_root": str(output_root),
            "source": self._preprocess_item(source_root, relative),
        }

    def _write_office_fixture(self, path: Path, member: str = "fixture.xml", raw: bytes = b"<x/>") -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(member, raw)

    def test_worker_preprocesses_one_verified_pdf_with_page_provenance(self):
        source_root = self.root / "source"
        source_root.mkdir()
        (source_root / "brief.pdf").write_bytes(b"%PDF-1.7\n% bounded fixture\n")
        output_root = self.root / "output"

        class Page:
            def __init__(self, text: str):
                self.text = text

            def extract_text(self):
                return self.text

        pypdf = types.ModuleType("pypdf")
        pypdf.PdfReader = lambda _path: types.SimpleNamespace(
            is_encrypted=False,
            pages=[Page("Executive summary"), Page("Risks and actions")],
        )
        with mock.patch.dict(sys.modules, {"pypdf": pypdf}):
            result = self.worker.preprocess_source(
                self._preprocess_descriptor(source_root, output_root, "brief.pdf")
            )

        artifact = json.loads((output_root / "preprocessed.json").read_text())
        self.assertEqual(result, artifact)
        self.assertEqual(artifact["status"], "ok")
        self.assertEqual(artifact["source"]["path"], "brief.pdf")
        self.assertEqual(
            [(section["locator"], section["provenance"]) for section in artifact["sections"]],
            [("page:1", {"page": 1}), ("page:2", {"page": 2})],
        )
        self.assertLessEqual(
            (output_root / "preprocessed.json").stat().st_size,
            self.worker.MAX_PREPROCESSED_JSON_BYTES,
        )
        self.assertEqual(list(output_root.glob(".preprocessed.*.tmp")), [])

    def test_worker_preprocesses_docx_and_xlsx_with_sheet_provenance(self):
        source_root = self.root / "source"
        source_root.mkdir()
        self._write_office_fixture(source_root / "notes.docx")
        self._write_office_fixture(source_root / "model.xlsx")

        docx = types.ModuleType("docx")
        docx.Document = lambda _path: types.SimpleNamespace(
            paragraphs=[types.SimpleNamespace(text="Decision log")],
            tables=[types.SimpleNamespace(rows=[types.SimpleNamespace(cells=[
                types.SimpleNamespace(text="Owner"), types.SimpleNamespace(text="Operator")
            ])])],
        )

        class Worksheet:
            def __init__(self, title, rows):
                self.title = title
                self._rows = rows

            def iter_rows(self, *, values_only):
                self.assert_values_only = values_only
                return iter(self._rows)

        workbook = types.SimpleNamespace(
            worksheets=[Worksheet("Forecast", [("Month", "Revenue"), ("July", 42)])],
            close=mock.Mock(),
        )
        openpyxl = types.ModuleType("openpyxl")
        openpyxl.load_workbook = mock.Mock(return_value=workbook)

        with mock.patch.dict(sys.modules, {"docx": docx, "openpyxl": openpyxl}):
            docx_result = self.worker.preprocess_source(
                self._preprocess_descriptor(source_root, self.root / "docx-output", "notes.docx")
            )
            xlsx_result = self.worker.preprocess_source(
                self._preprocess_descriptor(source_root, self.root / "xlsx-output", "model.xlsx")
            )

        self.assertEqual(docx_result["status"], "ok")
        self.assertEqual(docx_result["sections"][0]["kind"], "document")
        self.assertIn("Decision log", docx_result["sections"][0]["text"])
        self.assertEqual(xlsx_result["status"], "ok")
        self.assertEqual(xlsx_result["sections"][0]["locator"], "sheet:Forecast")
        self.assertEqual(xlsx_result["sections"][0]["provenance"], {"sheet": "Forecast"})
        self.assertIn("July", xlsx_result["sections"][0]["text"])
        openpyxl.load_workbook.assert_called_once_with(
            source_root / "model.xlsx", read_only=True, data_only=True, keep_links=False
        )
        workbook.close.assert_called_once_with()

    def test_worker_preprocess_has_explicit_empty_and_nonsensitive_failure_results(self):
        source_root = self.root / "source"
        source_root.mkdir()
        (source_root / "empty.pdf").write_bytes(b"%PDF empty")
        (source_root / "broken.pdf").write_bytes(b"%PDF broken")

        class EmptyReader:
            is_encrypted = False
            pages = [types.SimpleNamespace(extract_text=lambda: " \n ")]

        class BrokenReader:
            def __init__(self, _path):
                raise ValueError("secret parser detail /private/source.pdf")

        pypdf = types.ModuleType("pypdf")
        pypdf.PdfReader = lambda _path: EmptyReader()
        with mock.patch.dict(sys.modules, {"pypdf": pypdf}):
            empty = self.worker.preprocess_source(
                self._preprocess_descriptor(source_root, self.root / "empty-output", "empty.pdf")
            )
        self.assertEqual(empty["status"], "empty")
        self.assertEqual(empty["sections"], [])
        self.assertIsNone(empty["error"])

        pypdf.PdfReader = BrokenReader
        with mock.patch.dict(sys.modules, {"pypdf": pypdf}):
            failed = self.worker.preprocess_source(
                self._preprocess_descriptor(source_root, self.root / "failed-output", "broken.pdf")
            )
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["sections"], [])
        self.assertEqual(failed["error"], "parse_failed")
        self.assertNotIn("secret", json.dumps(failed))
        self.assertNotIn("/private", json.dumps(failed))

    def test_worker_preprocess_rejects_real_archive_bomb_oversize_and_hash_mismatch(self):
        source_root = self.root / "source"
        source_root.mkdir()
        bomb = source_root / "bomb.docx"
        self._write_office_fixture(bomb, "word/document.xml", b"A" * (1024 * 1024))
        bomb_result = self.worker.preprocess_source(
            self._preprocess_descriptor(source_root, self.root / "bomb-output", "bomb.docx")
        )
        self.assertEqual(bomb_result["status"], "failed")
        self.assertEqual(bomb_result["error"], "unsafe_archive")
        self.assertEqual(bomb_result["sections"], [])

        oversized = source_root / "oversized.pdf"
        with oversized.open("wb") as stream:
            stream.truncate(self.worker.MAX_PREPROCESS_SOURCE_BYTES + 1)
        oversize_descriptor = {
            "source_root": str(source_root),
            "output_root": str(self.root / "oversize-output"),
            "source": {
                "path": "oversized.pdf",
                "sha256": "0" * 64,
                "bytes": oversized.stat().st_size,
            },
        }
        with self.assertRaisesRegex(self.worker.WorkerValidationError, "source exceeds"):
            self.worker.preprocess_source(oversize_descriptor)
        self.assertFalse((self.root / "oversize-output/preprocessed.json").exists())

        (source_root / "mismatch.pdf").write_bytes(b"%PDF mismatch")
        mismatch = self._preprocess_descriptor(
            source_root, self.root / "mismatch-output", "mismatch.pdf"
        )
        mismatch["source"]["sha256"] = "f" * 64
        with self.assertRaisesRegex(self.worker.WorkerValidationError, "hash mismatch"):
            self.worker.preprocess_source(mismatch)
        self.assertFalse((self.root / "mismatch-output/preprocessed.json").exists())

    def test_worker_preprocess_descriptor_is_local_strict_and_dispatched_after_guards(self):
        source_root = self.root / "source"
        source_root.mkdir()
        (source_root / "brief.pdf").write_bytes(b"%PDF local")
        descriptor = self._preprocess_descriptor(
            source_root, self.root / "output", "brief.pdf"
        )
        descriptor.update({
            "operation": "preprocess",
            "limits": {
                "address_space_bytes": self.worker.MAX_ADDRESS_SPACE,
                "file_bytes": self.worker.MAX_FILE_BYTES,
                "process_count": 0,
            },
        })
        request = self.root / "preprocess.json"
        request.write_text(json.dumps(descriptor))
        events = []
        with mock.patch.object(
            self.worker, "apply_limits", side_effect=lambda *_args: events.append("limits")
        ), mock.patch.object(
            self.worker, "install_task_guards", side_effect=lambda: events.append("guards")
        ), mock.patch.object(
            self.worker, "preprocess_source", side_effect=lambda _descriptor: events.append("preprocess")
        ), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.worker.main([str(request)]), 0)
        self.assertEqual(events, ["limits", "guards", "preprocess"])

        invalid = self._preprocess_descriptor(source_root, self.root / "invalid-output", "brief.pdf")
        invalid["source"]["url"] = "https://example.com/brief.pdf"
        with self.assertRaisesRegex(self.worker.WorkerValidationError, "source descriptor schema"):
            self.worker.preprocess_source(invalid)
        self.assertNotIn("requests", MODULE_PATH.read_text(encoding="utf-8"))

    def test_worker_applies_limits_before_import(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("import graphify", source.split("def _import_graphify", 1)[0])
        env = {}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(
            self.worker.resource, "setrlimit"
        ) as setlimit:
            self.worker.apply_limits(
                self.worker.MAX_ADDRESS_SPACE, self.worker.MAX_FILE_BYTES, 0
            )
            for name in self.worker.THREAD_ENVIRONMENT:
                self.assertEqual(os.environ[name], "1")
            self.assertEqual(os.environ["NANOCLAW_GRAPHIFY_SEQUENTIAL"], "1")
            self.assertEqual(os.environ["GRAPHIFY_MAX_WORKERS"], "1")
        self.assertEqual(setlimit.call_args_list, [
            mock.call(self.worker.resource.RLIMIT_AS, (1024 * 1024 * 1024,) * 2),
            mock.call(self.worker.resource.RLIMIT_FSIZE, (64 * 1024 * 1024,) * 2),
            mock.call(self.worker.resource.RLIMIT_NPROC, (0, 0)),
        ])

        for mode in ("extract", "query"):
            with self.subTest(mode=mode):
                descriptor = {
                    "operation": mode,
                    "limits": {
                        "address_space_bytes": 1024 * 1024 * 1024,
                        "file_bytes": 64 * 1024 * 1024,
                        "process_count": 0,
                    },
                }
                if mode == "query":
                    descriptor.update({"command": "query", "arguments": ["x"], "graph": "/owned/graph.json"})
                request = self.root / f"{mode}.json"
                request.write_text(json.dumps(descriptor))
                events = []

                def limits(*values):
                    self.assertEqual(values, (1024 * 1024 * 1024, 64 * 1024 * 1024, 0))
                    events.append("limits")

                def guards():
                    self.assertEqual(events, ["limits"])
                    events.append("guards")

                def extract_sentinel(_descriptor):
                    self.assertEqual(events, ["limits", "guards"])
                    events.append("graphify-import/extract")

                def query_sentinel(_graph, _command, _arguments):
                    self.assertEqual(events, ["limits", "guards"])
                    events.append("owned-query")
                    return ""

                with mock.patch.object(self.worker, "apply_limits", side_effect=limits), mock.patch.object(
                    self.worker, "install_task_guards", side_effect=guards
                ), mock.patch.object(
                    self.worker, "extract_candidate", side_effect=extract_sentinel
                ), mock.patch.object(
                    self.worker, "run_query", side_effect=query_sentinel
                ), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(self.worker.main([str(request)]), 0)
                self.assertEqual(
                    events,
                    ["limits", "guards", "graphify-import/extract" if mode == "extract" else "owned-query"],
                )

    def test_worker_reconciles_code_and_intentional_json(self):
        graph = {"nodes": [{"id": "a", "label": "a.py", "source_file": "a.py"}], "links": []}
        expected = [
            {"path": "a.py", "md5": hashlib.md5(b"x", usedforsecurity=False).hexdigest()},
            {"path": "data.json", "md5": hashlib.md5(b"[]", usedforsecurity=False).hexdigest()},
        ]
        status = self.worker.validate_candidate(
            graph, expected, {"a.py": "x", "data.json": "[]"}, ["data.json"], {}
        )
        self.assertEqual(status.contributed, ["a.py"])
        self.assertEqual(status.intentional_exclusions, ["data.json"])

    def test_worker_rejects_every_soft_incomplete_class(self):
        expected = [{"path": "a.py", "md5": "x"}]
        valid = {"nodes": [{"id": "a", "source_file": "a.py"}], "links": []}
        cases = {
            "zero nodes": ({"nodes": [], "links": []}, expected, {}, [], {}),
            "no source contribution": ({"nodes": [{"id": "a", "source_file": "other.py"}], "links": []}, expected, {}, [], {}),
            "dangling link": ({"nodes": [{"id": "a", "source_file": "a.py"}], "links": [{"source": "a", "target": "missing"}]}, expected, {}, [], {}),
            "duplicate node": ({"nodes": [{"id": "a", "source_file": "a.py"}, {"id": "a", "source_file": "a.py"}], "links": []}, expected, {}, [], {}),
            "no AST extractor": (valid, expected, {}, [], {"a.py": "classified as code but graphify has no AST"}),
            "missing dependency": (valid, expected, {}, [], {"a.py": "tree-sitter-sql not installed"}),
            "AST extraction failed": (valid, expected, {}, [], {"a.py": "AST extraction failed"}),
            "unknown extractor source": (valid, expected, {}, [], {"other.py": "AST extraction failed"}),
        }
        for name, args in cases.items():
            with self.subTest(case=name), self.assertRaises(self.worker.WorkerValidationError):
                self.worker.validate_candidate(*args)

    def test_worker_kernel_refuses_memory_file_process_and_thread_growth(self):
        target = self.root / "growth.bin"
        code = textwrap.dedent(f"""
            import importlib.util, os, resource, signal, subprocess, sys, threading
            spec = importlib.util.spec_from_file_location('w', {str(MODULE_PATH)!r})
            worker = importlib.util.module_from_spec(spec)
            sys.modules['w'] = worker
            spec.loader.exec_module(worker)
            signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
            worker.apply_limits(268435456, 65536, 0)
            print('LIMITS', resource.getrlimit(resource.RLIMIT_AS)[0], resource.getrlimit(resource.RLIMIT_FSIZE)[0], resource.getrlimit(resource.RLIMIT_NPROC)[0])
            try:
                bytearray(536870912)
            except MemoryError:
                print('MEMORY_REFUSED')
            fd = os.open({str(target)!r}, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                remaining = b'x' * 131072
                while remaining:
                    written = os.write(fd, remaining)
                    remaining = remaining[written:]
            except OSError:
                print('FILE_REFUSED')
            finally:
                os.close(fd)
            worker.install_task_guards()
            try:
                subprocess.Popen(['true'])
            except RuntimeError:
                print('PROCESS_REFUSED')
            try:
                os.fork()
            except (RuntimeError, OSError):
                print('FORK_REFUSED')
            try:
                threading.Thread(target=lambda: None).start()
            except RuntimeError:
                print('THREAD_REFUSED')
        """)
        result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(result.stdout.strip().splitlines()), {
            "LIMITS 268435456 65536 0", "MEMORY_REFUSED", "FILE_REFUSED",
            "PROCESS_REFUSED", "FORK_REFUSED", "THREAD_REFUSED",
        })

    def test_worker_query_uses_only_owned_graph_and_no_log(self):
        graph = self.root / "graph.json"
        graph.write_text(json.dumps({
            "nodes": [
                {"id": "a", "label": "Alpha", "source_file": "a.py"},
                {"id": "b", "label": "Beta", "source_file": "b.py"},
                {"id": "c", "label": "Caller", "source_file": "c.py"},
            ],
            "links": [
                {"source": "a", "target": "b", "relation": "uses"},
                {"source": "c", "target": "a", "relation": "uses"},
            ],
        }))
        log = self.root / "querylog.jsonl"
        hostile = self.root / "hostile-output"
        hostile_graph = self.root / "hostile.json"
        hostile_graph.write_text(json.dumps({"nodes": [{"id": "secret", "label": "HOSTILE"}], "links": []}))
        with mock.patch.dict(os.environ, {
            "GRAPHIFY_OUT": str(hostile),
            "GRAPHIFY_QUERY_LOG": str(log),
            "GRAPHIFY_GRAPH": str(hostile_graph),
        }):
            outputs = {
                "query": self.worker.run_query(graph, "query", ["Alpha"]),
                "path": self.worker.run_query(graph, "path", ["Alpha", "Beta"]),
                "explain": self.worker.run_query(graph, "explain", ["Alpha"]),
                "affected": self.worker.run_query(graph, "affected", ["Alpha"]),
            }
        self.assertIn("Alpha", outputs["query"])
        self.assertEqual(outputs["path"], "Alpha -> Beta\n")
        self.assertIn('"connections"', outputs["explain"])
        self.assertIn("c\tCaller", outputs["affected"])
        self.assertNotIn("HOSTILE", "".join(outputs.values()))
        self.assertFalse(log.exists())
        self.assertFalse(hostile.exists())
        with self.assertRaises(self.worker.WorkerValidationError):
            self.worker.run_query(self.root / "missing.json", "query", ["x"])

        descriptor = self.root / "oversized-query.json"
        descriptor.write_text(json.dumps({
            "operation": "query",
            "command": "query",
            "arguments": ["Alpha"],
            "graph": str(graph),
            "limits": {
                "address_space_bytes": self.worker.MAX_ADDRESS_SPACE,
                "file_bytes": self.worker.MAX_FILE_BYTES,
                "process_count": 0,
            },
        }))
        with mock.patch.object(self.worker, "apply_limits"), mock.patch.object(
            self.worker, "install_task_guards"
        ), mock.patch.object(
            self.worker, "run_query", return_value="x" * (self.worker.MAX_QUERY_RESULT_BYTES + 1)
        ), contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(self.worker.main([str(descriptor)]), 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("query result exceeds 64 KiB", stderr.getvalue())

    def test_worker_near_4000_file_status_exceeds_diagnostics_but_fits_metadata(self):
        paths = [f"pkg/{index:04d}.py" for index in range(3999)]
        status = self.worker.ExtractionStatus(
            detected=paths,
            applicable=paths,
            intentional_exclusions=[],
            contributed=paths,
            unsupported={},
            failed={},
        )
        target = self.root / "status.json"
        size, _digest = self.worker._write_bounded_json(
            target, self.worker.asdict(status), self.worker.MAX_METADATA_BYTES
        )
        self.assertGreater(size, self.worker.MAX_DIAGNOSTIC_BYTES)
        self.assertLess(size, self.worker.MAX_METADATA_BYTES)
        self.assertEqual(len(json.loads(target.read_text())["detected"]), 3999)

    def test_worker_duplicate_basenames_keep_relative_sources_and_portable_ast(self):
        content = b"def service():\n    return 1\n"
        source_one = self.root / "checkout-one"
        source_two = self.root / "checkout-two"
        for source_root in (source_one, source_two):
            for relative in ("one/service.py", "two/service.py"):
                path = source_root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
        outputs = [self.root / "candidate-one", self.root / "candidate-two"]
        calls = []
        cache_hits = []

        def fake_extract(
            paths, cache_root=None, *, root=None, parallel=True, max_workers=None
        ):
            paths = [Path(path) for path in paths]
            inferred_root = Path(root) if root is not None else Path(
                os.path.commonpath([str(path) for path in paths])
            )
            calls.append((inferred_root, Path(cache_root), parallel, max_workers))
            cache_dir = Path(cache_root) / "graphify-out" / "cache" / "ast" / f"v{self.worker.GRAPHIFY_VERSION}"
            cache_dir.mkdir(parents=True, exist_ok=True)
            nodes = []
            for path in paths:
                relative = path.relative_to(inferred_root).as_posix()
                raw = path.read_bytes()
                key = hashlib.sha256(raw + b"\0" + relative.lower().encode()).hexdigest()
                entry = cache_dir / f"{key}.json"
                if entry.exists():
                    cache_hits.append(relative)
                    payload = json.loads(entry.read_text())
                else:
                    payload = {"nodes": [{"id": relative, "label": relative, "source_file": relative}], "edges": []}
                    entry.write_text(json.dumps(payload))
                nodes.extend(payload["nodes"])
            return {"nodes": nodes, "edges": []}

        graphify = types.ModuleType("graphify")
        graphify.__path__ = []
        graphify_cache = types.ModuleType("graphify.cache")
        graphify_cache._flush_stat_index = lambda: None
        graphify.cache = graphify_cache

        def descriptor(source_root, output_root):
            return {
                "source_root": str(source_root),
                "output_root": str(output_root),
                "files": [self._source_item(source_root, relative) for relative in ("one/service.py", "two/service.py")],
                "assets": [],
            }

        with mock.patch.object(self.worker, "_import_graphify", return_value=fake_extract), mock.patch.dict(
            sys.modules, {"graphify": graphify, "graphify.cache": graphify_cache}
        ):
            self.worker.extract_candidate(descriptor(source_one, outputs[0]))
            seed = outputs[1] / "graphify-out" / "cache" / "ast" / f"v{self.worker.GRAPHIFY_VERSION}"
            seed.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(outputs[0] / "ast", seed)
            self.worker.extract_candidate(descriptor(source_two, outputs[1]))

        self.assertEqual([call[0] for call in calls], [source_one, source_two])
        self.assertEqual([call[1] for call in calls], outputs)
        self.assertTrue(all(call[2:] == (False, 1) for call in calls))
        self.assertEqual(sorted(cache_hits), ["one/service.py", "two/service.py"])
        self.assertEqual(len(list((outputs[0] / "ast").glob("*.json"))), 2)
        for output in outputs:
            graph = json.loads((output / "graph.json").read_text())
            self.assertEqual(
                sorted(node["source_file"] for node in graph["nodes"]),
                ["one/service.py", "two/service.py"],
            )

    def test_worker_repo_root_anchor_with_src_code_and_root_data_json(self):
        gateway = load_gateway()
        source_root = self.root / "source"
        (source_root / "src").mkdir(parents=True)
        (source_root / "src/one.py").write_text("def one():\n    return 1\n")
        (source_root / "src/two.py").write_text("def two():\n    return 2\n")
        (source_root / "dataset.json").write_text("[1,2,3]\n")
        output = self.root / "candidate"
        relatives = ("dataset.json", "src/one.py", "src/two.py")
        files = [self._source_item(source_root, relative) for relative in relatives]
        anchors = []

        def exact_patched_extract(
            paths, cache_root=None, *, root=None, parallel=True, max_workers=None
        ):
            paths = [Path(path) for path in paths]
            anchor = Path(root) if root is not None else Path(
                os.path.commonpath([str(path) for path in paths])
            )
            anchors.append(anchor)
            ast = Path(cache_root) / f"graphify-out/cache/ast/v{self.worker.GRAPHIFY_VERSION}"
            ast.mkdir(parents=True, exist_ok=True)
            nodes = []
            for path in paths:
                relative = path.relative_to(anchor).as_posix()
                key = hashlib.sha256(
                    path.read_bytes() + b"\0" + relative.lower().encode()
                ).hexdigest()
                payload = {
                    "nodes": [{"id": relative, "label": relative, "source_file": relative}],
                    "edges": [],
                }
                (ast / f"{key}.json").write_text(json.dumps(payload))
                nodes.extend(payload["nodes"])
            return {"nodes": nodes, "edges": []}

        graphify = types.ModuleType("graphify")
        graphify.__path__ = []
        graphify_cache = types.ModuleType("graphify.cache")
        graphify_cache._flush_stat_index = lambda: None
        graphify.cache = graphify_cache
        descriptor = {
            "source_root": str(source_root),
            "output_root": str(output),
            "files": files,
            "assets": [],
        }
        with mock.patch.object(
            self.worker, "_import_graphify", return_value=exact_patched_extract
        ), mock.patch.dict(
            sys.modules, {"graphify": graphify, "graphify.cache": graphify_cache}
        ):
            status = self.worker.extract_candidate(descriptor)

        self.assertEqual(anchors, [source_root])
        self.assertEqual(status.intentional_exclusions, ["dataset.json"])
        expected_code_hashes = {
            item["graphify_hash"] for item in files if item["path"].startswith("src/")
        }
        self.assertEqual(
            {path.stem for path in (output / "ast").glob("*.json")},
            expected_code_hashes,
        )
        source_files = tuple(gateway.SourceFile(**item) for item in files)
        generation = gateway.SourceGeneration(
            source_files,
            sum(item["bytes"] for item in files),
            gateway._generation_fingerprint(source_files),
        )
        gateway.validate_candidate(output, generation)
        cache_root = self.root / "cache"
        cache_root.mkdir()
        gateway.promote_candidate(
            cache_root, output, gateway.AcceptedSourceState.from_generation(generation)
        )
        self.assertTrue(gateway._validate_live(cache_root / "live"))

    def test_worker_mcp_config_is_applicable_and_preserves_hidden_source_name(self):
        raw = b'{"mcpServers":{"safe":{"command":"npx","env":{"API_KEY":"super-secret"}}}}'
        self.assertFalse(self.worker._intentional_data_json(".mcp.json", raw))
        self.assertTrue(self.worker._intentional_data_json(".MCP.JSON", raw))
        self.assertEqual(self.worker._canonical_source(".mcp.json", [".mcp.json"]), ".mcp.json")
        self.assertEqual(self.worker._canonical_source("././.mcp.json", [".mcp.json"]), ".mcp.json")
        self.assertIsNone(self.worker._canonical_source("../.mcp.json", [".mcp.json"]))
        graph = {
            "nodes": [
                {"id": "config", "label": ".mcp.json", "source_file": ".mcp.json"},
                {"id": "server", "label": "safe", "source_file": ".mcp.json"},
                {"id": "env", "label": "API_KEY", "source_file": ".mcp.json"},
            ],
            "links": [
                {"source": "config", "target": "server", "source_file": ".mcp.json"},
                {"source": "server", "target": "env", "source_file": ".mcp.json"},
            ],
        }
        expected = [{"path": ".mcp.json", "md5": hashlib.md5(raw, usedforsecurity=False).hexdigest()}]
        status = self.worker.validate_candidate(graph, expected, {".mcp.json": raw.decode()}, [], {})
        self.assertEqual(status.contributed, [".mcp.json"])
        self.assertNotIn("super-secret", json.dumps(graph))

    def test_worker_task_guards_refuse_child_processes_and_threads(self):
        code = (
            "import importlib.util,sys;"
            f"s=importlib.util.spec_from_file_location('w',{str(MODULE_PATH)!r});"
            "m=importlib.util.module_from_spec(s);sys.modules['w']=m;s.loader.exec_module(m);"
            "m.install_task_guards();import subprocess;"
            "\ntry: subprocess.Popen(['true'])\nexcept RuntimeError: print('PROCESS_REFUSED')"
            "\ntry: m._start_new_thread(lambda:None,())\nexcept RuntimeError: print('THREAD_REFUSED')"
        )
        result = subprocess.run([sys.executable, "-c", code], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip().splitlines(), ["PROCESS_REFUSED", "THREAD_REFUSED"])

    def test_worker_relocatable_skill_import_exception_is_owned_and_exact(self):
        def make_id(*parts):
            return "_".join(str(part).replace("/", "_").replace(".", "_").strip("_").lower() for part in parts)

        cases = (
            ".claude/skills/demo/resources/template.ts",
            ".claude/skills/demo/root-template.ts",
        )
        skill = self.root / ".claude/skills/demo"
        (skill / "resources").mkdir(parents=True)
        (skill / "SKILL.md").write_text("# demo\n")
        for relative in cases:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("import './missing';\n")
            node = {"id": relative, "label": path.name, "source_file": relative}
            missing_path = path.parent / "missing"
            edge = {
                "source": relative,
                "target": make_id(str(missing_path)),
                "relation": "imports_from",
                "context": "import",
                "confidence": "EXTRACTED",
                "_origin": "ast",
                "source_file": relative,
                "source_location": "L1",
            }
            facts = ({}, {(relative, 1): ("./missing", missing_path, set(), set())}, make_id, lambda *_: missing_path, str)
            with self.subTest(relative=relative), mock.patch.object(
                self.worker, "_js_reconciliation_facts", return_value=facts
            ):
                graph = self.worker._normalize_extracted_graph(
                    [node], [edge], self.root, [relative], []
                )
            self.assertEqual(graph["links"], [])
            self.assertEqual(self.worker._METRICS["graph_dropped_template_import_edges"], 1)

        outside = "src/outside.ts"
        outside_path = self.root / outside
        outside_path.parent.mkdir(parents=True)
        outside_path.write_text("import './missing';\n")
        outside_edge = dict(
            edge,
            source=outside,
            source_file=outside,
            target=make_id(str(outside_path.parent / "missing")),
        )
        outside_facts = ({}, {(outside, 1): ("./missing", outside_path.parent / "missing", set(), set())}, make_id, lambda *_: outside_path.parent / "missing", str)
        with mock.patch.object(
            self.worker, "_js_reconciliation_facts", return_value=outside_facts
        ), self.assertRaisesRegex(
            self.worker.WorkerValidationError, "outside the template exception"
        ):
            self.worker._normalize_extracted_graph(
                [{"id": outside, "label": outside_path.name, "source_file": outside}],
                [outside_edge], self.root, [outside], [],
            )

        wrong_target = dict(edge, target="not_the_pinned_target")
        root_relative = cases[1]
        root_path = self.root / root_relative
        wrong_facts = ({}, {(root_relative, 1): ("./missing", root_path.parent / "missing", set(), set())}, make_id, lambda *_: root_path.parent / "missing", str)
        with mock.patch.object(
            self.worker, "_js_reconciliation_facts", return_value=wrong_facts
        ), self.assertRaisesRegex(
            self.worker.WorkerValidationError, "outside the template exception"
        ):
            self.worker._normalize_extracted_graph(
                [{"id": root_relative, "label": root_path.name, "source_file": root_relative}],
                [wrong_target], self.root, [root_relative], [],
            )

    def test_worker_optional_pairing_template_gate_is_exact(self):
        def make_id(*parts):
            return "_".join(str(part).replace("/", "_").replace(".", "_").strip("_").lower() for part in parts)

        relative = "setup/pair-telegram.ts"
        source = self.root / relative
        source.parent.mkdir(parents=True)
        source.write_text("import { createPairing } from '../src/channels/telegram-pairing.js';\n")
        skill = self.root / ".claude/skills/add-telegram/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("# add telegram\n")
        missing = self.root / "src/channels/telegram-pairing.js"
        edge = {
            "source": "pair", "target": make_id(str(missing)), "relation": "imports_from",
            "context": "import", "confidence": "EXTRACTED", "_origin": "ast",
            "source_file": relative, "source_location": "L1",
        }
        facts = (
            {},
            {(relative, 1): (
                "../src/channels/telegram-pairing.js", missing,
                {make_id(str(missing), "createPairing")}, {"createPairing"},
            )},
            make_id,
            lambda *_: missing,
            lambda path: make_id(str(path)),
        )
        node = {"id": "pair", "label": "pair-telegram.ts", "source_file": relative}
        with mock.patch.object(self.worker, "_js_reconciliation_facts", return_value=facts):
            graph = self.worker._normalize_extracted_graph([node], [edge], self.root, [relative], [])
        self.assertEqual(graph["links"], [])
        self.assertEqual(self.worker._METRICS["graph_dropped_optional_pairing_edges"], 1)

        negative_cases = (
            ("setup/pair-discord.ts", "../src/channels/telegram-pairing.js"),
            (relative, "../src/channels/discord-pairing.js"),
            ("scripts/pair-telegram.ts", "../src/channels/telegram-pairing.js"),
        )
        for negative_relative, specifier in negative_cases:
            negative_source = self.root / negative_relative
            negative_source.parent.mkdir(parents=True, exist_ok=True)
            negative_source.write_text(f"import '{specifier}';\n")
            negative_missing = negative_source.parent / specifier
            negative_edge = dict(
                edge,
                source=negative_relative,
                source_file=negative_relative,
                target=make_id(str(negative_missing.resolve())),
            )
            negative_facts = (
                {},
                {(negative_relative, 1): (specifier, negative_missing, set(), set())},
                make_id,
                lambda *_: negative_missing,
                lambda path: make_id(str(path)),
            )
            with self.subTest(relative=negative_relative, specifier=specifier), mock.patch.object(
                self.worker, "_js_reconciliation_facts", return_value=negative_facts
            ), self.assertRaisesRegex(
                self.worker.WorkerValidationError, "outside the template exception"
            ):
                self.worker._normalize_extracted_graph(
                    [{"id": negative_relative, "label": negative_source.name, "source_file": negative_relative}],
                    [negative_edge], self.root, [negative_relative], [],
                )

        installed = self.root / "src/channels/telegram-pairing.ts"
        installed.parent.mkdir(parents=True, exist_ok=True)
        installed.write_text("export function createPairing() {}\n")
        installed_facts = (
            {},
            {(relative, 1): (
                "../src/channels/telegram-pairing.js", installed,
                {make_id(str(installed), "createPairing")}, {"createPairing"},
            )},
            make_id,
            lambda *_: installed,
            lambda path: make_id(str(path)),
        )
        installed_edge = dict(edge, target=make_id(str(installed)))
        installed_nodes = [
            node,
            {"id": "installed_file", "label": "telegram-pairing.ts", "source_file": "src/channels/telegram-pairing.ts"},
        ]
        with mock.patch.object(self.worker, "_js_reconciliation_facts", return_value=installed_facts):
            graph = self.worker._normalize_extracted_graph(
                installed_nodes, [installed_edge], self.root,
                [relative, "src/channels/telegram-pairing.ts"], [],
            )
        self.assertEqual(graph["links"][0]["target"], "installed_file")
        self.assertEqual(self.worker._METRICS["graph_dropped_optional_pairing_edges"], 0)

    def test_worker_nested_pairing_requires_exact_same_prefix_ownership(self):
        def make_id(*parts):
            return "_".join(
                str(part).replace("/", "_").replace(".", "_").strip("_").lower()
                for part in parts
            )

        relative = "repo/setup/pair-telegram.ts"
        source = self.root / relative
        source.parent.mkdir(parents=True)
        source.write_text(
            "import { createPairing } from '../src/channels/telegram-pairing.js';\n"
        )
        marker = self.root / "repo/.claude/skills/add-telegram/SKILL.md"
        marker.parent.mkdir(parents=True)
        marker.write_text("# nested telegram\n")
        wrong_prefix_marker = self.root / ".claude/skills/add-telegram/SKILL.md"
        wrong_prefix_marker.parent.mkdir(parents=True)
        wrong_prefix_marker.write_text("# wrong prefix\n")
        missing = self.root / "repo/src/channels/telegram-pairing.js"
        edge = {
            "source": "pair", "target": make_id(str(missing)),
            "relation": "imports_from", "context": "import",
            "confidence": "EXTRACTED", "_origin": "ast",
            "source_file": relative, "source_location": "L1",
        }
        facts = (
            {},
            {(relative, 1): (
                "../src/channels/telegram-pairing.js", missing,
                {make_id(str(missing), "createPairing")}, {"createPairing"},
            )},
            make_id,
            lambda *_: missing,
            lambda path: make_id(str(path)),
        )
        node = {"id": "pair", "label": "pair-telegram.ts", "source_file": relative}
        with mock.patch.object(self.worker, "_js_reconciliation_facts", return_value=facts):
            graph = self.worker._normalize_extracted_graph(
                [node], [edge], self.root, [relative], []
            )
        self.assertEqual(graph["links"], [])
        self.assertEqual(
            self.worker._METRICS["graph_dropped_optional_pairing_edges"], 1
        )

        marker.unlink()
        with mock.patch.object(
            self.worker, "_js_reconciliation_facts", return_value=facts
        ), self.assertRaisesRegex(
            self.worker.WorkerValidationError, "outside the template exception"
        ):
            self.worker._normalize_extracted_graph(
                [node], [edge], self.root, [relative], []
            )

        self.assertFalse(
            self.worker._optional_pairing_source(
                self.root,
                "repo/../setup/pair-telegram.ts",
                "../src/channels/telegram-pairing.js",
            )
        )
        self.assertFalse(
            self.worker._optional_pairing_source(
                self.root,
                relative,
                "../src/channels/discord-pairing.js",
            )
        )
        self.assertFalse(
            self.worker._relocatable_skill_source(
                self.root,
                "outer/.claude/skills/first/repo/.claude/skills/second/template.ts",
            )
        )
        self.assertIsNone(
            self.worker._skill_source_owner(
                "outer/.claude/skills/first/repo/.claude/skills/second/template.ts"
            )
        )
        bounded_prefix = "/".join(["project"] * 64)
        overlong_prefix = "/".join(["project"] * 65)
        self.assertIsNotNone(
            self.worker._pairing_owner(f"{bounded_prefix}/setup/pair-telegram.ts")
        )
        self.assertIsNone(
            self.worker._pairing_owner(f"{overlong_prefix}/setup/pair-telegram.ts")
        )

        nested_skill = "repo/.claude/skills/demo/resources/template.ts"
        nested_skill_marker = self.root / "repo/.claude/skills/demo/SKILL.md"
        nested_skill_marker.parent.mkdir(parents=True, exist_ok=True)
        nested_skill_marker.write_text("# nested demo\n")
        wrong_skill_marker = self.root / ".claude/skills/demo/SKILL.md"
        wrong_skill_marker.parent.mkdir(parents=True, exist_ok=True)
        wrong_skill_marker.write_text("# wrong prefix\n")
        self.assertTrue(
            self.worker._relocatable_skill_source(self.root, nested_skill)
        )
        nested_skill_marker.unlink()
        self.assertFalse(
            self.worker._relocatable_skill_source(self.root, nested_skill)
        )

    def test_worker_repairs_unique_local_import_and_rejects_ambiguous_caller(self):
        source = self.root / "src/source.ts"
        target = self.root / "src/target.ts"
        source.parent.mkdir(parents=True)
        source.write_text("import { Thing } from './target';\n")
        target.write_text("export interface Thing {}\n")
        nodes = [
            {"id": "source_file", "label": "source.ts", "source_file": "src/source.ts"},
            {"id": "target_file", "label": "target.ts", "source_file": "src/target.ts"},
            {"id": "target_thing", "label": "Thing", "source_file": "src/target.ts"},
            {"id": "callee", "label": "callee()", "source_file": "src/target.ts"},
            {"id": "caller_a", "label": "a()", "source_file": "src/source.ts"},
            {"id": "caller_b", "label": "b()", "source_file": "src/source.ts"},
        ]
        import_edge = {
            "source": "source_file", "target": "stale_target", "relation": "imports",
            "context": "import", "confidence": "EXTRACTED", "_origin": "ast",
            "source_file": "src/source.ts", "source_location": "L1",
        }
        facts = (
            {("src/source.ts", 1, "stale_target"): {"target_thing"}},
            {("src/source.ts", 1): ("./target", target, {"target_thing"}, {"Thing"})},
            lambda *parts: "_".join(parts),
            lambda *_: target,
            str,
        )
        with mock.patch.object(self.worker, "_js_reconciliation_facts", return_value=facts):
            graph = self.worker._normalize_extracted_graph(
                nodes, [import_edge], self.root,
                ["src/source.ts", "src/target.ts"], [],
            )
        self.assertEqual(graph["links"][0]["target"], "target_thing")
        self.assertEqual(self.worker._METRICS["graph_repaired_local_import_edges"], 1)

        valid_calls = [
            {
                "source": caller, "target": "callee", "relation": "calls", "context": "call",
                "confidence": "EXTRACTED", "_origin": "ast", "source_file": "src/source.ts",
                "source_location": "L1",
            }
            for caller in ("caller_a", "caller_b")
        ]
        dangling_call = dict(valid_calls[0], source="missing_caller")
        with mock.patch.object(
            self.worker, "_js_reconciliation_facts", return_value=facts
        ), self.assertRaisesRegex(
            self.worker.WorkerValidationError, "not uniquely owned"
        ):
            self.worker._normalize_extracted_graph(
                nodes, valid_calls + [dangling_call], self.root,
                ["src/source.ts", "src/target.ts"], [],
            )

    def test_worker_normalized_graph_is_order_independent(self):
        nodes = [
            {"id": "b", "label": "b.py", "source_file": "b.py"},
            {"id": "a", "label": "a.py", "source_file": "a.py"},
        ]
        edges = [
            {"source": "b", "target": "a", "relation": "uses"},
            {"source": "b", "target": "a", "relation": "uses"},
        ]
        first = self.worker._normalize_extracted_graph(nodes, edges, self.root, ["a.py", "b.py"], [])
        second = self.worker._normalize_extracted_graph(list(reversed(nodes)), list(reversed(edges)), self.root, ["b.py", "a.py"], [])
        self.assertEqual(
            json.dumps(first, sort_keys=True, separators=(",", ":")),
            json.dumps(second, sort_keys=True, separators=(",", ":")),
        )
        self.assertEqual(len(first["links"]), 1)
        metrics = self.worker._METRICS
        self.assertEqual(metrics["graph_deduped_edges"], 1)
        self.assertEqual(
            metrics["graph_raw_edges"]
            - metrics["graph_raw_dangling_edges"]
            + metrics["graph_repaired_local_import_edges"]
            + metrics["graph_repaired_caller_edges"]
            - metrics["graph_deduped_edges"],
            metrics["graph_output_edges"],
        )

    def test_worker_reconciliation_cap_fails_before_source_classification(self):
        nodes = [{"id": "source", "label": "a.py", "source_file": "a.py"}]
        edges = [
            {
                "source": "source", "target": f"missing_{index}",
                "relation": "imports", "source_file": "a.py",
            }
            for index in range(2)
        ]
        with mock.patch.object(
            self.worker, "MAX_EDGE_RECONCILIATIONS", 1
        ), mock.patch.object(
            self.worker, "_js_reconciliation_facts"
        ) as facts, self.assertRaisesRegex(
            self.worker.WorkerValidationError, "absolute safety cap"
        ):
            self.worker._normalize_extracted_graph(
                nodes, edges, self.root, ["a.py"], []
            )
        facts.assert_not_called()

    def test_worker_verified_staged_css_asset_is_exact_and_fail_closed(self):
        source = self.root / "src/main.tsx"
        asset = self.root / "src/styles.css"
        source.parent.mkdir(parents=True)
        source.write_text("import './styles.css';\n")
        asset.write_text("body { color: black; }\n")
        nodes = [
            {"id": "main", "label": "main.tsx", "source_file": "src/main.tsx"},
        ]
        valid_edge = {
            "source": "main", "target": "asset_target", "relation": "imports_from",
            "context": "import", "confidence": "EXTRACTED", "_origin": "ast",
            "source_file": "src/main.tsx", "source_location": "L1",
        }
        facts = (
            {},
            {("src/main.tsx", 1): ("./styles.css", asset, set(), set())},
            lambda *parts: "asset_target" if str(asset) in str(parts[0]) else "other_target",
            lambda *_: asset,
            lambda path: str(path),
        )
        with mock.patch.object(self.worker, "_js_reconciliation_facts", return_value=facts):
            graph = self.worker._normalize_extracted_graph(
                nodes, [valid_edge], self.root, ["src/main.tsx"], [], {"src/styles.css"}
            )
        self.assertEqual(graph["links"], [])
        self.assertEqual(self.worker._METRICS["graph_dropped_non_graph_asset_edges"], 1)

        for name, edge, proof, remove_asset in (
            ("absent proof", valid_edge, set(), False),
            ("wrong target", dict(valid_edge, target="wrong_target"), {"src/styles.css"}, False),
            ("absent staged file", valid_edge, {"src/styles.css"}, True),
        ):
            with self.subTest(case=name):
                if remove_asset:
                    asset.unlink()
                with mock.patch.object(
                    self.worker, "_js_reconciliation_facts", return_value=facts
                ), self.assertRaises(self.worker.WorkerValidationError):
                    self.worker._normalize_extracted_graph(
                        nodes, [edge], self.root, ["src/main.tsx"], [], proof
                    )
                if remove_asset:
                    asset.write_text("body { color: black; }\n")

    def test_worker_production_staged_css_and_skill_proofs_reconcile_exact_edges(self):
        gateway = load_gateway()
        live = self.root / "live"
        main = live / "src/main.tsx"
        css = live / "src/styles.css"
        template = live / ".claude/skills/demo/resources/template.ts"
        marker = live / ".claude/skills/demo/SKILL.md"
        for path in (main, css, template, marker):
            path.parent.mkdir(parents=True, exist_ok=True)
        main.write_text("import './styles.css';\n")
        css.write_text("body {}\n")
        template.write_text("import './missing.js';\n")
        marker.write_text("# demo\n")
        generation = gateway.inventory_source(live)
        stage = self.root / "stage"
        gateway.capture_source(live, stage, generation)
        assets = [
            {"path": item.path, "sha256": item.sha256, "bytes": item.bytes}
            for item in generation.assets
        ]
        code_paths = {item.path for item in generation.files}
        verified = self.worker._verified_asset_paths(stage, assets, code_paths)
        staged_css = stage / "src/styles.css"
        staged_missing = stage / ".claude/skills/demo/resources/missing.js"

        def make_id(*parts):
            return "_".join(
                str(part).replace("/", "_").replace(".", "_").strip("_").lower()
                for part in parts
            )

        nodes = [
            {"id": "main", "label": "main.tsx", "source_file": "src/main.tsx"},
            {
                "id": "template", "label": "template.ts",
                "source_file": ".claude/skills/demo/resources/template.ts",
            },
        ]
        edges = [
            {
                "source": "main", "target": make_id(str(staged_css)),
                "relation": "imports_from", "context": "import",
                "confidence": "EXTRACTED", "_origin": "ast",
                "source_file": "src/main.tsx", "source_location": "L1",
            },
            {
                "source": "template", "target": make_id(str(staged_missing)),
                "relation": "imports_from", "context": "import",
                "confidence": "EXTRACTED", "_origin": "ast",
                "source_file": ".claude/skills/demo/resources/template.ts",
                "source_location": "L1",
            },
        ]
        statements = {
            ("src/main.tsx", 1): ("./styles.css", staged_css, set(), set()),
            (".claude/skills/demo/resources/template.ts", 1): (
                "./missing.js", staged_missing, set(), set()
            ),
        }
        facts = ({}, statements, make_id, lambda *_: None, str)
        try:
            with mock.patch.object(
                self.worker, "_js_reconciliation_facts", return_value=facts
            ):
                graph = self.worker._normalize_extracted_graph(
                    nodes, edges, stage, sorted(code_paths), [], verified
                )
            self.assertEqual(graph["links"], [])
            self.assertEqual(
                self.worker._METRICS["graph_dropped_non_graph_asset_edges"], 1
            )
            self.assertEqual(
                self.worker._METRICS["graph_dropped_template_import_edges"], 1
            )
        finally:
            gateway._remove_tree(stage)

    def test_worker_shell_source_uses_one_bounded_ancestor_and_fails_closed(self):
        def make_id(*parts):
            return "_".join(
                str(part).replace("/", "_").replace(".", "_").strip("_").lower()
                for part in parts
            )

        facts_patch = mock.patch.object(
            self.worker,
            "_js_reconciliation_facts",
            return_value=({}, {}, make_id, lambda *_: None, str),
        )
        facts_patch.start()
        self.addCleanup(facts_patch.stop)

        deploy_relative = "repo/scripts/deploy.sh"
        target_relative = "repo/setup/lib/install-slug.sh"
        deploy = self.root / deploy_relative
        target_file = self.root / target_relative
        deploy.parent.mkdir(parents=True)
        target_file.parent.mkdir(parents=True)
        deploy.write_text('source "setup/lib/install-slug.sh"\n')
        target_file.write_text("install_slug() { :; }\n")
        nodes = [
            {"id": "deploy", "label": "deploy.sh", "source_file": deploy_relative},
            {"id": "slug", "label": "install-slug.sh", "source_file": target_relative},
        ]
        edge = {
            "source": "deploy", "target": make_id("setup/lib/install-slug.sh"),
            "relation": "imports", "context": "import", "confidence": "EXTRACTED",
            "_origin": "ast", "source_file": deploy_relative, "source_location": "L1",
        }
        graph = self.worker._normalize_extracted_graph(
            nodes, [edge], self.root, [deploy_relative, target_relative], []
        )
        self.assertEqual(graph["links"][0]["target"], "slug")
        self.assertEqual(self.worker._METRICS["graph_repaired_local_import_edges"], 1)
        with mock.patch.object(
            self.worker, "MAX_SOURCE_ANCESTORS", 1
        ), self.assertRaises(self.worker.WorkerValidationError):
            self.worker._normalize_extracted_graph(
                nodes, [edge], self.root, [deploy_relative, target_relative], []
            )

        ambiguous_relative = "setup/lib/install-slug.sh"
        ambiguous = self.root / ambiguous_relative
        ambiguous.parent.mkdir(parents=True)
        ambiguous.write_text("install_slug() { :; }\n")
        ambiguous_nodes = nodes + [
            {"id": "root_slug", "label": "install-slug.sh", "source_file": ambiguous_relative}
        ]
        with self.assertRaisesRegex(self.worker.WorkerValidationError, "not uniquely resolved"):
            self.worker._normalize_extracted_graph(
                ambiguous_nodes, [edge], self.root,
                [deploy_relative, target_relative, ambiguous_relative], [],
            )

        wrong_target = dict(edge, target="wrong_target")
        with self.assertRaisesRegex(self.worker.WorkerValidationError, "pinned id"):
            self.worker._normalize_extracted_graph(
                nodes, [wrong_target], self.root, [deploy_relative, target_relative], []
            )

        traversal_relative = "repo/scripts/traversal.sh"
        traversal = self.root / traversal_relative
        outside = self.root.parent / f"{self.root.name}-outside.sh"
        outside.write_text("outside() { :; }\n")
        self.addCleanup(outside.unlink, missing_ok=True)
        traversal_target = f"../../../{outside.name}"
        traversal.write_text(f'source "{traversal_target}"\n')
        traversal_edge = dict(
            edge,
            source="traversal",
            target=make_id(traversal_target),
            source_file=traversal_relative,
        )
        with self.assertRaises(self.worker.WorkerValidationError):
            self.worker._normalize_extracted_graph(
                [{"id": "traversal", "label": "traversal.sh", "source_file": traversal_relative}],
                [traversal_edge], self.root, [traversal_relative], [],
            )

        variable_relative = "repo/scripts/variable.sh"
        variable = self.root / variable_relative
        variable.write_text('source "$ROOT/setup/lib/install-slug.sh"\n')
        variable_target = "$ROOT/setup/lib/install-slug.sh"
        variable_edge = dict(
            edge,
            source="variable",
            target=make_id(variable_target),
            source_file=variable_relative,
        )
        variable_graph = self.worker._normalize_extracted_graph(
            [{"id": "variable", "label": "variable.sh", "source_file": variable_relative}],
            [variable_edge], self.root, [variable_relative], [],
        )
        self.assertEqual(variable_graph["links"], [])
        self.assertEqual(self.worker._METRICS["graph_dropped_shell_source_edges"], 1)

    def test_worker_asset_descriptor_rejects_tamper_caps_ambiguity_and_unsafe_paths(self):
        source = self.root / "src/main.tsx"
        asset = self.root / "src/styles.css"
        other = self.root / "src/image.png"
        source.parent.mkdir(parents=True)
        source.write_text("import './styles.css';\n")
        asset.write_text("body {}\n")
        other.write_bytes(b"png")
        item = self._asset_item(self.root, "src/styles.css")
        self.assertEqual(
            self.worker._verified_asset_paths(
                self.root, [item], {"src/main.tsx"}
            ),
            {"src/styles.css"},
        )

        marker = self.root / ".claude/skills/demo/SKILL.md"
        marker.parent.mkdir(parents=True)
        marker.write_text("# demo\n")
        marker_item = self._asset_item(self.root, ".claude/skills/demo/SKILL.md")
        self.assertEqual(
            self.worker._verified_asset_paths(
                self.root, [marker_item], {".claude/skills/demo/resources/template.ts"}
            ),
            {".claude/skills/demo/SKILL.md"},
        )
        with self.assertRaisesRegex(self.worker.WorkerValidationError, "owner"):
            self.worker._verified_asset_paths(
                self.root, [marker_item], {"src/main.tsx"}
            )

        pair_marker = self.root / ".claude/skills/add-chat/SKILL.md"
        pair_marker.parent.mkdir(parents=True)
        pair_marker.write_text("# add chat\n")
        pair_item = self._asset_item(self.root, ".claude/skills/add-chat/SKILL.md")
        self.assertEqual(
            self.worker._verified_asset_paths(
                self.root, [pair_item], {"setup/pair-chat.ts"}
            ),
            {".claude/skills/add-chat/SKILL.md"},
        )

        nested_marker = self.root / "repo/.claude/skills/demo/SKILL.md"
        nested_marker.parent.mkdir(parents=True)
        nested_marker.write_text("# nested demo\n")
        nested_item = self._asset_item(
            self.root, "repo/.claude/skills/demo/SKILL.md"
        )
        self.assertEqual(
            self.worker._verified_asset_paths(
                self.root,
                [nested_item],
                {"repo/.claude/skills/demo/resources/template.ts"},
            ),
            {"repo/.claude/skills/demo/SKILL.md"},
        )
        with self.assertRaisesRegex(self.worker.WorkerValidationError, "owner"):
            self.worker._verified_asset_paths(
                self.root,
                [nested_item],
                {".claude/skills/demo/resources/template.ts"},
            )

        nested_pair_marker = self.root / "repo/.claude/skills/add-chat/SKILL.md"
        nested_pair_marker.parent.mkdir(parents=True)
        nested_pair_marker.write_text("# nested add chat\n")
        nested_pair_item = self._asset_item(
            self.root, "repo/.claude/skills/add-chat/SKILL.md"
        )
        self.assertEqual(
            self.worker._verified_asset_paths(
                self.root, [nested_pair_item], {"repo/setup/pair-chat.ts"}
            ),
            {"repo/.claude/skills/add-chat/SKILL.md"},
        )
        with self.assertRaisesRegex(self.worker.WorkerValidationError, "owner"):
            self.worker._verified_asset_paths(
                self.root, [nested_pair_item], {"setup/pair-chat.ts"}
            )

        asset.write_text("body { color: red; }\n")
        with self.assertRaises(self.worker.WorkerValidationError):
            self.worker._verified_asset_paths(
                self.root, [item], {"src/main.tsx"}
            )
        asset.write_text("body {}\n")
        cases = {
            "ambiguous duplicate": [item, item],
            "wrong extension": [self._asset_item(self.root, "src/image.png")],
            "unsafe relative": [dict(item, path="../styles.css")],
        }
        for name, assets in cases.items():
            with self.subTest(case=name), self.assertRaises(self.worker.WorkerValidationError):
                self.worker._verified_asset_paths(
                    self.root, assets, {"src/main.tsx"}
                )
        with mock.patch.object(
            self.worker, "MAX_ASSET_BYTES", item["bytes"] - 1
        ), self.assertRaisesRegex(self.worker.WorkerValidationError, "asset.*cap"):
            self.worker._verified_asset_paths(
                self.root, [item], {"src/main.tsx"}
            )
        asset.unlink()
        with self.assertRaises(self.worker.WorkerValidationError):
            self.worker._verified_asset_paths(
                self.root, [item], {"src/main.tsx"}
            )

    def test_worker_local_import_fallbacks_require_unique_source_proof(self):
        def make_id(*parts):
            return "_".join(str(part).replace("/", "_").replace(".", "_").strip("_").lower() for part in parts)

        source = self.root / "src/source.ts"
        target = self.root / "src/target.tsx"
        source.parent.mkdir(parents=True)
        source.write_text("import { Thing } from './target.js';\n")
        target.write_text("export interface Thing {}\n")
        nodes = [
            {"id": "source_file", "label": "source.ts", "source_file": "src/source.ts"},
            {"id": "target_file", "label": "target.tsx", "source_file": "src/target.tsx"},
            {"id": "target_thing", "label": "Thing", "source_file": "src/target.tsx"},
        ]
        spelled = source.parent / "target.js"
        module_edge = {
            "source": "source_file", "target": make_id(str(spelled)), "relation": "imports_from",
            "context": "import", "confidence": "EXTRACTED", "_origin": "ast",
            "source_file": "src/source.ts", "source_location": "L1",
        }
        symbol_edge = dict(module_edge, target="stale_thing", relation="imports")
        facts = (
            {},
            {("src/source.ts", 1): ("./target.js", spelled, {"stale_thing"}, {"Thing"})},
            make_id,
            lambda *_: spelled,
            lambda _path: "stale",
        )
        with mock.patch.object(self.worker, "_js_reconciliation_facts", return_value=facts):
            graph = self.worker._normalize_extracted_graph(
                nodes, [module_edge, symbol_edge], self.root,
                ["src/source.ts", "src/target.tsx"], [],
            )
        self.assertEqual(
            {(edge["relation"], edge["target"]) for edge in graph["links"]},
            {("imports_from", "target_file"), ("imports", "target_thing")},
        )

        constant_edge = dict(module_edge, target="stale_constant", relation="imports")
        constant_facts = (
            {},
            {("src/source.ts", 1): (
                "./target.js", spelled,
                {"stale_thing", "stale_constant"}, {"Thing", "CONSTANT"},
            )},
            make_id,
            lambda *_: spelled,
            lambda _path: "stale",
        )
        with mock.patch.object(
            self.worker, "_js_reconciliation_facts", return_value=constant_facts
        ):
            graph = self.worker._normalize_extracted_graph(
                nodes, [constant_edge, module_edge], self.root,
                ["src/source.ts", "src/target.tsx"], [],
            )
        self.assertEqual(
            [(edge["relation"], edge["target"]) for edge in graph["links"]],
            [("imports_from", "target_file")],
        )
        self.assertEqual(
            self.worker._METRICS["graph_dropped_unrepresented_local_symbol_edges"], 1
        )
        with mock.patch.object(
            self.worker, "_js_reconciliation_facts", return_value=constant_facts
        ), self.assertRaisesRegex(
            self.worker.WorkerValidationError, "no exact symbol"
        ):
            self.worker._normalize_extracted_graph(
                nodes, [constant_edge], self.root,
                ["src/source.ts", "src/target.tsx"], [],
            )
        wrong_companion = dict(module_edge, target="wrong_module_target")
        with mock.patch.object(
            self.worker, "_js_reconciliation_facts", return_value=constant_facts
        ), self.assertRaises(self.worker.WorkerValidationError):
            self.worker._normalize_extracted_graph(
                nodes, [constant_edge, wrong_companion], self.root,
                ["src/source.ts", "src/target.tsx"], [],
            )

        moved = self.root / "src/moved.ts"
        duplicate = self.root / "src/duplicate.ts"
        moved.write_text("export interface Thing {}\n")
        duplicate.write_text("export interface Thing {}\n")
        ambiguous_nodes = nodes[:1] + [
            {"id": "moved", "label": "moved.ts", "source_file": "src/moved.ts"},
            {"id": "moved_thing", "label": "Thing", "source_file": "src/moved.ts"},
            {"id": "duplicate", "label": "duplicate.ts", "source_file": "src/duplicate.ts"},
            {"id": "duplicate_thing", "label": "Thing", "source_file": "src/duplicate.ts"},
        ]
        moved_spelling = source.parent / "deleted.js"
        ambiguous_facts = (
            {},
            {("src/source.ts", 1): ("./deleted.js", moved_spelling, {"stale_symbol"}, {"Thing"})},
            make_id,
            lambda *_: moved_spelling,
            lambda _path: "stale",
        )
        with mock.patch.object(
            self.worker, "_js_reconciliation_facts", return_value=ambiguous_facts
        ), self.assertRaisesRegex(
            self.worker.WorkerValidationError, "outside the template exception"
        ):
            self.worker._normalize_extracted_graph(
                ambiguous_nodes, [dict(module_edge, target=make_id(str(moved_spelling)))], self.root,
                ["src/source.ts", "src/moved.ts", "src/duplicate.ts"], [],
            )

        no_symbol_facts = (
            {},
            {("src/source.ts", 1): ("./deleted.js", moved_spelling, set(), {"Missing"})},
            make_id,
            lambda *_: moved_spelling,
            lambda _path: "stale",
        )
        with mock.patch.object(
            self.worker, "_js_reconciliation_facts", return_value=no_symbol_facts
        ), self.assertRaisesRegex(
            self.worker.WorkerValidationError, "outside the template exception"
        ):
            self.worker._normalize_extracted_graph(
                nodes, [dict(module_edge, target=make_id(str(moved_spelling)))], self.root,
                ["src/source.ts", "src/target.tsx"], [],
            )

        bare_candidate = self.root / "node_modules/pkg/index.ts"
        bare_facts = (
            {},
            {("src/source.ts", 1): ("pkg", bare_candidate, {"stale_symbol"}, {"Thing"})},
            make_id,
            lambda *_: bare_candidate,
            lambda _path: "stale",
        )
        with mock.patch.object(
            self.worker, "_js_reconciliation_facts", return_value=bare_facts
        ), self.assertRaisesRegex(
            self.worker.WorkerValidationError, "outside the template exception"
        ):
            self.worker._normalize_extracted_graph(
                nodes, [dict(module_edge, target="stale_package")], self.root,
                ["src/source.ts", "src/target.tsx"], [],
            )


if __name__ == "__main__":
    unittest.main()
