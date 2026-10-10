"""Check the build environment and reproduce the AMO package."""
from pathlib import Path
import runpy
import sys


MINIMUM_PYTHON = (3, 10)
ROOT = Path(__file__).resolve().parent


def main() -> int:
    if sys.version_info < MINIMUM_PYTHON:
        print(
            f"Python {MINIMUM_PYTHON[0]}.{MINIMUM_PYTHON[1]} or later is required; "
            f"found {sys.version.split()[0]}.",
            file=sys.stderr,
        )
        return 2

    required = (ROOT / "build.py", ROOT / "manifest.json", ROOT / "src", ROOT / "lib", ROOT / "popup", ROOT / "icons")
    missing = [str(path.name) for path in required if not path.exists()]
    if missing:
        print("Source archive is incomplete; missing: " + ", ".join(missing), file=sys.stderr)
        return 2

    dist = ROOT / "dist"
    if dist.exists():
        print(
            "Refusing to run because dist/ already exists. Extract the source archive "
            "into a clean directory; build.py recreates dist/.",
            file=sys.stderr,
        )
        return 2

    print(f"Building with Python {sys.version.split()[0]} from {ROOT}")
    runpy.run_path(str(ROOT / "build.py"), run_name="__main__")
    version = __import__("json").loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
    package = dist / f"chatgpt-export-firefox-amo-{version}.zip"
    if not package.is_file():
        print(f"Expected AMO package was not created: {package}", file=sys.stderr)
        return 1
    print(f"Reproduced AMO package: {package}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
