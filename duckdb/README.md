# DuckDB: SQL over a GeoLens catalog

One SQL file, two ways to read GeoLens without a GeoLens client library, and a
spatial join at the end.

```bash
duckdb < features.sql      # the DuckDB CLI
uv run run.py              # no CLI: a short uv script runs the same file
```

[`features.sql`](features.sql) is the example. [`run.py`](run.py) exists so it
runs where only Python is installed (CI included); it executes the statements
one by one and fails if a SELECT comes back empty.

## What it shows

**GeoParquet from the export route.** `/api/datasets/{id}/export?format=parquet`
returns GeoParquet 1.1, and its `where` is SQL that PostGIS runs before a byte
leaves the server. DuckDB's `httpfs` reads the file in place with range
requests, and `spatial` gives you a typed `GEOMETRY('OGC:CRS84')` column
instead of WKB:

```sql
SELECT name, round(mass_kg / 1000, 1) AS tonnes, year, ST_AsText(geometry)
FROM read_parquet('https://demo.getgeolens.com/api/datasets/6030c57b-ce37-4198-aa1e-be78e0950f53/export?format=parquet&where=mass_kg>1000')
ORDER BY mass_kg DESC LIMIT 5;
```

**The standards route through GDAL.** DuckDB's `spatial` extension bundles
GDAL, and GDAL has an OGC API Features driver. `ST_Read('OAPIF:…/api/',
layer := '<collection>')` walks the collection page by page, following
`rel=next`, so the server's page ceiling is not something you code around.
Nothing in those two lines is specific to GeoLens.

**Spatial SQL.** The same question [`python/analyze.py`](../python/analyze.py)
asks in GeoPandas, asked in SQL: per subway service, kilometres of drawn track
and stations within 150 m, after `ST_Transform` into UTM 18N so the metres are
real. The numbers match the Python example to the decimal.

**Keep it.** `COPY … TO 'nyc_subway_lines.parquet'` writes GeoParquet with the
`geo` metadata, so GeoPandas, QGIS and GDAL open the result as spatial data.

## Output

```
┌─────────────────┬──────────────┬────────┬───────┬──────────────────────────────────┐
│      name       │   recclass   │ tonnes │ year  │             location             │
├─────────────────┼──────────────┼────────┼───────┼──────────────────────────────────┤
│ Hoba            │ Iron, IVB    │   60.0 │  1920 │ MULTIPOINT (17.91667 -19.58333)  │
│ Cape York       │ Iron, IIIAB  │   58.2 │  1818 │ MULTIPOINT (-64.93333 76.13333)  │
│ Campo del Cielo │ Iron, IAB-MG │   50.0 │  1575 │ MULTIPOINT (-60.58333 -27.46667) │
│ Canyon Diablo   │ Iron, IAB-MG │   30.0 │  1891 │ MULTIPOINT (-111.03333 35.05)    │
│ Armanty         │ Iron, IIIE   │   28.0 │  1898 │ MULTIPOINT (88 47)               │
└─────────────────┴──────────────┴────────┴───────┴──────────────────────────────────┘

┌─────────┬───────────────────────┬────────┬───────┬──────────────┐
│ service │         name          │   km   │ stops │ stops_per_km │
├─────────┼───────────────────────┼────────┼───────┼──────────────┤
│ A       │ 8 Avenue Express      │   56.5 │    74 │         1.31 │
│ SIR     │ Staten Island Railway │   54.0 │    21 │         0.39 │
│ F       │ 6 Avenue Local        │   44.0 │    59 │         1.34 │
│ D       │ 6 Avenue Express      │   41.6 │    58 │         1.39 │
│ 2       │ 7 Avenue Express      │   41.0 │    73 │         1.78 │
└─────────┴───────────────────────┴────────┴───────┴──────────────┘

┌──────────────┬───────────────────────┐
│ rows_written │     geometry_type     │
├──────────────┼───────────────────────┤
│           29 │ GEOMETRY('OGC:CRS84') │
└──────────────┴───────────────────────┘
```

About eight seconds end to end on the demo, most of it the OAPIF walk.

## Your own instance

Change the host in the three URLs. Both routes are anonymous for public
datasets, which is what the demo serves. For a private dataset the export route
takes an API key through an `httpfs` secret, which DuckDB then sends on every
request:

```sql
CREATE SECRET geolens (TYPE http, EXTRA_HTTP_HEADERS MAP {'X-Api-Key': '…'});
```

The OAPIF route has no equivalent inside DuckDB: its bundled GDAL sends no
custom headers and does not read `GDAL_HTTP_HEADERS`, so for private
collections use the parquet route, or run `ogr2ogr` outside DuckDB.

Versions: DuckDB 1.5.5, with `spatial` and `httpfs` installed from the
extension repository on first run.
