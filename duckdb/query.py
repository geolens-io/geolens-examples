# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "duckdb==1.5.5",
# ]
# ///
"""Query a live GeoLens instance with SQL, from DuckDB, over HTTP.

Run it with no setup at all:

    uv run query.py

uv reads the PEP 723 block above, builds a throwaway environment, and runs the
script. There is no virtualenv to create and no requirements.txt to install.

Point it somewhere else with arguments or environment variables:

    uv run query.py https://geolens.example.com
    uv run query.py https://geolens.example.com <lines-id> <stations-id>

What it does: reads one dataset as GeoParquet and another over OGC API -
Features, joins the two in a single SQL statement, and prints which services
run past each station. Nothing is downloaded to disk and no database is
created; DuckDB reads both sources over HTTP as it evaluates the query.

The point of the example is that GeoLens has two read surfaces with different
shapes, and DuckDB can treat both as tables:

    read_parquet()  the bulk export. Columnar, so DuckDB fetches byte ranges
                    for the columns a query names and skips the rest.
    ST_Read()       the standards endpoint. GeoJSON, read whole, which is what
                    a format with no index and no column boundaries costs.

python/analyze.py next door reads the same two collections into GeoPandas. Use
that when the analysis is Python. Use this when it is SQL, when the data is
larger than memory, or when you want to join GeoLens to Parquet, CSV or a
database that DuckDB already reads.
"""

from __future__ import annotations

import os
import sys
import uuid

import duckdb

# --------------------------------------------------------------------------
# GeoLens connection
# --------------------------------------------------------------------------

# Arguments beat environment, environment beats the demo:
#     query.py [instance-url [lines-id stations-id]]
# The two dataset ids move together, since a run needs both. Any other count
# is a typo, and refusing it is the point: a script that ignored the extra
# argument would print your instance URL at the top and then report the demo's
# subway, which is the kind of wrong you do not catch by reading the output.
ARGS = sys.argv[1:]
if len(ARGS) == 2 or len(ARGS) > 3:
    sys.exit(
        "usage: query.py [instance-url [lines-id stations-id]]\n"
        f"  got {len(ARGS)} arguments; pass both dataset ids or neither"
    )

# The demo, and the two datasets on it that every number further down was
# measured against.
DEMO_URL = "https://demo.getgeolens.com"
DEMO_LINES_ID = "de602fbe-8b30-4755-924f-c9e7fd9613b6"
DEMO_STATIONS_ID = "724bf894-dc1a-418c-abc6-555798c44d7c"

# An empty GEOLENS_URL is read as unset. os.environ.get(name, default) would
# hand back the empty string and build every request against "/api/...".
ENV_URL = os.environ.get("GEOLENS_URL") or None
BASE_URL = (ARGS[0] if ARGS else ENV_URL or DEMO_URL).rstrip("/")

# Dataset UUIDs. Find them at GET /api/collections, or in the web UI under a
# dataset's "Share / API" panel. The same id names a dataset on the export
# route and a collection on the OGC route, which is what lets one dataset be
# read either way.
def dataset_id(value: str, label: str) -> str:
    """A dataset id, or a usage error naming which argument was wrong.

    Both ids land in a URL, so a typo would otherwise surface as a 404 from
    somewhere inside DuckDB. uuid.UUID also accepts braced and urn: spellings
    that GeoLens does not, hence the round-trip check.
    """
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        sys.exit(f"{label} is not a UUID: {value!r}")
    if str(parsed) != value.lower():
        sys.exit(f"{label} must be the plain 36-character form, not {value!r}")
    return value


LINES_ID = dataset_id(ARGS[1], "lines-id") if len(ARGS) == 3 else DEMO_LINES_ID
STATIONS_ID = dataset_id(ARGS[2], "stations-id") if len(ARGS) == 3 else DEMO_STATIONS_ID

# Whether this run is reading the data the expected numbers were measured
# against. Keyed on the resolved target rather than on how it was supplied, so
# spelling the demo out in full is checked exactly as hard as passing nothing,
# and CI is checked either way. The comparison is literal: a target that
# reaches the same datasets by another name (a proxy, a mirror, a UUID typed
# in a different case) skips the checks rather than risking a false assertion
# about data this script cannot confirm is the demo's.
ON_DEMO_DATA = (
    BASE_URL == DEMO_URL
    and LINES_ID == DEMO_LINES_ID
    and STATIONS_ID == DEMO_STATIONS_ID
)

# Read one. The export route streams the whole dataset in the format you ask
# for. It answers 200 with the bytes, not 202 with a job to poll, so a URL is
# all DuckDB needs. Public datasets need no credential.
#
# EPSG:4326 is the only CRS this format is offered in. Ask for `parquet` with
# any other `target_crs` and GeoLens answers 400 rather than writing a file
# whose GeoParquet metadata would disagree with its contents.
#
# The parameter is `target_crs`. A misremembered `?crs=EPSG:3857` is not a
# parameter this route has, so it is ignored: 200, and a file in 4326 that you
# believe is in 3857. Exactly the failure the 400 exists to prevent, reached by
# spelling the parameter wrong.
LINES_PARQUET = f"{BASE_URL}/api/datasets/{LINES_ID}/export?format=parquet"

# Read two. The OGC API - Features items endpoint, as plain GeoJSON.
#
# `limit` is capped by the instance (1000 by default, and the demo's default).
# 496 stations fit in one page, so this script does not page. A collection
# whose size you do not control needs the `rel="next"` link followed, which
# GeoJSON-over-ST_Read cannot do for you: read it with an HTTP client, or
# export it as Parquet like the lines above and let the format carry the whole
# dataset in one URL.
PAGE_SIZE = 1000
STATIONS_GEOJSON = (
    f"{BASE_URL}/api/collections/{STATIONS_ID}/items?f=json&limit={PAGE_SIZE}"
)

# For a private instance, one secret covers both reads:
#
#     CREATE SECRET geolens (
#         TYPE http,
#         SCOPE 'https://geolens.example.com',
#         EXTRA_HTTP_HEADERS MAP{'X-Api-Key': '...'}
#     );
#
# ST_Read is GDAL, so the obvious guess is GDAL's own GDAL_HTTP_HEADERS
# variable. It does nothing here: DuckDB's spatial extension serves https to
# GDAL through DuckDB's own filesystem, so the secret reaches both reads and
# the GDAL variable reaches neither. Measured against the demo on 2026-08-19.
#
# Worth knowing before you debug one: neither read says "401". read_parquet
# reports a refused credential as `HTTP Error: ... (HTTP 0 Internal Server
# Error)`, and ST_Read as `IO Error: Could not open GDAL dataset at: <url>`.
# Both mean the same thing. If a read that works signed out starts failing
# either of those ways once you add a key, the key is wrong, not the server.
API_KEY = os.environ.get("GEOLENS_API_KEY")

# --------------------------------------------------------------------------
# Coordinate reference systems
# --------------------------------------------------------------------------

# Lengths and distances computed on degrees are meaningless, so everything
# spatial below happens after ST_Transform. UTM 18N covers the whole city in
# metres, and is what python/analyze.py measures in, so the two examples are
# comparable.
METRIC_CRS = "EPSG:32618"

# The source CRS, and the one line in this file most worth reading twice.
#
# Both reads hand back lon/lat in that order, and both label it, but they do
# not label it the same way: the GeoParquet column arrives typed
# GEOMETRY('OGC:CRS84') and ST_Read's arrives GEOMETRY('EPSG:4326'). The two
# authorities disagree about axis order (CRS84 is lon/lat, EPSG:4326 is
# lat/lon), and ST_Transform believes the name you give it over the numbers
# you give it.
#
# So naming the source 'EPSG:4326' here reads -73.91 as a latitude and
# silently returns coordinates in the South Atlantic. No error, no warning, a
# perfectly well-formed answer to a different question. Naming it 'OGC:CRS84'
# is correct for both reads; ST_Transform(..., always_xy := true) is the same
# fix spelled differently.
#
# EXPECT_UTM_BOX at the bottom is what stands guard over this, and it took a
# deliberately broken run to find out that nothing else did. The obvious guard,
# "every station is near a line", does not catch this at all, because both
# layers are transformed by the same wrong rule and land in the South Atlantic
# together, still neatly 20 m apart. Only an absolute check on where the
# coordinates ended up can tell.
SOURCE_CRS = "OGC:CRS84"

# --------------------------------------------------------------------------
# The question
# --------------------------------------------------------------------------

# How close a track has to pass for this script to call it "runs past". The
# MTA digitizes lines and stations separately, so a platform sits tens of
# metres off the track centerline even when the train stops there.
NEAR_M = 150

# How close the nearest track has to be before a station is "on" a line at
# all. Every station in the demo data is within 21 m of one, so this is a
# sanity threshold with room in it, not a tuned parameter.
ON_LINE_M = 50

# What the demo catalog holds today. Checked at the end when ON_DEMO_DATA,
# so a run that reaches a reset demo says which number moved instead of
# printing a report about data that is no longer there.
#
# None of the four expectations below can be generalized to another instance,
# including the extent box. That one is not a formatting detail: it is the only
# check that catches the axis-order trap described under SOURCE_CRS, and it
# works by knowing in advance which patch of the earth the right answer sits
# on. Point this at Zurich and the box is wrong; widen it to fit any instance
# and it stops distinguishing New York from the South Atlantic, which is the
# entire distinction it exists to draw. A guard against a silent error has to
# know what the correct answer looks like, so it belongs to the data it was
# measured against and travels no further.
EXPECT_LINES = 29
EXPECT_STATIONS = 496

# The one number below that is not exact. Pairs are counted by distance
# against a 150 m threshold, and the closest pair on either side of it sits
# 0.13 m below and 3.45 m above, so an equality here would be a coin flip on a
# PROJ upgrade that moves a point by a hand's width. The counts above involve
# no geometry at all and are exact for that reason.
EXPECT_PAIRS_RANGE = (1250, 1400)

# Where the stations have to land once projected: UTM 18N metres over New
# York. Measured extent is easting 563k-605k, northing 4,485k-4,529k, so this
# box is loose by tens of kilometres in every direction and still nowhere near
# the (2,100k, -10,800k) that a lat/lon axis swap produces.
EXPECT_UTM_BOX = (500_000, 700_000, 4_400_000, 4_600_000)


def connect() -> duckdb.DuckDBPyConnection:
    """Open DuckDB with the extensions these two reads need."""
    con = duckdb.connect()
    # spatial brings GEOMETRY, ST_Transform, ST_DWithin and ST_Read (GDAL).
    # httpfs brings the HTTP filesystem read_parquet needs for an https URL.
    # Both download on first use and are cached in ~/.duckdb after that.
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("INSTALL httpfs; LOAD httpfs;")
    if API_KEY:
        con.execute(
            "CREATE SECRET geolens (TYPE http, SCOPE $scope, "
            "EXTRA_HTTP_HEADERS MAP{'X-Api-Key': $key});",
            {"scope": BASE_URL, "key": API_KEY},
        )
    return con


def http_cost(con: duckdb.DuckDBPyConnection) -> str:
    """One line describing what the last logged block moved over HTTP.

    DuckDB logs every request it makes, which is the only honest way to say
    what a query cost. This reports what the run actually did rather than a
    number written down in advance, because the answer is not fixed: GeoLens
    builds an export artifact on demand and caches it, and only a cached one
    answers HEAD with a Content-Length. DuckDB cannot address ranges into a
    file whose size it does not know, so against a cold artifact it streams
    the whole 3.3 MB and the column-pruning below buys nothing. Warm, the same
    query reads two ranges and about 16 KB. Both were observed on the demo on
    2026-08-19, minutes apart.

    Returns a description rather than raising, since this is commentary and
    no conclusion below depends on it.
    """
    try:
        # Selecting the struct columns only. duckdb_logs_parsed also carries a
        # TIMESTAMP WITH TIME ZONE, and reading that one through the Python
        # client needs pytz installed, which this script deliberately does not
        # depend on.
        rows = con.sql(
            "SELECT request.headers['Range'] IS NOT NULL AS ranged, "
            "       TRY_CAST(response.headers['Content-Length'] AS BIGINT) AS len "
            "FROM duckdb_logs_parsed('HTTP') WHERE request.type = 'GET'"
        ).fetchall()
    except duckdb.Error:
        return "not measured"
    if not rows:
        return "nothing fetched (already cached in this connection)"
    # A chunked response declares no length, so its bytes cannot be counted
    # from the log. The GeoJSON read is one of those; say so rather than
    # reporting a total that quietly omits it.
    counted = [n for _, n in rows if n is not None]
    ranged = sum(1 for is_ranged, _ in rows if is_ranged)
    chunked = len(rows) - len(counted)
    size = f"{sum(counted) / 1024:,.1f} KB" if counted else "size undeclared"
    if chunked:
        size += f" + {chunked} chunked"
    return f"{size}, {ranged}/{len(rows)} reads ranged"


def measured(con: duckdb.DuckDBPyConnection, *statements) -> str:
    """Run (sql, params) pairs with HTTP logging on, and describe what they moved."""
    con.execute("CALL truncate_duckdb_logs();")
    con.execute("CALL enable_logging('HTTP');")
    for sql, params in statements:
        con.execute(sql, params)
    con.execute("CALL disable_logging();")
    return http_cost(con)


def main() -> int:
    print(f"Reading {BASE_URL} ...")
    con = connect()

    # ----------------------------------------------------------------------
    # 1. A catalog question, answered without downloading the map
    # ----------------------------------------------------------------------
    # The lines export is 3.3 MB, and 99.5% of that is the geometry column.
    # This query never names it, so DuckDB reads the Parquet footer, works out
    # where the `service` column lives, and fetches that range and nothing
    # else: a HEAD and two ranged reads, about 16 KB.
    #
    # This is the whole reason to point SQL at an export instead of curl-ing
    # it to disk first: you can ask what is in a dataset for the price of its
    # metadata. The join below names the geometry and pays full price, which
    # is why both numbers are printed rather than only the flattering one.
    # The URL is bound, not interpolated. It can carry an apostrophe straight
    # from argv or GEOLENS_URL, and DuckDB would read that as the end of the
    # string literal and fail to parse a query that is not wrong.
    catalog_cost = measured(
        con,
        (
            "CREATE TABLE service_names AS "
            "SELECT DISTINCT service FROM read_parquet($url)",
            {"url": LINES_PARQUET},
        ),
    )
    services = con.sql("SELECT count(*) FROM service_names").fetchone()[0]

    # ----------------------------------------------------------------------
    # 2. Both reads, projected once, as tables
    # ----------------------------------------------------------------------
    # read_parquet needs no ST_GeomFromWKB. GeoLens writes GeoParquet 1.1.0
    # with WKB geometry and a `geo` metadata key naming the primary column, and
    # DuckDB's spatial extension decodes that on read: the column arrives
    # already typed GEOMETRY. (The setting is enable_geoparquet_conversion, on
    # by default whenever spatial is loaded.) Reach for ST_GeomFromWKB only
    # against a Parquet file that carries no GeoParquet metadata, where the
    # geometry really is an undifferentiated BLOB.
    load_lines = (
        f"""
        CREATE TABLE lines AS
        SELECT service,
               service_name,
               ST_Transform(geometry, '{SOURCE_CRS}', '{METRIC_CRS}') AS geom
        FROM read_parquet($url)
        """,
        {"url": LINES_PARQUET},
    )

    # ST_Read hands the URL to GDAL, which reads it as GeoJSON. Pass the plain
    # https URL: GDAL's own /vsicurl/ prefix does not work here, because
    # DuckDB serves the bytes itself rather than letting GDAL fetch them.
    #
    # OGC_FID is GDAL's row identity, and this query needs one. stop_name is
    # not unique: the demo's 496 stations carry 379 distinct names, six of
    # them called "86 St" and six "Canal St", so grouping by name silently
    # merges platforms that are miles apart and reports one station served by
    # fifteen lines. It looks like an answer, which is what makes it dangerous.
    load_stations = (
        f"""
        CREATE TABLE stations AS
        SELECT OGC_FID AS station_id,
               stop_name,
               borough,
               ada,
               daytime_routes,
               ST_Transform(geom, '{SOURCE_CRS}', '{METRIC_CRS}') AS geom
        FROM ST_Read($url)
        """,
        {"url": STATIONS_GEOJSON},
    )

    geometry_cost = measured(con, load_lines, load_stations)

    n_lines = con.sql("SELECT count(*) FROM lines").fetchone()[0]
    n_stations = con.sql("SELECT count(*) FROM stations").fetchone()[0]

    # ----------------------------------------------------------------------
    # 3. The spatial join, across both sources, in one statement
    # ----------------------------------------------------------------------
    # ST_DWithin builds no buffer polygons, and DuckDB does not evaluate it as
    # a filter over a cross product: EXPLAIN on this statement shows a
    # SPATIAL_JOIN operator carrying ST_DWithin as its condition. Worth
    # checking with EXPLAIN when a spatial join is slower than it should be,
    # since a predicate the planner does not recognise degrades quietly into
    # every row against every row.
    #
    # This is the same question PostGIS answers with ST_DWithin, which is what
    # GeoLens itself would run server-side. The difference is that here one
    # side of the join came from a columnar export and the other from a
    # standards endpoint, and SQL cannot tell them apart.
    con.execute(f"""
        CREATE TABLE passes AS
        SELECT DISTINCT s.station_id, l.service
        FROM stations s
        JOIN lines l ON ST_DWithin(s.geom, l.geom, {NEAR_M})
    """)

    # daytime_routes is what the MTA says stops here; `passes` is what the
    # geometry says runs past. Splitting the first into rows makes the two
    # comparable, and their difference is the interesting column below.
    con.execute("""
        CREATE TABLE stops AS
        SELECT station_id, unnest(str_split(daytime_routes, ' ')) AS route
        FROM stations
    """)

    busiest = con.sql(f"""
        SELECT s.stop_name,
               s.borough,
               s.daytime_routes,
               count(DISTINCT p.service) AS runs_past,
               count(DISTINCT p.service) FILTER (
                   WHERE p.service NOT IN (
                       SELECT route FROM stops t WHERE t.station_id = s.station_id
                   )
               ) AS no_stop
        FROM stations s
        JOIN passes p USING (station_id)
        GROUP BY s.station_id, 1, 2, 3
        ORDER BY runs_past DESC, no_stop DESC, s.stop_name
        LIMIT 6
    """).fetchall()

    pairs = con.sql("SELECT count(*) FROM passes").fetchone()[0]

    # The check the CRS comment above promised: where did the coordinates
    # actually land? Absolute, so it is not fooled by two layers being wrong
    # in the same direction.
    extent = con.sql("""
        SELECT min(ST_X(ST_Centroid(geom))), max(ST_X(ST_Centroid(geom))),
               min(ST_Y(ST_Centroid(geom))), max(ST_Y(ST_Centroid(geom)))
        FROM stations
    """).fetchone()

    # ST_Distance to the nearest line, per station, and every one of them has
    # to be close to something. This one proves the two reads register against
    # each other, which is a different question from the extent check above.
    on_line = con.sql(f"""
        SELECT count(*) FROM (
            SELECT s.station_id, min(ST_Distance(s.geom, l.geom)) AS m
            FROM stations s CROSS JOIN lines l
            GROUP BY 1
        ) WHERE m <= {ON_LINE_M}
    """).fetchone()[0]
    furthest = con.sql("""
        SELECT s.stop_name, min(ST_Distance(s.geom, l.geom)) AS m
        FROM stations s CROSS JOIN lines l
        GROUP BY s.station_id, 1
        ORDER BY m DESC LIMIT 1
    """).fetchone()

    # ----------------------------------------------------------------------
    # Report
    # ----------------------------------------------------------------------
    w = 66
    print()
    print("SUBWAY SERVICES PAST EACH STATION".center(w))
    print("-" * w)
    print(f"  lines               {n_lines:>10,}   GeoParquet export, {services} named services")
    print(f"  stations            {n_stations:>10,}   OGC API - Features, one page of {PAGE_SIZE}")
    print(f"  joined within       {NEAR_M:>10} m  measured in {METRIC_CRS}")
    print()
    print("  over the wire, as DuckDB logged it")
    print(f"    naming one column   {catalog_cost}")
    print(f"    naming the geometry {geometry_cost}")
    print("    Ranged reads are the interesting case: the query that never")
    print("    names the geometry pulls about 16 KB out of a 3.3 MB export.")
    print("    They need a length to range into, and only an export GeoLens")
    print("    has already built answers HEAD with one, so a cold artifact")
    print("    reads whole and the first run of the day can show either.")
    print()
    print(f"  {'':<26}{'past':>5} {'no stop':>8}  stops here")
    for stop_name, borough, routes, runs_past, no_stop in busiest:
        label = f"{stop_name} ({borough})"[:26]
        print(f"  {label:<26}{runs_past:>5} {no_stop:>8}  {routes}")
    print()
    print(f"  {pairs:,} station/service pairs run within {NEAR_M} m of each other, against")
    total_stops = con.sql("SELECT count(*) FROM stops WHERE route <> ''").fetchone()[0]
    print(f"  {total_stops:,} that actually stop. Proximity is not service: the four-track")
    print("  trunks carry expresses straight past the local platforms they share")
    print("  a right-of-way with, and this query counts those.")
    print()
    print("  The two layers do not even name the same services. The lines carry")
    print("  SF, SR and ST for the Franklin, Rockaway and 42 St shuttles, plus a")
    print("  separate '5 Peak' geometry; the stations call every shuttle 'S' and")
    print("  never mention '5 Peak'. Joining these two on the route label instead")
    print("  of on geometry would drop all four and never say so.")
    print("-" * w)

    # ----------------------------------------------------------------------
    # Assertions
    # ----------------------------------------------------------------------
    # A run that printed a table is not a run that read the right data. These
    # exit non-zero, which is what makes this script a CI check rather than a
    # demonstration.
    problems = []

    # True of any instance: a report built from nothing is not a report. This
    # is the only claim this script can make about a catalog it has never seen.
    if n_lines == 0 or n_stations == 0:
        problems.append(
            f"read {n_lines} lines and {n_stations} stations, so at least one of the two "
            f"sources returned nothing and the table above describes an empty join"
        )

    # Everything else is a statement about the demo's catalog, and is only true
    # of the demo's catalog. See the note above EXPECT_LINES for why not even
    # the extent box generalizes.
    if ON_DEMO_DATA:
        if n_lines != EXPECT_LINES:
            problems.append(f"lines: read {n_lines}, expected {EXPECT_LINES}")
        if n_stations != EXPECT_STATIONS:
            problems.append(f"stations: read {n_stations}, expected {EXPECT_STATIONS}")
        # `and n_stations` first: an empty read makes every extent aggregate
        # NULL, and comparing None to a number raises before the report above
        # can say what went wrong. The empty case is already reported.
        west, east, south, north = EXPECT_UTM_BOX
        if n_stations and not (west <= extent[0] and extent[1] <= east
                               and south <= extent[2] and extent[3] <= north):
            problems.append(
                f"projected stations span easting {extent[0]:,.0f}-{extent[1]:,.0f}, northing "
                f"{extent[2]:,.0f}-{extent[3]:,.0f}, which is not {METRIC_CRS} over New York. "
                f"Coordinates this far out mean the source CRS named the wrong axis order; "
                f"see SOURCE_CRS."
            )
        if on_line != n_stations:
            problems.append(
                f"only {on_line} of {n_stations} stations are within {ON_LINE_M} m of any line "
                f"(furthest: {furthest[0]} at {furthest[1]:,.0f} m), so the two reads do not "
                f"register against each other."
            )
        low, high = EXPECT_PAIRS_RANGE
        if not low <= pairs <= high:
            problems.append(f"pairs within {NEAR_M} m: {pairs}, expected {low}-{high}")

    if problems:
        print()
        print("FAILED: this run does not match what the example describes.")
        for problem in problems:
            print(f"  - {problem}")
        print()
        print(f"  If the counts moved, check {BASE_URL}/api/collections: the demo")
        print("  gets reset, and a reset changes dataset ids and row counts. If the")
        print("  coordinates moved, the cause is in this script, not on the server.")
        return 1

    print()
    if ON_DEMO_DATA:
        print(f"  OK: {n_lines} lines, {n_stations} stations, all within {ON_LINE_M} m of a line.")
    else:
        # Naming no single culprit on purpose: the target is the URL and both
        # ids together, and any one of the three differing lands here.
        print(f"  OK: {n_lines} lines, {n_stations} stations. Demo-fixture checks skipped:")
        print("  this run is not reading the demo's two subway datasets.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
