"""Small independent checks for safe, reproducible website assembly."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import assemble_site
from assemble_site import assemble


def record(path, data):
    return {"path": path, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


class WebsiteAssemblyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "input"
        (self.root / "web-tools").mkdir(parents=True)
        (self.root / "app/static").mkdir(parents=True)
        (self.root / "site-data").mkdir()
        self.output = Path(self.tmp.name) / "output"
        template = b"<html><head></head><body>Test</body></html>\n"
        bootstrap = b'{"schema":1}\n'
        (self.root / "app/static/index.html").write_bytes(template)
        (self.root / "site-data/bootstrap.json").write_bytes(bootstrap)
        (self.root / "site-data/.nojekyll").write_bytes(b"")
        meta = record("bootstrap.json", bootstrap)
        marker = (f'<meta name="school-viewer-bootstrap" content="../../bootstrap.json" '
                  f'data-sha256="{meta["sha256"]}" data-bytes="{meta["bytes"]}">\n').encode()
        rendered = template.replace(b"</head>", marker + b"</head>")
        self.manifest = {"schema": 1, "bootstrap": meta,
                         "frontend_inputs": [record("app/static/index.html", template)],
                         "public_files": [meta, record(".nojekyll", b""), record("app/static/index.html", rendered)]}
        self.save_manifest()

    def save_manifest(self):
        (self.root / "web-tools/site-manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def test_assembles_the_exact_website(self):
        result = assemble(self.root, self.output)
        self.assertEqual(result["files"], 3)
        self.assertEqual((self.output / "bootstrap.json").read_bytes(), b'{"schema":1}\n')
        self.assertIn(b'name="school-viewer-bootstrap"', (self.output / "app/static/index.html").read_bytes())
        self.assertEqual((self.output / ".nojekyll").read_bytes(), b"")

    def test_changed_data_are_rejected_without_publishing_output(self):
        (self.root / "site-data/bootstrap.json").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "differs from its inventory"):
            assemble(self.root, self.output)
        self.assertFalse(self.output.exists())

    def test_changed_frontend_needs_a_build_time(self):
        (self.root / "app/static/index.html").write_bytes(b"<head></head>different")
        with self.assertRaisesRegex(ValueError, "build time is required"):
            assemble(self.root, self.output)
        self.assertFalse(self.output.exists())

    def test_changed_frontend_updates_only_bootstrap_and_interface(self):
        (self.root / "app/static/index.html").write_bytes(b"<head></head>changed")
        result = assemble(self.root, self.output, built_at="2026-11-08T12:00:00+03:00")
        self.assertTrue(result["frontend_changed"])
        bootstraps = list(self.output.glob("bootstrap.*.json"))
        self.assertEqual(len(bootstraps), 1)
        payload = json.loads(bootstraps[0].read_bytes())
        self.assertEqual(payload["build_info"]["built_at"], "2026-11-08T09:00:00Z")
        self.assertEqual(payload["schema"], 1)
        self.assertEqual(hashlib.sha256(bootstraps[0].read_bytes()).hexdigest(),
                         bootstraps[0].name.split(".")[1])
        self.assertIn(bootstraps[0].name.encode(), (self.output / "app/static/index.html").read_bytes())
        self.assertEqual((self.output / ".nojekyll").read_bytes(), b"")
        self.assertFalse((self.output / "bootstrap.json").exists())

    def test_rejects_invalid_build_time(self):
        (self.root / "app/static/index.html").write_bytes(b"<head></head>changed")
        with self.assertRaisesRegex(ValueError, "build time is required"):
            assemble(self.root, self.output, built_at="2026-11-08")
        self.assertFalse(self.output.exists())

    def test_rejects_a_frontend_change_during_assembly(self):
        original = assemble_site.read_checked

        def changed(root, relative, expected):
            data = original(root, relative, expected)
            (self.root / "app/static/index.html").write_bytes(b"changed during assembly")
            return data

        with patch("assemble_site.read_checked", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "interface changed during assembly"):
                assemble(self.root, self.output)
        self.assertFalse(self.output.exists())

    def test_does_not_overwrite_existing_output(self):
        self.output.mkdir()
        with self.assertRaisesRegex(ValueError, "already exists"):
            assemble(self.root, self.output)

    def test_rejects_unsafe_paths(self):
        self.manifest["public_files"].append(record("../outside", b"x"))
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "Unsafe website path"):
            assemble(self.root, self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
