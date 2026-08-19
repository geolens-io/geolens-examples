-- DuckDB over a GeoLens catalog, two ways in, no GeoLens client library.
--
--   duckdb < features.sql        (DuckDB CLI)
--   uv run run.py                (no CLI installed; same statements)
--
-- Point it at your own instance by changing the one host below. Both routes are
-- anonymous reads of public datasets on the demo.

INSTALL spatial; LOAD spatial;   -- ST_* functions, GeoParquet, and GDAL (with its OGC API Features driver)
INSTALL httpfs;  LOAD httpfs;    -- read_parquet over https with range requests

-- 1. GeoParquet straight from the export route. The `where` is SQL that runs in
--    PostGIS before a byte leaves the server, so a 32,000-row dataset arrives
--    as 51 rows, and DuckDB reads the file in place with HTTP range requests
--    (no download step). The result is typed: `geometry` is already a
--    GEOMETRY('OGC:CRS84') column, not WKB you have to parse.
SELECT name, recclass, round(mass_kg / 1000, 1) AS tonnes, year, ST_AsText(geometry) AS location
FROM read_parquet('https://demo.getgeolens.com/api/datasets/6030c57b-ce37-4198-aa1e-be78e0950f53/export?format=parquet&where=mass_kg>1000')
ORDER BY mass_kg DESC
LIMIT 5;

-- 2. The standards route. GDAL's OAPIF driver walks an OGC API Features
--    collection page by page (it follows rel=next, so the server's page
--    ceiling is not your problem) and hands DuckDB a table. Nothing here is
--    GeoLens-specific; the same two lines read any OGC API Features server.
--    ST_Transform to a metric CRS at load time, because every length and
--    distance below is in metres. UTM 18N covers all of New York City.
CREATE TABLE lines AS
SELECT * REPLACE (ST_Transform(geom, 'EPSG:4326', 'EPSG:32618', always_xy := true) AS geom)
FROM ST_Read('OAPIF:https://demo.getgeolens.com/api/', layer := 'de602fbe-8b30-4755-924f-c9e7fd9613b6');  -- NYC Subway Lines

CREATE TABLE stations AS
SELECT * REPLACE (ST_Transform(geom, 'EPSG:4326', 'EPSG:32618', always_xy := true) AS geom)
FROM ST_Read('OAPIF:https://demo.getgeolens.com/api/', layer := '724bf894-dc1a-418c-abc6-555798c44d7c');  -- NYC Subway Stations

-- 3. The question python/analyze.py asks in GeoPandas, in SQL: how long is each
--    service, and how many stations sit within 150 m of it (distinct by name,
--    so a complex with several platform rows counts once, the same rule
--    analyze.py uses). ST_DWithin is the spatial join; no buffer polygons are built.
WITH km AS (
  SELECT service, any_value(service_name) AS name, round(sum(ST_Length(geom)) / 1000, 1) AS km
  FROM lines
  GROUP BY service
),
stops AS (
  SELECT l.service, count(DISTINCT s.stop_name) AS stops
  FROM lines l
  JOIN stations s ON ST_DWithin(l.geom, s.geom, 150)
  GROUP BY l.service
)
SELECT service, name, km, stops, round(stops / km, 2) AS stops_per_km
FROM km JOIN stops USING (service)
ORDER BY km DESC
LIMIT 5;

-- 4. Keep the result as GeoParquet. DuckDB writes the `geo` file metadata when
--    a GEOMETRY column is present, so GeoPandas, QGIS and GDAL open it as
--    spatial data. Back to lon/lat first: that is what readers expect by default.
COPY (
  SELECT service, service_name, ST_Transform(geom, 'EPSG:32618', 'EPSG:4326', always_xy := true) AS geom
  FROM lines
) TO 'nyc_subway_lines.parquet' (FORMAT parquet);

SELECT count(*) AS rows_written, any_value(typeof(geom)) AS geometry_type
FROM read_parquet('nyc_subway_lines.parquet');
