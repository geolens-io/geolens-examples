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

`--bump X.Y.Z` rewrites every pin this script can see to that version and then
runs the same check, so the bump and the check can never disagree about what a
pin is. The release dispatch workflow uses it to open the pin-bump pull request,
with a token that may not change anything under .github/workflows, which is why
a pin there fails this check.

Run with: uv run ci/check-pins.py [--bump X.Y.Z]
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
# Skipped by path *relative to the repo*, so a checkout under a directory that
# happens to be called assets or node_modules is still scanned. .claude holds
# local agent worktrees and ci/diagnostics holds pages saved from failed local
# sweeps; neither exists in CI and both can carry versions nobody wrote here.
SKIP = {".git", ".claude", "node_modules", "assets", "diagnostics"}

# One pattern per published GeoLens client, in the exact form each file uses,
# plus the human-facing labels that name the same version without pinning
# anything: a README cell like `geolens` 1.14.0, or a gallery card's tool
# string "geolens-cli 1.14.0". A bump that misses one of those leaves the docs
# saying one thing and the installs doing another, which is the drift this
# script exists to catch. The label form is anchored to a quote or backtick
# right before the name, which is how every label here is written and how
# ordinary prose ("used geolens 1.13.0 before the bump") is not, so history
# and provenance notes do not read as pins.
PATTERNS = [
    re.compile(r"\bgeolens==(\d+\.\d+\.\d+)"),  # python/sdk-catalog.py, PEP 723
    re.compile(r"@geolens/sdk@(\d+\.\d+\.\d+)"),  # esm.sh import, npm docs
    re.compile(r"\bgeolens-mcp@(\d+\.\d+\.\d+)"),  # uvx spec
    re.compile(r"\bgeolens-cli[@=]=?(\d+\.\d+\.\d+)"),  # uvx --from spec
    re.compile(r'(?<=["`])(?:@geolens/sdk|geolens(?:-cli|-mcp)?)`? (\d+\.\d+\.\d+)'),  # display labels
]


def scanned() -> list[Path]:
    """The files pins live in, in path order."""
    me = Path(__file__).resolve()
    return [
        path
        for path in sorted(REPO.rglob("*"))
        # this file talks about versions without pinning one
        if path != me and path.suffix in SUFFIXES and not SKIP & set(path.relative_to(REPO).parts)
    ]


def pins() -> list[tuple[str, str, str]]:
    """Every (location, matched text, version) pin in the repo, in path order."""
    found = []
    for path in scanned():
        text = path.read_text(encoding="utf-8", errors="ignore")
        for lineno, line in enumerate(text.splitlines(), 1):
            for pattern in PATTERNS:
                for match in pattern.finditer(line):
                    location = f"{path.relative_to(REPO)}:{lineno}"
                    found.append((location, match.group(0), match.group(1)))
    return found


# The workflow token cannot push a change to these, so the release workflow
# could never land a bump that touched one.
UNBUMPABLE = ".github/workflows/"


def bump(version: str) -> list[str]:
    """Rewrite every pin to `version` in place and return the files that changed.

    Only the version inside each match changes, so a display label keeps its
    backtick and an esm.sh URL keeps its path. Files are read and written with
    newline="" so their line endings survive.
    """
    changed = []
    for path in scanned():
        with open(path, encoding="utf-8", newline="") as handle:
            text = handle.read()
        new = text
        for pattern in PATTERNS:
            new = pattern.sub(lambda m: m.group(0).replace(m.group(1), version), new)
        if new != text:
            with open(path, "w", encoding="utf-8", newline="") as handle:
                handle.write(new)
            changed.append(str(path.relative_to(REPO)))
    return changed


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
    if sys.argv[1:2] == ["--bump"]:
        target = sys.argv[2] if len(sys.argv) == 3 else ""
        # [0-9], not \d, which also matches digits from other scripts.
        if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", target) is None:
            print(f"usage: check-pins.py --bump X.Y.Z (got {sys.argv[2:]})")
            return 2
        before = sorted({version for _, _, version in pins()})
        print(f"bumping {', '.join(before) or 'nothing'} to {target}")
        for name in bump(target):
            print(f"  bumped {name}")
    elif sys.argv[1:]:
        print(f"usage: check-pins.py [--bump X.Y.Z] (got {sys.argv[1:]})")
        return 2

    found = pins()
    if not found:
        print(f"FAIL: no GeoLens client pin matched anywhere under {REPO}")
        return 1

    for location, text, _ in found:
        print(f"  {location}  {text}")

    stuck = [location for location, _, _ in found if location.startswith(UNBUMPABLE)]
    if stuck:
        print(
            f"\nFAIL: {', '.join(stuck)} pin a GeoLens client inside {UNBUMPABLE}, which the release "
            "workflow's token cannot push to. Read the version from a file outside it, as verify.yml "
            "does with cli/github-actions.yml."
        )
        return 1

    versions = {version for _, _, version in found}
    if len(versions) > 1:
        print(f"\nFAIL: pins disagree ({', '.join(sorted(versions))}); make them one version")
        return 1
    pinned = versions.pop()

    demo = demo_version()
    if demo is None:
        return 0
    if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", demo) is None:
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
