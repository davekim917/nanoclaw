from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parents[1]
LOCK = ROOT / "graphify-requirements.lock"
AUDIT = ROOT / "graphify-wheel-audit.json"
INTEGRATION = json.loads((ROOT / "graphify-integration.json").read_text(encoding="utf-8"))
UPDATE_SCRIPT = ROOT.parent / "scripts" / "update-graphify.ts"


def parse_lock() -> dict[str, dict[str, str]]:
    packages: dict[str, dict[str, str]] = {}
    pattern = re.compile(
        r"^(?P<name>[A-Za-z0-9_.-]+)==(?P<version>[^ ;]+) "
        r"--hash=sha256:(?P<sha>[0-9a-f]{64}) # (?P<filename>\S+)$"
    )
    for number, raw in enumerate(LOCK.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = pattern.fullmatch(line)
        if not match:
            raise AssertionError(f"invalid lock line {number}: {raw}")
        item = match.groupdict()
        key = re.sub(r"[-_.]+", "-", item["name"]).lower()
        if key in packages:
            raise AssertionError(f"duplicate locked package: {key}")
        packages[key] = item
    return packages


class SupplyChainTest(unittest.TestCase):
    def test_release_adapter_enables_pdf_office_sql_video_extras(self):
        # Keep this stable CI entry-point name while asserting the revised policy:
        # local media transcription is deferred until an offline model is seeded.
        expected_extras = ["pdf", "office", "sql"]
        self.assertEqual(INTEGRATION["package"]["extras"], expected_extras)
        script = UPDATE_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("const ENABLED_EXTRAS = ['pdf', 'office', 'sql']", script)
        self.assertIn("const requirement = graphifyRequirement(version)", script)
        self.assertIn("await writeFile(inputPath, `${requirement}\\n`)", script)
        self.assertRegex(script, r"'--dest',\s*wheelhouse,\s*requirement")
        self.assertIn("Enabled extras: pdf, office, sql.", LOCK.read_text(encoding="utf-8"))

        locked = parse_lock()
        # One distinctive distribution from every selected extra.
        for package in ("pypdf", "python-docx", "tree-sitter-sql"):
            self.assertIn(package, locked)
        for package in (
            "av", "ctranslate2", "faster-whisper", "huggingface-hub",
            "onnxruntime", "tokenizers", "yt-dlp",
        ):
            self.assertNotIn(package, locked)

    def test_lock_and_audit_are_bijective_and_hashed(self):
        locked = parse_lock()
        audit = json.loads(AUDIT.read_text(encoding="utf-8"))
        self.assertEqual(audit["schemaVersion"], 1)
        self.assertEqual(audit["releasePolicy"], "latest-stable")
        self.assertNotIn("cutoff", audit)
        self.assertRegex(audit["uv_version"], r"^uv \d+\.\d+\.\d+(?: \([^)]+\))?$")
        self.assertEqual(audit["python_version"], "3.11")
        self.assertEqual(audit["platform"], "manylinux2014_aarch64")
        self.assertTrue(audit["generated_at"].endswith("Z"))
        wheels = {re.sub(r"[-_.]+", "-", w["package"]).lower(): w for w in audit["wheels"]}
        self.assertEqual(set(locked), set(wheels))
        self.assertEqual(locked["graphifyy"]["version"], INTEGRATION["package"]["version"])
        for name, item in locked.items():
            wheel = wheels[name]
            self.assertEqual(item["version"], wheel["version"])
            self.assertEqual(item["filename"], wheel["filename"])
            self.assertEqual(item["sha"], wheel["sha256"])

    def test_arm64_closure_contains_only_audited_wheels(self):
        audit = json.loads(AUDIT.read_text(encoding="utf-8"))
        self.assertEqual(audit["extras"], ["pdf", "office", "sql"])
        self.assertEqual(audit["requirement"], "graphifyy[pdf,office,sql]==0.9.20")
        self.assertGreater(len(audit["wheels"]), 1)
        for wheel in audit["wheels"]:
            with self.subTest(wheel=wheel["filename"]):
                self.assertNotRegex(wheel["version"], r"(?i)(a|b|rc|dev|alpha|beta|preview|nightly)")
                self.assertTrue(wheel["uploaded_at"].endswith("Z"))
                filename = wheel["filename"]
                self.assertTrue(filename.endswith(".whl"))
                self.assertNotRegex(filename, r"(x86_64|amd64|win32|win_amd64|macosx)")
                self.assertRegex(
                    filename,
                    r"-(?:(?:py2\.)?py3-none-any|cp(?:38|39|310|311)-(?:abi3|cp311)-[^-]*aarch64[^-]*)\.whl$",
                )
                self.assertRegex(wheel["sha256"], r"^[0-9a-f]{64}$")
        text = LOCK.read_text(encoding="utf-8")
        self.assertNotRegex(text, r"(?im)(\.tar\.gz|\.zip|git\+|https?://|file:|@\s|>=|<=|~=|\*)")

    def test_latest_stable_rejects_prereleases_without_age_delay(self):
        script = UPDATE_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("latestStablePyPiVersion", script)
        self.assertIn("latestStableGitHubRelease", script)
        self.assertRegex(script, r"'--prerelease',\s*'disallow'")
        self.assertNotRegex(script, r"(?i)(minimumReleaseAge|release[-_ ]age|cutoff)")
        audit = json.loads(AUDIT.read_text(encoding="utf-8"))
        self.assertEqual(audit["releasePolicy"], "latest-stable")
        self.assertNotIn("cutoff", audit)

    def test_offline_no_deps_install_contract(self):
        locked = parse_lock()
        configured = os.environ.get("GRAPHIFY_WHEELHOUSE")
        if not configured:
            self.skipTest(
                "no ARM64 wheelhouse in the source-test lane; container image lane D must run the audited offline install"
            )
        with tempfile.TemporaryDirectory() as tmp:
            wheelhouse = Path(configured)
            if not wheelhouse.is_dir():
                self.fail(f"GRAPHIFY_WHEELHOUSE is not a directory: {wheelhouse}")
            for item in locked.values():
                wheel = wheelhouse / item["filename"]
                self.assertTrue(wheel.is_file(), wheel)
                self.assertEqual(hashlib.sha256(wheel.read_bytes()).hexdigest(), item["sha"])
            command = [
                sys.executable, "-m", "pip", "install", "--no-index", "--no-deps",
                "--only-binary=:all:", "--require-hashes",
                "--platform", "manylinux2014_aarch64", "--python-version", "3.11",
                "--implementation", "cp", "--abi", "cp311", "--abi", "abi3", "--abi", "none",
                "--find-links", str(wheelhouse),
                "--target", str(Path(tmp) / "site"), "-r", str(LOCK),
            ]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertGreater(len(locked), 1)


if __name__ == "__main__":
    unittest.main()
