# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Check that every GeoLens client pin in this repo agrees, and say so when the
demo has moved past them.

The same version string is copied into a PEP 723 header, an esm.sh import, a
Claude Desktop config, three READMEs and the landing page, so the failure mode
is one of them getting bumped and the rest quietly staying behind. This greps
for all of them rather than reading a list, because a pin nobody remembered to
register is exactly the one that goes stale.

Disagreeing pins fail the build. A demo that is ahead only warns: the demo
upgrading is not a regression in this repo, it is a note that someone should
bump the pins and re-run the examples against the new release.

Run with: uv run ci/check-pins.py
"""

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HEALTH = "https://demo.getgeolens.com/api/health"

SUFFIXES = {".py", ".md", ".html", ".json", ".yml", ".yaml", ".mjs", ".js", ".ts"}
SKIP = {".git", ".claude", "node_modules", "assets"}  # .claude: local agent worktrees, never in CI

# One pattern per published GeoLens client, in the exact form each file uses.
PATTERNS = [
    re.compile(r"\bgeolens==(\d+\.\d+\.\d+)"),  # python/sdk-catalog.py, PEP 723
    re.compile(r"@geolens/sdk@(\d+\.\d+\.\d+)"),  # esm.sh import, npm docs
    re.compile(r"\bgeolens-mcp@(\d+\.\d+\.\d+)"),  # uvx spec
    re.compile(r"\bgeolens-cli[@=]=?(\d+\.\d+\.\d+)"),  # planned, not here yet
]


def pins() -> list[tuple[str, str, str]]:
    """Every (location, matched text, version) pin in the repo, in path order."""
    found = []
    for path in sorted(REPO.rglob("*")):
        if path.suffix not in SUFFIXES or SKIP & set(path.parts):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for lineno, line in enumerate(text.splitlines(), 1):
            for pattern in PATTERNS:
                for match in pattern.finditer(line):
                    location = f"{path.relative_to(REPO)}:{lineno}"
                    found.append((location, match.group(0), match.group(1)))
    return found


def demo_version() -> str | None:
    """What the demo reports it is running, or None if it could not be read."""
    # The demo sits behind a CDN that answers the default urllib agent with 403,
    # so say who is calling.
    request = urllib.request.Request(HEALTH, headers={"User-Agent": "geolens-examples/check-pins"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)["version"]
    except (urllib.error.URLError, OSError, ValueError, KeyError) as err:
        print(f"WARNING: could not read {HEALTH} ({err}); pins not compared to the demo")
        return None


def main() -> int:
    found = pins()
    if not found:
        print(f"FAIL: no GeoLens client pin matched anywhere under {REPO}")
        return 1

    for location, text, _ in found:
        print(f"  {location}  {text}")

    versions = {version for _, _, version in found}
    if len(versions) > 1:
        print(f"\nFAIL: pins disagree ({', '.join(sorted(versions))}); make them one version")
        return 1
    pinned = versions.pop()

    demo = demo_version()
    if demo is None:
        return 0
    if re.fullmatch(r"\d+\.\d+\.\d+", demo) is None:
        print(f"WARNING: demo reports version {demo!r}, which is not X.Y.Z; not compared")
        return 0

    def parts(version: str) -> tuple[int, ...]:
        return tuple(int(n) for n in version.split("."))

    if parts(demo) > parts(pinned):
        print(f"\nWARNING: the demo runs {demo}, this repo pins {pinned}. Bump the pins.")
    else:
        print(f"\npinned {pinned}, demo {demo}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
