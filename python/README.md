# Python: analyze a GeoLens catalog with GeoPandas

`analyze.py` reads two collections from the GeoLens demo over OGC API - Features,
measures the NYC subway network in a metric CRS, joins stations to service lines
spatially, and renders `subway.png`.

It is one file. Dependencies live in a [PEP 723](https://peps.python.org/pep-0723/)
header, so there is nothing to install and no virtualenv to activate:

```bash
uv run analyze.py
```

## Output

```
Reading https://demo.getgeolens.com ...

                          NYC SUBWAY
--------------------------------------------------------------
  services                    29
  stations                   496
  line geometry            730.9 km   (29 service geometries summed)
  after dissolve           562.1 km   (coincident parts merged)
  measured in         EPSG:32618

  ADA accessible             162   (33% of stations)
  partly accessible            9

  stations by borough
    Brooklyn            169   ############################
    Manhattan           153   ##########################
    Queens               83   ##############
    Bronx                70   ############
    Staten Island        21   ####

  longest services
                 km  parts  stops  stops/km  name
    A          56.5      6     74      1.31  8 Avenue Express
    SIR        54.0    133     21      0.39  Staten Island Railway
    F          44.0      1     59      1.34  6 Avenue Local
    D          41.6      2     58      1.39  6 Avenue Express
    2          41.0      2     73      1.78  7 Avenue Express

  SIR carries 133 parts against a median of 2: it is
  digitized track by track while the lettered services are single
  centerlines. Two conventions in one column, so 'km' is the length
  of the drawn geometry, not the length of the route.
--------------------------------------------------------------
  wrote subway.png
```

That last note matters as much as the map. The numbers are real, so they carry the
quirks of the source data, and the script prints the evidence for its own caveat
instead of asking you to trust a tidy figure.

## What it shows

**The items endpoint returns plain GeoJSON.** `GET /api/collections/{id}/items`
hands back a `FeatureCollection`, so `gpd.GeoDataFrame.from_features()` is the whole
adapter. Collection ids are dataset UUIDs; list them at `GET /api/collections`.

**Paging follows the `next` link.** `limit=2000` happens to cover both demo
collections in one request, but the script follows `rel=next` anyway. GeoLens pages
by keyset (`after_gid=...`), not offset, so rows never shift underneath a reader
mid-scan, and it drops the `next` link on the last page so the loop ends on its own.

**Private datasets take an API key in a header.** Set `GEOLENS_API_KEY` and the
script sends `X-Api-Key`. GeoLens still accepts `?api_key=` in the query string, but
that lane is deprecated, because a credential in a URL lands in access logs and in
every proxy log along the way. It survives only for clients that cannot set headers,
such as XYZ tile URLs pasted into desktop GIS. A *wrong* key returns 401 even on a
public dataset, so an unset variable is safer than a stale one.

**Measurements happen in a projected CRS.** Lengths taken on EPSG:4326 are in
degrees and mean nothing. The script reprojects to UTM 18N once, then everything
downstream is metres.

## ogr2ogr one-liners

Verified against the live demo with GDAL 3.13.0.

Pull a collection straight from the items URL into a GeoPackage. The GeoJSON driver
reads the URL directly, no `/vsicurl/` prefix:

```bash
ogr2ogr -f GPKG stations.gpkg \
  "https://demo.getgeolens.com/api/collections/724bf894-dc1a-418c-abc6-555798c44d7c/items?limit=2000" \
  -nln stations
```

```
$ ogrinfo -so stations.gpkg stations
Layer name: stations
Geometry: Multi Point
Feature Count: 496
Extent: (-74.251961, 40.512764) - (-73.755405, 40.903125)
ada: Integer (0.0)
borough: String (0.0)
division: String (0.0)
stop_name: String (0.0)
structure: String (0.0)
daytime_routes: String (0.0)
```

The per-dataset export endpoint serves whole datasets in other formats. GeoPackage
needs no conversion at all:

```bash
curl -o stations.gpkg \
  "https://demo.getgeolens.com/api/datasets/724bf894-dc1a-418c-abc6-555798c44d7c/export?format=gpkg"
```

For the other formats (`geojson`, `parquet`, `shp`, `csv`), download first and
convert locally:

```bash
curl -o lines.geojson \
  "https://demo.getgeolens.com/api/datasets/de602fbe-8b30-4755-924f-c9e7fd9613b6/export?format=geojson"
ogr2ogr -f GPKG lines.gpkg lines.geojson -nln subway_lines   # Feature Count: 29
```

Download first, because pointing `/vsicurl/` at the export endpoint hangs.
`/vsicurl/` opens with a HEAD request to negotiate byte ranges, the export endpoint
answers HEAD with 405, and GDAL sits there waiting. A plain GET of the same URL
returns 10 MB in about 2.5 seconds.

For a private dataset, pass the key as a header:

```bash
ogr2ogr --config GDAL_HTTP_HEADERS "X-Api-Key: $GEOLENS_API_KEY" \
  -f GPKG stations.gpkg \
  "https://demo.getgeolens.com/api/collections/{id}/items?limit=2000"
```

Confirmed that GDAL transmits the header, using a deliberately invalid key: the
request came back 401 rather than succeeding anonymously. The authenticated path
itself is untested here, since the demo datasets are public and need no key.

## Pinned versions

`geopandas==1.1.4`, `httpx==0.28.1`, `matplotlib==3.11.1` are the current releases,
resolved and run on 2026-08-13. Exact pins keep the example reproducible; the
transitive stack (shapely, pyproj, pandas, numpy) floats. `requires-python = ">=3.11"`
comes from matplotlib 3.11, the strictest floor of the three.

Data: MTA via [data.ny.gov](https://data.ny.gov), served by the GeoLens demo.
