"""Produit des builds Chrome, Chromium, Edge et Firefox dans dist/.

Usage : python3 build.py
"""
import json, shutil, zipfile
from pathlib import Path

ROOT = Path(__file__).parent
DIST = ROOT / "dist"
INCLUDE = ["src", "lib", "popup", "icons"]
base = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
bg = "src/background.js"

def firefox(m):
    m["background"] = {"scripts": [bg]}
    gecko = m.setdefault("browser_specific_settings", {}).setdefault("gecko", {})
    gecko["strict_min_version"] = "140.0"
    gecko["data_collection_permissions"] = {"required": ["none"]}
    m["browser_specific_settings"]["gecko_android"] = {"strict_min_version": "142.0"}
    return m

def chromium_family(m):
    m["background"] = {"service_worker": bg}
    m.pop("browser_specific_settings", None)
    return m

def build(name, adapt):
    out = DIST / name
    for d in INCLUDE:
        shutil.copytree(ROOT / d, out / d)
    manifest = adapt(json.loads(json.dumps(base)))
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    zpath = DIST / f"chatgpt-export-{name}-{base['version']}.zip"
    archive_root = zpath.stem
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
        for f in sorted(out.rglob("*")):
            if f.is_file():
                relative = f.relative_to(out).as_posix()
                z.write(f, f"{archive_root}/{relative}")
    print("OK", zpath.name)

    # Store uploads must contain manifest.json at the archive root. Keep these
    # separate from the versioned GitHub release archives, which have a folder prefix.
    store_names = {
        "chrome": "chrome-web-store",
        "edge": "edge-addons",
        "firefox": "firefox-amo",
    }
    if name in store_names:
        store_path = DIST / f"chatgpt-export-{store_names[name]}-{base['version']}.zip"
        with zipfile.ZipFile(store_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
            for f in sorted(out.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(out).as_posix())
        print("OK", store_path.name)

shutil.rmtree(DIST, ignore_errors=True)
DIST.mkdir(parents=True, exist_ok=True)
for name, adapt in (
    ("chrome", chromium_family),
    ("chromium", chromium_family),
    ("edge", chromium_family),
    ("firefox", firefox),
):
    build(name, adapt)
