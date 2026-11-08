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

    # UI edits do not invalidate the prepared register, map or document pages.
    # A changed interface gets a new bootstrap containing only fresh build info.
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
    new_bootstrap = None
    if changed:
        try:
            date = datetime.fromisoformat(built_at.replace("Z", "+00:00")) if built_at else None
            if date is None or date.utcoffset() is None:
                raise ValueError("Missing timezone")
            build_date = date.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        except (TypeError, ValueError) as exc:
            raise ValueError("A timezone-aware build time is required for changed UI assets") from exc
        bootstrap_data = read_checked(root / "site-data", bootstrap_name, bootstrap)
        payload = json.loads(bootstrap_data)
        if not isinstance(payload, dict):
            raise ValueError("Website bootstrap must be an object")
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
    return {"files": len(published), "bytes": sum(item["bytes"] for item in published.values()),
            "frontend_changed": changed}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=ROOT)
    parser.add_argument("--built-at", help="timezone-aware build time, required when interface files changed")
    args = parser.parse_args()
    print(json.dumps(assemble(args.source, args.output, built_at=args.built_at), sort_keys=True))
