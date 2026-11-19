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
        assets = []

        def asset(path, value, base=""):
            data = json.dumps(value).encode()
            target = self.root / "site-data" / base / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            assets.append(record(base + path, data))
            return record(path, data)

        tile = asset("tiles/one.pbf", "tile", "map/")
        tiles = asset("tiles.json", {"tiles": {"8/148/74": tile}}, "map/")
        props = {"school_key": "D::1", "district": "D"}
        metadata = asset("metadata.json", {"features": {"D::1": {"properties": props}}}, "map/")
        map_ref = asset("map/manifest.json", {"metadata": metadata, "empty_tile": tile, "tile_index": tiles})
        router = asset("router.json", {"prefixes": {}}, "register/")
        district_search = asset("district-search.json", {"cards": {}, "postings": {}}, "register/")
        search = asset("search.json", {"districts": {"d": district_search}, "router": router}, "register/")
        block = asset("school-block.json", {"school_key": "D::1", "table": {
            "row_count": 3, "fields": ["is_current", "address_key", "address_id"], "columns": [
                {"dictionary": ["yes", "no"], "indices": [0, 0, 1]}, {"constant": ""},
                {"values": ["a", "a", "b"]}]}}, "register/")
        school = asset("school.json", {"school_key": "D::1", "rows": 3, "blocks": {"0": block}}, "register/")
        district_details = asset("district-details.json", {"addresses": {}, "school_index": {"D::1": school}}, "register/")
        details = asset("details.json", {"districts": {"d": district_details}, "region_prefixes": {},
                                         "territories": {}}, "register/")
        register = asset("register/manifest.json", {"search": search, "details": details})
        district = asset("area-scopes/d.json", {"district": "D", "areas": {"D::1": {
            "kind": "exclusive", "members": ["D::1"]}}})
        scope = asset("area-scopes/manifest.json", {"districts": {"D": district},
                      "map_sha256": map_ref["sha256"], "register_sha256": register["sha256"]})
        pages = asset("documents/manifest.json", {"documents": {}})
        bootstrap = json.dumps({"schema": 1, "districts": [{"name": "D", "slug": "d"}], "schools": [{
                                "district": "D", "school_number": "1", "current_address_count": "1",
                                "current_assignment_rows": "2", "historical_address_count": "1",
                                "historical_assignment_rows": "1"}],
                                "map_display": {"manifest": map_ref}, "area_scope_index": {"manifest": scope},
                                "source_pages": {"manifest": pages}, "register_data": {"manifest": register}}).encode()
        self.bootstrap_bytes = bootstrap
        (self.root / "app/static/index.html").write_bytes(template)
        (self.root / "site-data/bootstrap.json").write_bytes(bootstrap)
        (self.root / "site-data/.nojekyll").write_bytes(b"")
        meta = record("bootstrap.json", bootstrap)
        marker = (f'<meta name="school-viewer-bootstrap" content="../../bootstrap.json" '
                  f'data-sha256="{meta["sha256"]}" data-bytes="{meta["bytes"]}">\n').encode()
        rendered = template.replace(b"</head>", marker + b"</head>")
        self.manifest = {"schema": 1, "bootstrap": meta,
                         "frontend_inputs": [record("app/static/index.html", template)],
                         "public_files": [meta, record(".nojekyll", b""), record("app/static/index.html", rendered), *assets]}
        self.save_manifest()

    def save_manifest(self):
        (self.root / "web-tools/site-manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def test_assembles_the_exact_website(self):
        result = assemble(self.root, self.output)
        self.assertEqual(result["files"], len(self.manifest["public_files"]))
        self.assertEqual((self.output / "bootstrap.json").read_bytes(), self.bootstrap_bytes)
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

    def test_rejects_referenced_tile_omitted_from_inventory(self):
        self.manifest["public_files"] = [r for r in self.manifest["public_files"] if r["path"] != "map/tiles/one.pbf"]
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "active website file: map/tiles/one.pbf"):
            assemble(self.root, self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_orphan_from_old_release(self):
        self.manifest["public_files"].append(record("register/obsolete.json", b"{}"))
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "Unreferenced files"):
            assemble(self.root, self.output)

    def check_invalid_area(self, areas, error):
        files = {r["path"]: r for r in self.manifest["public_files"]}
        spec = json.loads(self.bootstrap_bytes)
        folder = self.root / "site-data"
        def replace(name, value):
            data = json.dumps(value).encode()
            (folder / name).write_bytes(data)
            files[name] = record(name, data)
            return files[name]
        scope = json.loads((folder / "area-scopes/manifest.json").read_bytes())
        scope["districts"]["D"] = replace("area-scopes/d.json", {"district": "D", "areas": areas})
        spec["area_scope_index"]["manifest"] = replace("area-scopes/manifest.json", scope)
        self.manifest["bootstrap"] = replace("bootstrap.json", spec)
        self.manifest["public_files"] = list(files.values())
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, error):
            assemble(self.root, self.output)

    def test_rejects_map_area_missing_from_address_index(self):
        self.check_invalid_area({}, "absent from the address index")

    def test_rejects_different_area_members_even_with_correct_checksums(self):
        self.check_invalid_area({"D::1": {"kind": "exclusive", "members": ["D::2"]}}, "disagree about area")

    def test_rejects_oversize_output(self):
        with patch.object(assemble_site, "PAGES_MAX_BYTES", 100):
            with self.assertRaisesRegex(ValueError, "GitHub Pages size limit"):
                assemble(self.root, self.output)
        self.assertFalse(self.output.exists())

    def test_derives_school_summary_from_rows_and_distinct_addresses(self):
        payload = json.loads(self.bootstrap_bytes)
        payload["schools"][0]["current_address_count"] = "9"
        data = json.dumps(payload).encode()
        (self.root / "site-data/bootstrap.json").write_bytes(data)
        self.manifest["bootstrap"] = record("bootstrap.json", data)
        self.manifest["public_files"][0] = self.manifest["bootstrap"]
        self.save_manifest()
        result = assemble(self.root, self.output, built_at="2026-11-19T12:00:00Z")
        self.assertEqual(result["school_counts_updated"], 1)
        corrected = json.loads(next(self.output.glob("bootstrap.*.json")).read_bytes())["schools"][0]
        self.assertEqual(corrected["current_address_count"], "1")
        self.assertEqual(corrected["current_assignment_rows"], "2")
        self.assertEqual(corrected["historical_address_count"], "1")


if __name__ == "__main__":
    unittest.main()
