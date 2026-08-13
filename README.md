# GeoLens Examples

Runnable examples for consuming [GeoLens](https://github.com/geolens-io/geolens) services from the tools your stack already uses. Every example runs against the public [GeoLens demo](https://demo.getgeolens.com) anonymously — clone, open, see it render. Point any of them at your own instance by changing one constant.

GeoLens serves OGC API Features and Records, STAC 1.0, XYZ vector tiles (MVT), and raster tiles. These examples show those surfaces from the consumer's side.

## Examples

| Directory | Tool | Demonstrates | Status |
|---|---|---|---|
| [`maplibre/`](maplibre/) | MapLibre GL JS 5.x | Vector tiles (MVT), GeoJSON features, raster tiles | Vector tiles + features verified live; imagery blocked on [geolens#1464](https://github.com/geolens-io/geolens/issues/1464) |
| [`arcgis-js/`](arcgis-js/) | ArcGIS Maps SDK for JavaScript 4.x/5.x | `OGCFeatureLayer` (OGC API Features), `WebTileLayer` (raster tiles) | Features verified live (SDK 5.1); imagery blocked on [geolens#1464](https://github.com/geolens-io/geolens/issues/1464) |
| [`openlayers/`](openlayers/) | OpenLayers 10 | OGC API Features, XYZ raster | Verified live (features + imagery) |
| [`leaflet/`](leaflet/) | Leaflet 1.9 | GeoJSON features, raster tiles | Verified live (features + imagery) |
| [`python/`](python/) | Python (single-file `uv run` script) | Features API → GeoPandas spatial join, metric-CRS analysis, styled plot | Verified: runs green with one command |
| [`claude-mcp/`](claude-mcp/) | Claude via the GeoLens MCP server | Catalog search, schema, spatial queries, and tool chaining from an AI assistant | Ready, with a live transcript |
| `duckdb/` | DuckDB | SQL directly over the Features API | Planned |
| `cli/` | geolens CLI | Catalog-as-code | Planned |

MapLibre examples also work with Mapbox GL JS with minimal changes (both consume the same MVT and raster sources).

## Running the browser examples

Each browser example is one static HTML file with no build step — the library loads from a pinned CDN. Open the file directly in a browser, or serve the folder if your browser restricts `file://` pages:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/maplibre/vector-tiles.html
```

## Using your own GeoLens instance

Each example declares its target at the top:

```js
const GEOLENS = "https://demo.getgeolens.com";
```

Change it to your instance URL. For private datasets, append your API key as a query parameter (`?api_key=...`) to the request URLs — GeoLens accepts keys via header or query string; the query form is what map libraries can send without custom plumbing. Your instance must allow your page's origin in its CORS configuration (the demo allows all origins).

Dataset IDs and table names in these examples belong to the demo catalog. Against your own instance, list what's available at `/api/collections` and substitute your collection IDs.

## License

[MIT](LICENSE). The examples are intentionally small — copy them into your project freely.
