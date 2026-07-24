from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from graphify_engine_contract import run_contract


ROOT = Path(__file__).parents[1]
INTEGRATION_PATH = ROOT / "graphify-integration.json"
INTEGRATION = json.loads(INTEGRATION_PATH.read_text(encoding="utf-8"))
VERSION = INTEGRATION["package"]["version"]
GATEWAY = ROOT / "graphify-gateway.py"


def load_gateway():
    spec = importlib.util.spec_from_file_location("graphify_contract_gateway", GATEWAY)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class UpstreamContractTest(unittest.TestCase):
    def test_manifest_declares_behavior_governed_compatibility(self):
        self.assertEqual(INTEGRATION["schemaVersion"], 2)
        self.assertEqual(INTEGRATION["package"]["name"], "graphifyy")
        self.assertEqual(
            INTEGRATION["upstream"]["tag"],
            f"v{INTEGRATION['package']['version']}",
        )
        self.assertRegex(INTEGRATION["upstream"]["commit"], r"^[0-9a-f]{40}$")
        self.assertNotIn("skillSha256", INTEGRATION["upstream"])
        self.assertNotIn("semanticSurfaces", INTEGRATION["upstream"])
        self.assertNotIn("sourceSha256", INTEGRATION)

        patch = INTEGRATION.get("compatibilityPatch")
        if patch is not None:
            patch_path = Path(__file__).parents[2] / patch["path"]
            self.assertEqual(hashlib.sha256(patch_path.read_bytes()).hexdigest(), patch["sha256"])
            self.assertTrue(patch["reason"])
            self.assertIn("graphify_engine_contract.py", patch["removeWhen"])

    def test_every_upstream_capability_is_classified(self):
        inventory = set(INTEGRATION["upstreamCapabilities"])
        classified = {item["id"]: item for item in INTEGRATION["capabilities"]}
        self.assertEqual(inventory, set(classified))
        self.assertEqual(len(INTEGRATION["upstreamCapabilities"]), len(inventory))
        for capability in inventory:
            with self.subTest(capability=capability):
                self.assertIn(
                    classified[capability]["status"],
                    {"adopted", "implemented-differently", "deferred", "rejected"},
                )
                self.assertTrue(classified[capability]["note"])

    def test_installed_engine_satisfies_behavior_contract(self):
        result = run_contract()
        self.assertTrue(result["deterministic"])
        self.assertEqual(result["types"], 7)
        self.assertEqual(result["functions"], 7)

    def test_agent_environment_cannot_override_the_integration_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            hostile = Path(tmp) / "hostile.json"
            hostile.write_text(
                json.dumps({"schemaVersion": 2, "package": {"version": "999.0.0"}}),
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"NANOCLAW_GRAPHIFY_MANIFEST": str(hostile)}):
                gateway = load_gateway()
            self.assertEqual(gateway.GRAPHIFY_VERSION, VERSION)


if __name__ == "__main__":
    unittest.main()
