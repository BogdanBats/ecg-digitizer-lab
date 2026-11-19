"""
Copies the frontend from app/static (served by FastAPI) to public/ (Firebase Hosting static build).

The two trees must stay byte-identical: public/index.html <- app/static/index.html,
public/static/{app.js,styles.css} <- app/static/, public/examples/ <- example/.

Usage:
    python tools/sync_public.py           # copy
    python tools/sync_public.py --check   # exit 1 if public/ is out of date (for CI / pre-deploy)
"""

from __future__ import annotations

import filecmp
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAIRS = [
    (ROOT / "app" / "static" / "index.html", ROOT / "public" / "index.html"),
    (ROOT / "app" / "static" / "app.js", ROOT / "public" / "static" / "app.js"),
    (ROOT / "app" / "static" / "styles.css", ROOT / "public" / "static" / "styles.css"),
]
PAIRS += [(p, ROOT / "public" / "examples" / p.name) for p in sorted((ROOT / "example").glob("*.jp*g"))]


def main() -> int:
    check_only = "--check" in sys.argv[1:]
    stale = [dst for src, dst in PAIRS if not dst.exists() or not filecmp.cmp(src, dst, shallow=False)]
    if check_only:
        for dst in stale:
            print(f"out of date: {dst.relative_to(ROOT)}")
        return 1 if stale else 0
    for src, dst in PAIRS:
        if dst in stale:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            print(f"copied {src.relative_to(ROOT)} -> {dst.relative_to(ROOT)}")
    if not stale:
        print("public/ is already up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
