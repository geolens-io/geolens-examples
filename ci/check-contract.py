# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Hold this repo to the facts getgeolens.com/docs-contract.json fixes for every
GeoLens surface.

The product README, the marketing pages and the docs are checked against that
contract in their own CI, and nothing checked this repo (CLAUDE.md, rule 8), so
an install line copied here could drift while every other surface stayed right.
This fetches the published contract, fails on any of its `forbidden` patterns,
and fails when something that looks like the install one-liner is not exactly
the contract's.

A contract that cannot be fetched only warns: the docs site being down is not a
fact about this repo.

Run with: uv run ci/check-contract.py
"""

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CONTRACT = "https://getgeolens.com/docs-contract.json"

# The same file types and skip list as check-pins.py and check-links.py.
SUFFIXES = {".py", ".md", ".html", ".json", ".yml", ".yaml", ".mjs", ".js", ".ts"}
SKIP = {".git", ".claude", "node_modules", "assets", "diagnostics"}

# A shell line fetching the installer, up to whatever closes it in the file: a
# code span, an HTML tag or the end of the line.
INSTALL = re.compile(r"curl [^`<\n]*getgeolens\.com/install\.sh[^`<\n]*")


def main() -> int:
    request = urllib.request.Request(CONTRACT, headers={"User-Agent": "geolens-examples/check-contract"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            contract = json.load(response)
        one_liner = contract["install"]["oneLiner"]
        forbidden = [
            (re.compile(rule["pattern"], re.I if "i" in rule.get("flags", "") else 0), rule["reason"])
            for rule in contract["forbidden"]
        ]
    except (urllib.error.URLError, OSError, ValueError, KeyError) as err:
        print(f"WARNING: could not read {CONTRACT} ({err}); nothing checked")
        return 0

    me = Path(__file__).resolve()
    problems = []
    checked = 0
    for path in sorted(REPO.rglob("*")):
        if path == me or path.suffix not in SUFFIXES or SKIP & set(path.relative_to(REPO).parts):
            continue
        checked += 1
        for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            where = f"{path.relative_to(REPO)}:{lineno}"
            for pattern, reason in forbidden:
                if pattern.search(line):
                    problems.append(f"{where}: matches the forbidden /{pattern.pattern}/: {reason}")
            for match in INSTALL.finditer(line):
                if match.group(0).strip() != one_liner:
                    problems.append(f"{where}: install line {match.group(0).strip()!r} is not {one_liner!r}")

    if problems:
        print(f"FAIL: {len(problems)} line(s) disagree with {CONTRACT} (version {contract.get('version')}):")
        for problem in problems:
            print(f"  {problem}")
        return 1
    print(f"{checked} files agree with {CONTRACT} (version {contract.get('version')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
