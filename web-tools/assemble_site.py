"""Assemble the static website from the checked-in interface and prepared data."""

import argparse
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import tempfile


ROOT = Path(__file__).resolve().parent.parent
MARKER = 'name="school-viewer-bootstrap"'
PAGES_MAX_BYTES = 1_000_000_000


def safe_name(value):
    if (not isinstance(value, str) or not value or "\\" in value
            or PurePosixPath(value).is_absolute() or PureWindowsPath(value).drive
            or any(part in {"", ".", ".."} for part in value.split("/"))):
        raise ValueError("Unsafe website path")
    return value


def records(items):
    if not isinstance(items, list):
        raise ValueError("Website inventory must be a list")
    result = {}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Invalid website inventory record")
        name = safe_name(item.get("path"))
        digest, size = item.get("sha256"), item.get("bytes")
        if (name in result or not isinstance(digest, str) or len(digest) != 64
                or any(char not in "0123456789abcdef" for char in digest)
                or type(size) is not int or size < 0):
            raise ValueError("Invalid or duplicate website inventory record")
        result[name] = item
    return result


def read_checked(root, relative, expected):
    name = safe_name(relative)
    path = (root / PurePosixPath(name)).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError("Missing or unsafe website input: " + name)
    data = path.read_bytes()
    if len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
        raise ValueError("Website input differs from its inventory: " + name)
    return data


def render_index(source, bootstrap):
    text = source.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    if text.count("</head>") != 1 or MARKER in text:
        raise ValueError("Expected an unmodified interface template")
    name = safe_name(bootstrap["path"])
    marker = (f'<meta {MARKER} content="../../{html.escape(name, quote=True)}" '
              f'data-sha256="{bootstrap["sha256"]}" data-bytes="{bootstrap["bytes"]}">\n')
    return text.replace("</head>", marker + "</head>").encode("utf-8")


def register_column(table, field):
    column = table["columns"][table["fields"].index(field)]
    count = table["row_count"]
    if set(column) == {"constant"}:
        return [column["constant"]] * count
    if set(column) == {"values"} and len(column["values"]) == count:
        return column["values"]
    if set(column) == {"dictionary", "indices"} and len(column["indices"]) == count:
        values = column["dictionary"]
        if all(type(i) is int and 0 <= i < len(values) for i in column["indices"]):
            return [values[i] for i in column["indices"]]
    raise ValueError("Invalid register column: " + field)


def school_counts(school_key, school, load_block):
    addresses = {"current": set(), "historical": set()}
    rows = {"current": 0, "historical": 0}
    for ref in school["blocks"].values():
        block = load_block(ref)
        if block["school_key"] != school_key:
            raise ValueError("Register block belongs to a different school: " + school_key)
        table = block["table"]
        for current, address, fallback in zip(*(register_column(table, field)
                                                for field in ("is_current", "address_key", "address_id"))):
            period = "current" if current == "yes" else "historical"
            rows[period] += 1
            if address or fallback:
                addresses[period].add(address or fallback)
    if sum(rows.values()) != school["rows"]:
        raise ValueError("School row count differs from its register blocks: " + school_key)
    return {**{k + "_assignment_rows": n for k, n in rows.items()},
            **{k + "_address_count": len(ids) for k, ids in addresses.items()}}


def verify_delivery(root, published, bootstrap):
    """Follow the same root-relative and manifest-relative links as the browser."""
    used = set()

    def include(ref, base=""):
        path = base + safe_name(ref["path"])
        if published.get(path) != {**ref, "path": path}:
            raise ValueError("Missing or mismatched active website file: " + path)
        used.add(path)
        return path

    def load(ref, base=""):
        path = include(ref, base)
        return json.loads(read_checked(root, path, published[path]))

    def manifest_base(ref):
        parent, separator, _ = ref["path"].rpartition("/")
        return parent + separator

    boot = load(bootstrap)
    map_ref = boot["map_display"]["manifest"]
    register_ref = boot["register_data"]["manifest"]
    map_data = load(map_ref)
    map_base = manifest_base(map_ref)
    metadata = load(map_data["metadata"], map_base)
    tiles = load(map_data["tile_index"], map_base)
    include(map_data["empty_tile"], map_base)
    for tile in tiles["tiles"].values():
        include(tile, map_base)

    scopes = load(boot["area_scope_index"]["manifest"])
    if (scopes["map_sha256"] != map_ref["sha256"]
            or scopes["register_sha256"] != register_ref["sha256"]):
        raise ValueError("Area scope references a different map or register")
    districts = {item["name"]: item["slug"] for item in boot["districts"]}
    if set(districts) != set(scopes["districts"]):
        raise ValueError("District coverage differs between bootstrap and area index")
    features = metadata["features"]
    covered = set()
    for district, ref in scopes["districts"].items():
        index = load(ref)
        if index["district"] != district:
            raise ValueError("Area index belongs to a different district: " + district)
        for fid, area in index["areas"].items():
            props = features.get(fid, {}).get("properties", {})
            members = (props.get("shared_member_school_keys") or props.get("school_key", "")).split("|")
            if (props.get("district") != district or area["kind"] != props.get("shared_kind", "exclusive")
                    or set(area["members"]) != {key.strip() for key in members}):
                raise ValueError("Map and address index disagree about area: " + fid)
            covered.add(fid)
    if covered != set(features):
        raise ValueError("Map area absent from the address index: " + min(set(features) - covered))

    register = load(register_ref)
    reg_base = manifest_base(register_ref)
    search = load(register["search"], reg_base)
    details = load(register["details"], reg_base)
    if set(search["districts"]) != set(districts.values()) or set(details["districts"]) != set(districts.values()):
        raise ValueError("District coverage differs between bootstrap and register")
    router = load(search["router"], reg_base)
    for refs in (router["prefixes"], details["region_prefixes"], details["territories"]):
        for ref in refs.values():
            include(ref, reg_base)
    summaries = {}
    for row in boot["schools"]:
        number = str(row.get("school_number") or "").strip().removeprefix("№").strip()
        if row["district"] and number:
            key = row["district"] + "::" + number
        else:
            key = row.get("school_id") or row.get("all_school_id")
            if not key and row.get("osm_id"):
                key = f"osm::{row.get('osm_type') or ''}::{row['osm_id']}"
        if not key:
            raise ValueError("Missing school identity in website bootstrap")
        if key in summaries:
            raise ValueError("Duplicate school in website bootstrap: " + key)
        summaries[key] = row
    updated = 0
    for slug in districts.values():
        index = load(search["districts"][slug], reg_base)
        district = load(details["districts"][slug], reg_base)
        for refs in (index["postings"], index["cards"], district["addresses"]):
            for ref in refs.values():
                include(ref, reg_base)
        for key, school_ref in district["school_index"].items():
            school = load(school_ref, reg_base)
            if key != school["school_key"] or key not in summaries:
                raise ValueError("School identity differs between register and bootstrap: " + key)
            row = summaries.pop(key)
            counts = school_counts(key, school, lambda ref: load(ref, reg_base))
            if any(int(row[field] or 0) != count for field, count in counts.items()):
                row.update({field: str(count) for field, count in counts.items()})
                updated += 1
    if summaries:
        raise ValueError("School absent from register: " + min(summaries))

    pages_ref = boot["source_pages"]["manifest"]
    pages = load(pages_ref)
    pages_base = manifest_base(pages_ref)
    for doc in pages["documents"].values():
        for page in load(doc["manifest"], pages_base)["pages"].values():
            for rendition in page["renditions"].values():
                include(rendition["asset"], pages_base)
    extra = {p for p in published if not p.startswith("app/static/")} - used - {".nojekyll", "index.html"}
    if extra:
        raise ValueError("Unreferenced files in the public delivery: " + min(extra))
    return boot, updated


def assemble(root, output, *, built_at=None):
    root, output = Path(root).resolve(), Path(output).resolve()
    if output == root or output.is_relative_to(root / "app") or output.is_relative_to(root / "site-data"):
        raise ValueError("Website output must be separate from its inputs")
    if output.exists():
        raise ValueError("Website output already exists")
    manifest_path = root / "web-tools/site-manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get("schema") != 1:
        raise ValueError("Unsupported website inventory")
    source = records(manifest.get("frontend_inputs"))
    published = records(manifest.get("public_files"))
    if (not source or not published or "app/static/index.html" not in source
            or any(not name.startswith("app/static/") for name in source)
            or set(source) != {name for name in published if name.startswith("app/static/")}):
        raise ValueError("Website interface inventory differs from the published site")
    bootstrap = manifest.get("bootstrap")
    if not isinstance(bootstrap, dict):
        raise ValueError("Missing website bootstrap")
    bootstrap_name = safe_name(bootstrap.get("path"))
    if published.get(bootstrap_name) != bootstrap:
        raise ValueError("Website bootstrap differs from the published inventory")

    # Snapshot the interface before checking the package. School counters are
    # presentation metadata derived from the same register served by the site.
    frontend = {}
    frontend_refs = []
    for name, original in sorted(source.items()):
        path = (root / PurePosixPath(name)).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError("Missing or unsafe website input: " + name)
        data = path.read_bytes()
        frontend[name] = data
        frontend_refs.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    changed = any(source[ref["path"]]["sha256"] != ref["sha256"]
                  or source[ref["path"]]["bytes"] != ref["bytes"] for ref in frontend_refs)
    payload, updated_schools = verify_delivery(root / "site-data", published, bootstrap)
    new_bootstrap = None
    if changed or updated_schools:
        try:
            date = datetime.fromisoformat(built_at.replace("Z", "+00:00")) if built_at else None
            if date is None or date.utcoffset() is None:
                raise ValueError("Missing timezone")
            build_date = date.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        except (TypeError, ValueError) as exc:
            raise ValueError("A timezone-aware build time is required for changed website assets") from exc
        refs = (json.dumps(frontend_refs, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
        frontend_sha = hashlib.sha256(refs).hexdigest()
        payload["build_info"] = {"schema": 1, "version": "build-" + frontend_sha[:12],
                                 "version_basis": "frontend_sha256", "frontend_sha256": frontend_sha,
                                 "built_at": build_date}
        new_bootstrap = (json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
        new_sha = hashlib.sha256(new_bootstrap).hexdigest()
        new_ref = {"path": "bootstrap." + new_sha + ".json", "bytes": len(new_bootstrap), "sha256": new_sha}
        if new_ref["path"] in published and new_ref["path"] != bootstrap_name:
            raise ValueError("Refreshed bootstrap collides with another website file")
        del published[bootstrap_name]
        published[new_ref["path"]] = new_ref
        bootstrap = new_ref
        for name, data in frontend.items():
            if name == "app/static/index.html":
                data = render_index(data, bootstrap)
            published[name] = {"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}

    total_bytes = sum(item["bytes"] for item in published.values())
    if total_bytes > PAGES_MAX_BYTES:
        raise ValueError(f"Website exceeds the GitHub Pages size limit: {total_bytes} bytes")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="dom-shkola-", dir=output.parent) as tmp:
        prepared = Path(tmp) / "site"
        prepared.mkdir()
        for name, expected in published.items():
            if new_bootstrap is not None and name == bootstrap["path"]:
                data = new_bootstrap
            elif name in frontend:
                data = frontend[name]
                if name == "app/static/index.html":
                    data = render_index(data, bootstrap)
            else:
                data = read_checked(root / "site-data", name, expected)
            if len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
                raise ValueError("Website output differs from its inventory: " + name)
            destination = prepared / PurePosixPath(name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            written = destination.read_bytes()
            if len(written) != expected["bytes"] or hashlib.sha256(written).hexdigest() != expected["sha256"]:
                raise ValueError("Website output readback failed: " + name)
        if manifest_path.read_bytes() != manifest_bytes:
            raise ValueError("Website inventory changed during assembly")
        for name, data in frontend.items():
            if (root / PurePosixPath(name)).read_bytes() != data:
                raise ValueError("Website interface changed during assembly: " + name)
        if output.exists():
            raise ValueError("Website output appeared during assembly")
        prepared.rename(output)
    return {"files": len(published), "bytes": total_bytes,
            "frontend_changed": changed, "school_counts_updated": updated_schools}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=ROOT)
    parser.add_argument("--built-at", help="timezone-aware build time, required when interface files changed")
    args = parser.parse_args()
    print(json.dumps(assemble(args.source, args.output, built_at=args.built_at), sort_keys=True))
