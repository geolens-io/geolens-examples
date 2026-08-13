# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "geopandas==1.1.4",
#     "httpx==0.28.1",
#     "matplotlib==3.11.1",
# ]
# ///
"""Analyze the NYC subway network from a live GeoLens instance.

Run it with no setup at all:

    uv run analyze.py

uv reads the PEP 723 block above, builds a throwaway environment, and runs the
script. There is no virtualenv to create and no requirements.txt to install.

What it does: pulls two collections out of the GeoLens demo over OGC API -
Features, measures the network in a metric CRS, joins stations to services
spatially, prints a summary, and writes subway.png.
"""

from __future__ import annotations

import os
import sys
from collections import Counter

import geopandas as gpd
import httpx
import matplotlib

matplotlib.use("Agg")  # no display needed; we only write a PNG
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

# --------------------------------------------------------------------------
# GeoLens connection
# --------------------------------------------------------------------------

BASE_URL = os.environ.get("GEOLENS_URL", "https://demo.getgeolens.com")

# Collection ids are dataset UUIDs. Find them at GET /api/collections, or in
# the web UI under a dataset's "Share / API" panel.
LINES_ID = "de602fbe-8b30-4755-924f-c9e7fd9613b6"  # NYC Subway Lines (MTA)
STATIONS_ID = "724bf894-dc1a-418c-abc6-555798c44d7c"  # NYC Subway Stations (MTA)

# Public datasets need no credentials. For a private dataset, send an API key
# in the X-Api-Key header. GeoLens also accepts ?api_key= in the query string,
# but that lane is deprecated: a credential in a URL gets written to access
# logs and every proxy log in between. It survives only for clients that
# cannot set headers, such as XYZ tile URLs pasted into desktop GIS.
API_KEY = os.environ.get("GEOLENS_API_KEY")

# One page of features. The demo collections are small (29 lines, 496
# stations), so a single request of this size covers them, but never rely on
# that: fetch_collection() below follows the OGC `next` link, which is the only
# correct way to read a collection whose size you do not control.
PAGE_SIZE = 2000

# Metric CRS for the measurements. Lengths computed on EPSG:4326 degrees are
# meaningless, so everything spatial happens after .to_crs(). UTM 18N covers
# the whole city in metres; a surveyor would reach for EPSG:6539 (NY Long
# Island, metres) instead, which is the same idea with less scale distortion.
METRIC_CRS = "EPSG:32618"

# Distance used to attach a station to a service line. The MTA line and point
# layers are digitized separately, so a platform sits tens of metres off the
# track centerline.
NEAR_DISTANCE_M = 150


def fetch_collection(client: httpx.Client, collection_id: str) -> gpd.GeoDataFrame:
    """Read every feature of a collection into a GeoDataFrame.

    The items endpoint returns plain GeoJSON:

        GET /api/collections/{id}/items?limit=2000
        {"type": "FeatureCollection",
         "numberMatched": 496,     <- total matching the query
         "numberReturned": 496,    <- in THIS page
         "features": [...],
         "links": [{"rel": "next", "href": "...&after_gid=496"}, ...]}

    Paging is keyset-based (`after_gid`), not offset-based, so a page never
    shifts under you while you read. GeoLens omits the `next` link on the last
    page, so "follow next until it is gone" terminates on its own.
    """
    url = f"{BASE_URL}/api/collections/{collection_id}/items?limit={PAGE_SIZE}"
    features: list[dict] = []

    while url:
        response = client.get(url)
        response.raise_for_status()
        payload = response.json()
        features.extend(payload["features"])
        url = next(
            (link["href"] for link in payload.get("links", []) if link["rel"] == "next"),
            None,
        )

    # GeoJSON from an OGC API - Features endpoint is always CRS84 (lon/lat).
    return gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")


# --------------------------------------------------------------------------
# Presentation
# --------------------------------------------------------------------------

# Official MTA service colors, so the map reads like a subway map instead of a
# random categorical palette.
MTA_COLORS = {
    "1": "#EE352E", "2": "#EE352E", "3": "#EE352E",
    "4": "#00933C", "5": "#00933C", "5 Peak": "#00933C", "6": "#00933C",
    "7": "#B933AD",
    "A": "#0039A6", "C": "#0039A6", "E": "#0039A6",
    "B": "#FF6319", "D": "#FF6319", "F": "#FF6319", "M": "#FF6319",
    "G": "#6CBE45",
    "J": "#996633", "Z": "#996633",
    "L": "#A7A9AC",
    "N": "#FCCC0A", "Q": "#FCCC0A", "R": "#FCCC0A", "W": "#FCCC0A",
    "SF": "#808183", "SR": "#808183", "ST": "#808183",
    "SIR": "#0078C6",
}
FALLBACK_COLOR = "#8A94A6"

BOROUGHS = {"M": "Manhattan", "Bk": "Brooklyn", "Q": "Queens", "Bx": "Bronx", "SI": "Staten Island"}

INK = "#0B0F19"
FOREGROUND = "#E8ECF4"
MUTED = "#8A94A6"


def draw_map(lines: gpd.GeoDataFrame, stations: gpd.GeoDataFrame, path: str) -> None:
    # The extent is about 42 x 43 km, so a square figure wastes no margin once
    # the aspect is locked to equal.
    fig, ax = plt.subplots(figsize=(10, 10), facecolor=INK)
    ax.set_facecolor(INK)

    for service, group in lines.groupby("service", sort=False):
        group.plot(
            ax=ax,
            color=MTA_COLORS.get(str(service), FALLBACK_COLOR),
            linewidth=1.8,
            alpha=0.95,
            zorder=2,
        )

    # Station dots sit on top of a line of about the same width, so they need a
    # dark edge to separate from it. ADA stops are called out by size.
    stations.plot(ax=ax, color="#C9D2E3", markersize=4, alpha=0.9,
                  edgecolor=INK, linewidth=0.4, zorder=3)
    stations[stations["ada"] > 0].plot(
        ax=ax, color="#FFFFFF", markersize=11, alpha=1.0,
        marker="o", edgecolor=INK, linewidth=0.7, zorder=4,
    )

    ax.set_axis_off()
    ax.set_aspect("equal")
    fig.subplots_adjust(left=0.02, right=0.98, top=0.98, bottom=0.02)

    # Staten Island sits southwest and the Bronx northeast, so the upper-left
    # of the extent is empty. Put the type there instead of padding the figure.
    ax.text(0.0, 1.0, "NYC Subway", transform=ax.transAxes, va="top",
            color=FOREGROUND, fontsize=30, fontweight="bold")
    ax.text(0.0, 0.958, f"{len(lines)} services · {len(stations)} stations",
            transform=ax.transAxes, va="top", color=MUTED, fontsize=12)
    ax.legend(
        handles=[
            Line2D([], [], color="#C9D2E3", marker="o", linestyle="", markersize=4,
                   label="station"),
            Line2D([], [], color="#FFFFFF", marker="o", linestyle="", markersize=6.5,
                   markeredgecolor=INK, label="ADA accessible"),
        ],
        loc="upper left", bbox_to_anchor=(0.0, 0.925), frameon=False,
        labelcolor=MUTED, fontsize=10.5, handletextpad=0.6,
    )
    # The MTA publishes this as open data on the condition that you credit it.
    ax.text(0.0, 0.0, "Data: MTA via data.ny.gov · Served by GeoLens (OGC API - Features)",
            transform=ax.transAxes, va="bottom", color=MUTED, fontsize=9)

    fig.savefig(path, dpi=200, facecolor=INK)
    plt.close(fig)


def main() -> int:
    print(f"Reading {BASE_URL} ...")

    headers = {"X-Api-Key": API_KEY} if API_KEY else {}
    with httpx.Client(timeout=60.0, headers=headers, follow_redirects=True) as client:
        lines = fetch_collection(client, LINES_ID)
        stations = fetch_collection(client, STATIONS_ID)

    # Project once, then every length and distance below is in metres.
    lines_m = lines.to_crs(METRIC_CRS)
    stations_m = stations.to_crs(METRIC_CRS)
    lines_m["length_km"] = lines_m.geometry.length / 1000

    # Each service carries its own geometry, so a shared trunk (8 Av, used by
    # A/C/E) is counted once per service. union_all() merges the parts that are
    # exactly coincident, which knocks roughly 170 km off the total.
    #
    # Neither number is "how long the subway is". Inspect the data before you
    # name a column: this layer mixes digitizing conventions, and the parts
    # count in the table below shows it.
    total_km = lines_m["length_km"].sum()
    distinct_km = lines_m.geometry.union_all().length / 1000
    lines_m["parts"] = lines_m.geometry.count_geometries()

    by_service = (
        lines_m.groupby(["service", "service_name"], as_index=False)
        .agg(length_km=("length_km", "sum"), parts=("parts", "sum"))
        .sort_values("length_km", ascending=False)
    )

    # A real spatial join: which stations lie within NEAR_DISTANCE_M of each
    # service? `dwithin` runs off the spatial index, so it does not build
    # buffer polygons. This is the same question PostGIS answers with
    # ST_DWithin, which is what the GeoLens backend would run server-side.
    near = gpd.sjoin(
        stations_m[["stop_name", "geometry"]],
        lines_m[["service", "geometry"]],
        predicate="dwithin",
        distance=NEAR_DISTANCE_M,
    )
    stops_per_service = near.groupby("service")["stop_name"].nunique()

    density = by_service.assign(
        stops=by_service["service"].map(stops_per_service).fillna(0).astype(int)
    )
    density["stops_per_km"] = density["stops"] / density["length_km"]

    boroughs = Counter(stations["borough"])
    ada_full = int((stations["ada"] == 1).sum())
    ada_partial = int((stations["ada"] == 2).sum())

    w = 62
    print()
    print("NYC SUBWAY".center(w))
    print("-" * w)
    print(f"  services            {len(lines):>10,}")
    print(f"  stations            {len(stations):>10,}")
    print(f"  line geometry       {total_km:>10,.1f} km   (29 service geometries summed)")
    print(f"  after dissolve      {distinct_km:>10,.1f} km   (coincident parts merged)")
    print(f"  measured in         {METRIC_CRS:>10}")
    print()
    print(f"  ADA accessible      {ada_full:>10,}   ({ada_full / len(stations):.0%} of stations)")
    print(f"  partly accessible   {ada_partial:>10,}")
    print()
    print("  stations by borough")
    for code, count in boroughs.most_common():
        label = BOROUGHS.get(code, code)
        print(f"    {label:<16} {count:>6,}   {'#' * round(count / 6)}")
    print()
    print("  longest services")
    print(f"    {'':<8}{'km':>7}  {'parts':>5}  {'stops':>5}  {'stops/km':>8}  name")
    for _, row in density.head(5).iterrows():
        print(
            f"    {row['service']:<8}{row['length_km']:>7.1f}  {row['parts']:>5}  "
            f"{row['stops']:>5}  {row['stops_per_km']:>8.2f}  {row['service_name']}"
        )
    print()
    fragmented = density.loc[density["parts"].idxmax()]
    print(
        f"  {fragmented['service']} carries {fragmented['parts']} parts against a "
        f"median of {int(density['parts'].median())}: it is"
    )
    print("  digitized track by track while the lettered services are single")
    print("  centerlines. Two conventions in one column, so 'km' is the length")
    print("  of the drawn geometry, not the length of the route.")
    print("-" * w)

    out = "subway.png"
    draw_map(lines_m, stations_m, out)
    print(f"  wrote {out}")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
