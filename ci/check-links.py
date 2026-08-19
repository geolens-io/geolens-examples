# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Check that every outbound link from this repo to the docs site, the marketing
site and the geolens GitHub repos still resolves, anchor included.

The examples link docs routes and geolens source paths by absolute URL, and
nothing on the other side knows they do: a docs page renamed or a file moved
in geolens leaves a dead link here that no build notices and a reader finds
first. So this greps the repo for every such URL, asks each page once, and
fails on anything that does not answer 2xx after redirects.

A docs or marketing link with a #fragment is also checked for the anchor: the
page body is read once and must carry id="<fragment>", since a renamed
heading dead-ends the link as surely as a renamed route does. GitHub links
skip that check; their fragments (#L12, #readme) are client-side.

Links into this repo's own `main` are checked against the checkout instead of
over the network. A pull request that adds an example and links it from the
README links a page GitHub cannot serve until the merge, and failing on that
would block every new-example PR. Whether the path exists here is the question
GitHub will answer once the branch lands. The gallery's "View source" links
are composed at runtime from each card's `source` path, so those are composed
the same way here and checked with the rest.

The demo is not checked here: its dataset and map IDs are fixtures, and
ci/check-fixtures.mjs is the script that knows what each one must answer.

Run with: uv run ci/check-links.py
"""

import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SELF = "https://github.com/geolens-io/geolens-examples/"
ANCHOR_HOSTS = {"getgeolens.com", "docs.getgeolens.com"}
# index.html builds each card's "View source" href as REPO + ex.source at
# runtime, so the URL never appears in the file and the scan below cannot see
# it. The card's `source` value does, in exactly this form.
GALLERY = REPO / "index.html"
SOURCE = re.compile(r'\bsource: "([^"]+)"')

# Same file types and the same skip list as check-pins.py: assets and
# diagnostics carry saved third-party pages, .claude holds local worktrees.
SUFFIXES = {".py", ".md", ".html", ".json", ".yml", ".yaml", ".mjs", ".js", ".ts"}
SKIP = {".git", ".claude", "node_modules", "assets", "diagnostics"}

# A URL runs until whitespace or a character that closes a Markdown link, an
# HTML attribute, a code span or a string literal. Trailing sentence
# punctuation and emphasis markers are peeled off afterwards, since
# "see https://.../cli/." is a link followed by a full stop, not a link
# ending in one, and **https://...** is a link in bold. demo.getgeolens.com
# does not match: the host is exactly getgeolens.com or docs.getgeolens.com.
STOP = r"""[^\s<>"'`)\]}\\]*"""
PATTERNS = [
    re.compile(r"https://(?:docs\.)?getgeolens\.com" + STOP),
    re.compile(r"https://github\.com/geolens-io/(?:geolens|geolens-examples)/(?:blob|tree|issues|pull)\b" + STOP),
]
TRAILING = ".,;:!?*"

# The demo's CDN answers the default urllib agent with 403, so say who is
# calling, the way check-pins.py does.
HEADERS = {"User-Agent": "geolens-examples/check-links"}
TIMEOUT = 20  # seconds per request
BUDGET = 120  # seconds for the whole run; a hung host should not eat the job
# One more try after a short gap for the answers that say nothing about the
# link: a 429, a 5xx, a timeout or a dropped connection. A 404 is asked once,
# since asking the same wrong question again does not help.
RETRY_GAP = 2  # seconds, unless Retry-After names a longer one


def links():
    """Every page URL this script checks, mapped to its locations and the
    fragments those locations ask for: {page: {"where": [...], "anchors": {fragment: [...]}}}."""
    found = {}
    me = Path(__file__).resolve()
    for path in sorted(REPO.rglob("*")):
        if path == me:
            continue  # the patterns above would match themselves
        if path.suffix not in SUFFIXES or SKIP & set(path.relative_to(REPO).parts):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for lineno, line in enumerate(text.splitlines(), 1):
            for pattern in PATTERNS:
                for match in pattern.finditer(line):
                    page, _, fragment = match.group(0).rstrip(TRAILING).partition("#")
                    location = f"{path.relative_to(REPO)}:{lineno}"
                    entry = found.setdefault(page, {"where": [], "anchors": {}})
                    entry["where"].append(location)
                    if fragment:
                        entry["anchors"].setdefault(fragment, []).append(location)
    if GALLERY.exists():
        for lineno, line in enumerate(GALLERY.read_text(encoding="utf-8").splitlines(), 1):
            for match in SOURCE.finditer(line):
                page = SELF + "blob/main/" + match.group(1)
                found.setdefault(page, {"where": [], "anchors": {}})["where"].append(f"index.html:{lineno}")
    return found


def local_target(url):
    """The repo path a link into this repo's own main refers to, or None for any other URL."""
    match = re.fullmatch(re.escape(SELF) + r"(?:blob|tree)/main/?([^?]*)(?:\?.*)?", url)
    return REPO / match.group(1) if match else None


def fetch(url, want_body):
    """(status after redirects or a short error, body text or None), with one retry on a transient failure."""
    request = urllib.request.Request(url, headers=HEADERS)
    verdict = None
    for attempt in (1, 2):
        gap = RETRY_GAP
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                body = response.read().decode("utf-8", errors="ignore") if want_body else None
                return response.status, body
        except urllib.error.HTTPError as err:
            verdict = err.code
            again = err.code in (408, 429) or err.code >= 500
            after = err.headers.get("Retry-After", "")
            if after.isdigit():
                gap = min(int(after), 30)
        except (urllib.error.URLError, OSError) as err:
            verdict = f"error: {getattr(err, 'reason', err)}"
            again = True  # a timeout, a reset, a DNS hiccup
        if attempt == 2 or not again:
            break
        time.sleep(gap)
    return verdict, None


def main():
    found = links()
    if not found:
        print(f"FAIL: no docs, marketing or geolens GitHub link found anywhere under {REPO}")
        return 1

    failures = []
    started = time.monotonic()
    checked_live = 0
    for page in sorted(found):
        entry = found[page]
        target = local_target(page)
        if target is not None:
            ok = target.exists()
            verdict = "in checkout" if ok else "no such path"
            body = None
        elif time.monotonic() - started > BUDGET:
            ok, verdict, body = False, f"not checked: the {BUDGET}s budget ran out", None
        else:
            checked_live += 1
            host = urllib.parse.urlsplit(page).hostname
            verdict, body = fetch(page, want_body=host in ANCHOR_HOSTS and bool(entry["anchors"]))
            ok = isinstance(verdict, int) and 200 <= verdict < 300
        print(f"  {str(verdict):<12}{page}")
        if not ok:
            failures.append((page, verdict, entry["where"]))
            continue
        # Anchors are checked only on a page that was read; a page that failed
        # above already reports every location, fragment or not.
        if body is None:
            continue
        for fragment, where in sorted(entry["anchors"].items()):
            if re.search(r'\bid="' + re.escape(fragment) + '"', body):
                print(f"  {'anchor ok':<12}{page}#{fragment}")
            else:
                print(f"  {'no anchor':<12}{page}#{fragment}")
                failures.append((f"{page}#{fragment}", f'no id="{fragment}" on the page', where))

    if failures:
        print(f"\nFAIL: {len(failures)} link(s) failed")
        for url, verdict, where in failures:
            print(f"  {url} -> {verdict}")
            for location in where:
                print(f"      {location}")
        return 1
    anchors = sum(len(entry["anchors"]) for entry in found.values())
    print(
        f"\nall {len(found)} links resolve ({checked_live} checked live, {len(found) - checked_live} against this checkout, "
        f"{anchors} anchor(s) found on their pages)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
