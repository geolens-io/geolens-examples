# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Harvest a GeoLens catalog the way a data portal would.

Run it with no setup at all:

    uv run dcat-harvest.py

No dependencies: the feeds are JSON-LD, and a harvester only needs to read the
dataset list out of them. Anything that speaks DCAT can do the same from the
URL alone, which is the point of publishing the catalog this way.

What it does: fetches the DCAT 3 feed and the GeoDCAT-AP feed, counts the
datasets in each, checks that they list the same ones, and prints a few with
their licence and the formats they can be downloaded in. The feeds and what
each profile adds are described under
https://docs.getgeolens.com/guides/api/ogc/#dcat-catalog-feeds
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# GEOLENS_INSTANCE is the site root. An empty value (an unset CI secret,
# usually) falls back to the demo like an unset one.
BASE_URL = (os.environ.get("GEOLENS_INSTANCE") or "https://demo.getgeolens.com").rstrip("/")

# A private instance wants GEOLENS_API_KEY, sent as an X-API-Key header. The
# public demo needs nothing, and the feed then lists only public datasets.
API_KEY = os.environ.get("GEOLENS_API_KEY") or None

SAMPLE = 5


# The feeds take limit= and offset= and cap one response at 10,000 datasets,
# with no next link, so a harvester pages until a page comes back short.
PAGE = 1000


def fetch(path: str) -> dict:
    # The demo's CDN refuses urllib's default User-Agent with a 403.
    headers = {"Accept": "application/ld+json", "User-Agent": "geolens-examples/dcat-harvest"}
    if API_KEY:
        headers["X-API-Key"] = API_KEY
    request = urllib.request.Request(f"{BASE_URL}/api{path}", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        sys.exit(f"\n  GET {path} failed: HTTP {err.code}")


def fetch_all(path: str) -> dict:
    """The first page's catalog with every page's datasets in dcat:dataset."""
    catalog = fetch(f"{path}?limit={PAGE}&offset=0")
    datasets = catalog["dcat:dataset"]
    page = datasets
    while len(page) == PAGE:
        page = fetch(f"{path}?limit={PAGE}&offset={len(datasets)}")["dcat:dataset"]
        datasets = datasets + page
    return {**catalog, "dcat:dataset": datasets}


def text(node) -> str:
    """A JSON-LD literal is a string or {"@value": ..., "@language": ...}."""
    return node.get("@value", "") if isinstance(node, dict) else node or ""


def main() -> int:
    print(f"Reading {BASE_URL} ...")
    dcat = fetch_all("/datasets/dcat/")
    geodcat = fetch_all("/datasets/geodcat-ap/")

    datasets = dcat["dcat:dataset"]
    ids = {d["dcterms:identifier"] for d in datasets}
    geo_ids = {d["dcterms:identifier"] for d in geodcat["dcat:dataset"]}
    if not datasets:
        sys.exit(f"\n  {BASE_URL} lists no datasets in its DCAT feed")
    if ids != geo_ids:
        sys.exit("\n  the DCAT and GeoDCAT-AP feeds list different datasets")

    def formats_of(d: dict) -> list[str]:
        # A format can be offered twice (a download and a service endpoint).
        return list(dict.fromkeys(x.get("dcterms:format", "?") for x in d.get("dcat:distribution", [])))

    formats: dict[str, int] = {}
    licences: dict[str, int] = {}
    for d in datasets:
        name = d.get("dcterms:license") or "none stated"
        licences[name] = licences.get(name, 0) + 1
        for fmt in formats_of(d):
            formats[fmt] = formats.get(fmt, 0) + 1
    by_count = sorted(licences.items(), key=lambda kv: (-kv[1], kv[0]))

    w = 62
    print()
    print("DCAT HARVEST".center(w).rstrip())
    print("-" * w)
    print(f"  catalog             {text(dcat['dcterms:title'])}")
    print(f"  DCAT 3 datasets     {len(datasets):>4}")
    print(f"  GeoDCAT-AP          {len(geo_ids):>4}   same identifiers")
    print()
    print(f"  licences            {len(licences)} distinct, most common")
    for name, n in by_count[:3]:
        print(f"    {n:>4}  {name}")
    print()
    print("  datasets offering each format")
    print("    " + "  ".join(f"{fmt} {n}" for fmt, n in sorted(formats.items())))
    print()
    print(f"  first {SAMPLE} by title")
    for d in sorted(datasets, key=lambda d: text(d["dcterms:title"]))[:SAMPLE]:
        dist = ", ".join(formats_of(d))
        print(f"    {text(d['dcterms:title'])[:48]}")
        print(f"      {d.get('dcterms:license') or 'no licence stated'}")
        print(f"      {dist or 'no distributions'}")
    print("-" * w)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
