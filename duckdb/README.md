# DuckDB: query a GeoLens catalog in SQL

One single-file script that reads a GeoLens instance from DuckDB over HTTP. It
runs with one command and nothing installed, because its dependencies live in a
[PEP 723](https://peps.python.org/pep-0723/) header that uv reads:

```bash
uv run query.py
```

Nothing is downloaded to disk and no database file is created. DuckDB reads
both sources over HTTP while it evaluates the query.

GeoLens offers two read surfaces with different shapes, and this example treats
both as tables in one statement:

| read | route | shape |
| --- | --- | --- |
| `read_parquet()` | `GET /api/datasets/{id}/export?format=parquet` | columnar, so a query that names two columns fetches two columns |
| `ST_Read()` | `GET /api/collections/{id}/items` | GeoJSON, read whole, which is what a format with no index costs |

Parquet is one of five export formats the same route serves
([the docs list the rest](https://docs.getgeolens.com/guides/user/exports/#export-formats));
it is the one DuckDB can read a column at a time.

[`python/analyze.py`](../python/analyze.py) reads the same two collections into
GeoPandas. Use that when the analysis is Python. Use this when it is SQL, when
the data is larger than memory, or when you want to join GeoLens to the
Parquet, CSV and databases DuckDB already reads.

## What it answers

Which trains run past each station, and which of those never stop there. The
line geometry comes from the Parquet export, the station attributes from the
Features API, and the join between them is one `ST_DWithin`.

```
Reading https://demo.getgeolens.com ...

                SUBWAY SERVICES PAST EACH STATION
------------------------------------------------------------------
  lines                       29   GeoParquet export, 27 named services
  stations                   496   OGC API - Features, one page of 1000
  joined within              150 m  measured in EPSG:32618

  over the wire, as DuckDB logged it
    naming one column   16.2 KB, 2/2 reads ranged
    naming the geometry 3,246.2 KB + 1 chunked, 1/2 reads ranged
    Ranged reads are the interesting case: the query that never
    names the geometry pulls about 16 KB out of a 3.3 MB export.
    They need a length to range into, and only an export GeoLens
    has already built answers HEAD with one, so a cold artifact
    reads whole and the first run of the day can show either.

                             past  no stop  stops here
  Nevins St (Bk)               12        8  2 3 4 5
  Bleecker St (M)              11       10  6
  Prince St (M)                11        9  R W
  Broadway-Lafayette St (M)    11        7  B D F M
  7 Av (M)                     10        7  E B D
  Times Sq-42 St (M)            9        9  S

  1,319 station/service pairs run within 150 m of each other, against
  767 that actually stop. Proximity is not service: the four-track
  trunks carry expresses straight past the local platforms they share
  a right-of-way with, and this query counts those.

  The two layers do not even name the same services. The lines carry
  SF, SR and ST for the Franklin, Rockaway and 42 St shuttles, plus a
  separate '5 Peak' geometry; the stations call every shuttle 'S' and
  never mention '5 Peak'. Joining these two on the route label instead
  of on geometry would drop all four and never say so.
------------------------------------------------------------------

  OK: 29 lines, 496 stations, all within 50 m of a line.
```

Those closing notes matter as much as the table. The numbers are real, so they
carry the quirks of the source data, and the script prints the evidence for its
own caveats rather than asking you to trust a tidy figure.

Point it at your own instance with arguments, or `GEOLENS_INSTANCE` (the site root;
the script adds `/api`, and the CLI and MCP server read the same variable with or
without that suffix):

```bash
uv run query.py https://geolens.example.com
uv run query.py https://geolens.example.com <lines-id> <stations-id>
```

Reading anything other than those two demo datasets turns off the demo-fixture
checks described under [What CI checks](#what-ci-checks), since 29 lines and a
bounding box over New York are facts about the demo and not about your catalog.
Spelling the demo out in full still gets the full checks.

## What it shows

**An export is a URL, not a job.** `GET /api/datasets/{id}/export?format=parquet`
answers 200 with the bytes. There is no job to submit and no status to poll, so
the whole client is a string inside `read_parquet()`. Public datasets need no
credential. Parquet is offered in EPSG:4326 only: ask for it with any other
`target_crs` and GeoLens answers 400 rather than writing a file whose
GeoParquet metadata would disagree with its contents.

Spell that parameter carefully. It is `target_crs`, and `?crs=EPSG:3857` is not
a parameter this route has, so it is ignored rather than refused: 200, and a
file in 4326 that you believe is in 3857. The 400 exists to prevent exactly
that, and a misspelling walks straight around it.

**GeoParquet needs no `ST_GeomFromWKB`.** GeoLens writes GeoParquet 1.1.0, which
is WKB geometry plus a `geo` metadata key naming the primary column, and
DuckDB's spatial extension decodes that on read. The column arrives already typed
`GEOMETRY`, not `BLOB`:

```
DESCRIBE SELECT * FROM read_parquet('.../export?format=parquet');
┌──────────────┬───────────────────────┐
│ service      │ VARCHAR               │
│ service_name │ VARCHAR               │
│ geometry     │ GEOMETRY('OGC:CRS84') │
└──────────────┴───────────────────────┘
```

The setting behind it is `enable_geoparquet_conversion`, on by default whenever
`spatial` is loaded. Reach for `ST_GeomFromWKB` only against a Parquet file
carrying no GeoParquet metadata, where the geometry really is an
undifferentiated blob.

**Columnar means a query can be cheaper than the file.** The subway lines export
is 3.3 MB and 99.5% of that is geometry. A query naming only `service` reads the
Parquet footer, works out where that column lives, and fetches that range: two
ranged reads, about 16 KB. You can ask what is in a dataset for the price of its
metadata. Range reads need a length to range into, though, and only an export
GeoLens has already built answers `HEAD` with a `Content-Length`. Against a
cold artifact DuckDB streams the whole file and the pruning buys nothing. The
script logs and prints what each run actually moved instead of quoting a number
that is only true half the time.

That limit is DuckDB's, not the server's. GeoLens honours a leading bare `Range`
even on an export it has never built ([geolens#1585](https://github.com/geolens-io/geolens/pull/1585)),
so a client that already knows the size can range into a cold artifact. DuckDB
will not, because it asks `HEAD` first and declines to address ranges into a
file whose length it was not told.

**`ST_Read` takes the plain https URL.** GDAL's own `/vsicurl/` prefix fails
here, because DuckDB's spatial extension serves the bytes to GDAL through
DuckDB's filesystem rather than letting GDAL fetch them. That plumbing also
decides how credentials work, below.

**`limit` is capped by the instance.** 1000 by default, and on the demo. The 496
stations fit one page, so this script does not page. A collection whose size you
do not control needs the `rel="next"` link followed, which GeoJSON-over-`ST_Read`
cannot do for you: read it with an HTTP client the way
[`python/analyze.py`](../python/analyze.py) does, or export it as Parquet and let
the format carry the whole dataset in one URL. There is a third way inside
DuckDB: GDAL's OGC API Features driver, which the same `spatial` extension
ships, follows `rel="next"` itself.
`ST_Read('OAPIF:https://demo.getgeolens.com/api/', layer := '<collection id>')`
walks a whole collection (the 32,186 meteorite landings in about eight
seconds). It uses GDAL's own HTTP stack rather than `httpfs`, which on Debian
and Ubuntu means exporting `CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt`
first, or every https `OAPIF:` open fails with "error adding trust anchors".

**Name the source CRS `OGC:CRS84`, not `EPSG:4326`.** This is the line in the
script most worth reading twice. Both reads hand back lon/lat, and both label
it, but not the same way: the GeoParquet column arrives typed
`GEOMETRY('OGC:CRS84')` and `ST_Read`'s arrives `GEOMETRY('EPSG:4326')`. The two
authorities disagree about axis order (CRS84 is lon/lat, EPSG:4326 is lat/lon),
and `ST_Transform` believes the name you give it over the numbers you give it:

```sql
-- Astoria-Ditmars Blvd, -73.912034 40.775036, read as lon/lat.
-- New York, in metres.
ST_Transform(geom, 'OGC:CRS84',  'EPSG:32618')  -->  591810, 4514353

-- the same point read as lat/lon. The South Atlantic.
ST_Transform(geom, 'EPSG:4326',  'EPSG:32618')  -->  2130332, -10795837
```

No error and no warning, just a well-formed answer to a different question.
`ST_Transform(..., always_xy := true)` is the same fix spelled differently.

**Check that the planner saw a spatial join.** `EXPLAIN` on the join in this
script shows a `SPATIAL_JOIN` operator carrying `ST_DWithin` as its condition.
That is worth confirming whenever a spatial join is slower than it should be: a
predicate the planner does not recognise still returns the right answer, and
degrades quietly into every row against every row.

**Group by an id, not by a name.** The demo's 496 stations carry 379 distinct
`stop_name` values, six of them called "86 St" and six "Canal St", so grouping
by name silently merges platforms that are miles apart and reports one station served by
fifteen lines. It looks like an answer, which is what makes it worth saying. The
script groups on `OGC_FID`, GDAL's row identity.

## What CI checks

`.github/workflows/verify.yml` runs `uv run duckdb/query.py` against the live
demo on every pull request, on pushes to `main`, and weekly. The script exits
non-zero when the answer is wrong, so the job is a real check rather than a
demonstration that ran:

| check | value | why this one |
| --- | --- | --- |
| lines | exactly 29 | no geometry involved, so it is exact or the catalog moved |
| stations | exactly 496 | same |
| projected extent | inside UTM 18N over New York | catches a wrong source CRS |
| every station near a line | all 496 within 50 m | proves the two reads register against each other |
| pairs within 150 m | 1250 to 1400 | proves the join produced the documented shape |

Every row of that table is a fact about the demo's catalog, so the script only
checks them when the target is the demo: that URL and those two dataset ids,
whether you passed them yourself or left them to the defaults. Point it at your
own instance and it says so in one line, then checks only that both reads
returned something, which is the one claim it can make about a catalog it has
never seen.

The extent check is also the one that cannot be generalized, which is why the
whole table is gated rather than travelling with the script. It catches the
axis-order trap by knowing in advance which patch of the earth the right answer
sits on. Widen the box until it fits any instance and it stops telling New York
from the South Atlantic, which is the only distinction it exists to draw.

The extent check earns its place. The obvious guard, "every station is near a
line", does not catch an axis-order mistake at all, because both layers get
transformed by the same wrong rule and land in the South Atlantic together,
still neatly 20 m apart. Running the script deliberately broken is what
established that; only an absolute check on where the coordinates ended up
fails. Everything else here is exact, except the pair count: pairs are counted
against a 150 m threshold and the closest pair on either side sits 0.13 m below
it and 3.45 m above, so an equality there would be a coin flip on a PROJ upgrade
that moves a point by a hand's width.

The demo's dataset ids are declared once in
[`ci/fixtures.json`](../ci/fixtures.json) and probed before the browser sweep,
including the Parquet export route this example reads. That preflight runs in a
different job from this script and in parallel with it, so a demo reset turns
both red at once: read the preflight alongside the failure here, since it is
the one that names what moved. The exact counts live only in this script, and
the fixture file carries lower bounds.

## Using your own instance

Public datasets need no credential, which is why the demo works with none. For a
private one, one secret covers both reads:

```sql
CREATE SECRET geolens (
    TYPE http,
    SCOPE 'https://geolens.example.com',
    EXTRA_HTTP_HEADERS MAP{'X-Api-Key': '...'}
);
```

Set `GEOLENS_API_KEY` and the script creates it for you.

`ST_Read` is GDAL, so the obvious guess is GDAL's own `GDAL_HTTP_HEADERS`
variable. It does nothing here: DuckDB serves https to GDAL itself, so the
secret reaches both reads and the GDAL variable reaches neither.

Worth knowing before you spend an afternoon on it: neither read says "401".
`read_parquet` reports a refused credential as
`HTTP Error: ... (HTTP 0 Internal Server Error)`, and `ST_Read` as
`IO Error: Could not open GDAL dataset at: <url>`. Both mean the server said
401. If a read that works signed out starts failing either of those ways once
you add a key, the key is wrong, not the server.

## Versions

`duckdb==1.5.5` is pinned in the script's PEP 723 header. It is the current
stable release, and a pin is the first line of defence against an example that
only worked on the day it was written. The `spatial` and `httpfs` extensions install on first use and are
cached in `~/.duckdb`, so the first run is slower than the rest.

Everything documented here was measured against that version on 2026-08-19.
Earlier 1.x releases also read GeoParquet through `spatial`, but the typed
`GEOMETRY('OGC:CRS84')` in the output above carries its CRS in the type, which
older ones do not, so treat the pin as the tested configuration rather than a
floor.
