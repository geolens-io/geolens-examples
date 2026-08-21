# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "geolens==1.14.2",
#     "geopandas==1.1.4",
# ]
# ///
"""Find a GeoLens dataset by describing it, then take only the rows you want.

Run it with no setup at all:

    uv run sdk-catalog.py

uv reads the PEP 723 block above, builds a throwaway environment, and runs the
script. `geolens` is the generated Python SDK, published on PyPI.

What it does: asks the catalog a plain-language question, reads the column
schema GeoLens inferred for the dataset that comes back, and pulls one
server-filtered slice of it into GeoPandas.

analyze.py next door does the same job over raw OGC API - Features HTTP. Use
that when the client has to be a standards client. Use this when it is Python:
search, schema and export are three typed calls, and a bad filter comes back as
a ProblemDetail instead of a 400 you have to decode yourself.
"""

from __future__ import annotations

import io
import os
import sys
from uuid import UUID

import geopandas as gpd
from geolens import GeolensClient
from geolens.api.datasets import (
    export_dataset_endpoint_datasets_dataset_id_export_get as export_dataset,
)
from geolens.api.datasets_metadata import (
    list_attributes_endpoint_datasets_dataset_id_attributes_get as list_attributes,
)
from geolens.api.search import search_datasets_endpoint_search_datasets_get as search

# --------------------------------------------------------------------------
# GeoLens connection
# --------------------------------------------------------------------------

# The variable used to be GEOLENS_URL. A stale export would otherwise fall
# through to the demo and report the wrong catalog without a word, so refuse.
if os.environ.get("GEOLENS_URL") and not os.environ.get("GEOLENS_INSTANCE"):
    sys.exit("GEOLENS_URL was renamed to GEOLENS_INSTANCE; export that instead.")

# GEOLENS_INSTANCE is the site root; API_BASE below adds /api. An empty value
# (an unset CI secret, usually) falls back to the demo like an unset one.
BASE_URL = os.environ.get("GEOLENS_INSTANCE") or "https://demo.getgeolens.com"

# The SDK wants the /api prefix the deployed API is served under, not the site
# root. Everything else in the library is relative to it.
API_BASE = f"{BASE_URL.rstrip('/')}/api"

# Public datasets need no credentials, so the demo works with none. For a
# private instance set GEOLENS_API_KEY: the SDK sends it as an X-API-Key
# header, and offers no way at all to put it in the query string, where it
# would land in access logs.
#
# A key GeoLens cannot resolve is refused with 401 on every endpoint that reads
# credentials, so a typo stops the script instead of quietly handing it the
# public subset. Sending no key at all is anonymous and still sees public data.
# Measured against the demo (v1.14.0) on 2026-08-18; instances older than
# v1.14.0 discard the bad key on these three endpoints and answer 200.
API_KEY = os.environ.get("GEOLENS_API_KEY") or None

# Search runs over embeddings of each record's text, so this matches on meaning
# rather than words. None of these five words appears in the title it finds.
QUERY = "space rocks that fell to earth"

# The filter runs in PostGIS, not here. Plain SQL against the dataset's own
# columns, which is why the schema step above it is not decoration: mass_kg is
# a column this catalog inferred and named, and you have to read it to write
# this line. One tonne and up.
WHERE = "mass_kg > 1000"


def ok(response, what: str):
    """Return the response, or exit with the API's own explanation.

    Every generated endpoint hands back a Response with .status_code, .content
    and .parsed. On an error the parsed body is a typed ProblemDetail (RFC
    9457), so the reason a filter was rejected is an attribute, not a blob.
    """
    if response.status_code != 200:
        detail = getattr(response.parsed, "detail", None) or response.content[:200]
        sys.exit(f"\n  {what} failed: HTTP {response.status_code}, {detail}")
    return response


def main() -> int:
    print(f"Reading {BASE_URL} ...")
    client = GeolensClient(base_url=API_BASE, api_key=API_KEY).client

    # 1. Ask the catalog a question. `parsed` is an OGC API - Records
    #    FeatureCollection: number_matched, plus a typed record per hit.
    results = ok(search.sync_detailed(client=client, q=QUERY, limit=5), "search").parsed
    hits = [f for f in results.features if f.properties.record_type == "vector_dataset"]
    if not hits:
        sys.exit(f"\n  nothing matched {QUERY!r} on {BASE_URL}")
    hit = hits[0]
    dataset_id = UUID(hit.id)

    # 2. Read the schema. GeoLens profiles every column at ingest, so this is
    #    more than names and types: semantic_role is its guess at what the
    #    column is for, and units is what it found the numbers to be in.
    schema = ok(
        list_attributes.sync_detailed(client=client, dataset_id=dataset_id),
        "attributes",
    ).parsed

    # 3. Export the slice. format_ also takes gpkg, parquet, shp and csv;
    #    geojson keeps this script to two dependencies.
    export = ok(
        export_dataset.sync_detailed(
            client=client, dataset_id=dataset_id, format_="geojson", where=WHERE
        ),
        "export",
    )
    gdf = gpd.read_file(io.BytesIO(export.content))

    total = hit.properties.feature_count
    heaviest = gdf.sort_values("mass_kg", ascending=False).head(8)

    w = 62
    print()
    print("GEOLENS CATALOG".center(w))
    print("-" * w)
    print(f"  asked for           {QUERY!r}")
    noun = "record" if results.number_matched == 1 else "records"
    print(f"  matched             {results.number_matched:>10,}   {noun}")
    print()
    print(f"  {hit.properties.title}")
    print(f"    id                {hit.id}")
    print(f"    features          {total:>10,}   {hit.properties.geometry_type}")
    print(f"    license           {hit.properties.license_}")
    print()
    print("  columns as GeoLens read them")
    for attr in schema.attributes:
        units = f"  in {attr.units}" if attr.units else ""
        role = attr.semantic_role or ""
        print(
            f"    {attr.field_name:<12} {str(attr.data_type):<18} {role:<12}{units}".rstrip()
        )
    print()
    print(f"  filter              {WHERE}   (server-side, in SQL)")
    print(
        f"  downloaded          {len(gdf):>10,}   of {total:,} features"
        f", {len(export.content) / 1024:.1f} KB"
    )
    print()
    print("  heaviest recoveries")
    print(f"    {'tonnes':>8}  {'year':>4}  {'name':<24}  class")
    for _, row in heaviest.iterrows():
        print(
            f"    {row['mass_kg'] / 1000:>8.1f}  {row['year']:>4}  "
            f"{row['name'][:24]:<24}  {row['recclass']}"
        )
    print()
    seen = int((gdf["fall"] == "Fell").sum())
    print(
        f"  {gdf['mass_kg'].sum() / 1000:,.0f} tonnes across {len(gdf)} recoveries, "
        f"of which {seen} were"
    )
    print("  watched coming down. The rest were found later, which is why the")
    print("  map of meteorite finds is really a map of where people look.")
    print("-" * w)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
