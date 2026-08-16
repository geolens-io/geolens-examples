# GeoLens Examples

Runnable examples for consuming [GeoLens](https://github.com/geolens-io/geolens) services from the tools your stack already uses. Every example runs against the public [GeoLens demo](https://demo.getgeolens.com) anonymously — clone, open, see it render. Point any of them at your own instance by changing one constant.

GeoLens serves OGC API Features and Records, STAC 1.0, XYZ vector tiles (MVT), and raster tiles. These examples show those surfaces from the consumer's side.

## Examples

| Directory | Tool | Demonstrates | Status |
|---|---|---|---|
| [`maplibre/`](maplibre/) | MapLibre GL JS 5.x | Vector tiles (MVT), GeoJSON features, raster tiles | Verified live (vector tiles, features, imagery) |
| [`arcgis-js/`](arcgis-js/) | ArcGIS Maps SDK for JavaScript 4.x/5.x | `OGCFeatureLayer` (OGC API Features), `WebTileLayer` (raster tiles) | Verified live (SDK 5.1, features + imagery) |
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

Change it to your instance URL.

These examples need **GeoLens v1.13.0 or newer**. Raster tiles only started sending `Access-Control-Allow-Origin` in that release ([geolens#1464](https://github.com/geolens-io/geolens/issues/1464)), and without it the MapLibre and ArcGIS imagery examples draw an empty map while the server returns perfectly valid PNGs. The features and vector-tile examples reach further back: the anonymous CORS wildcard they depend on has been there since v1.4.7.

Dataset IDs and table names in these examples belong to the demo catalog. Against your own instance, list what's available at `/api/collections` and substitute your collection IDs. The demo gets reset from time to time, and a reset can change its dataset UUIDs, so treat the IDs hardcoded here as demo-specific rather than as part of any API. CI replays every example against the live demo on each push, on every pull request, and once a week on a schedule, so an ID that stops resolving turns the build red instead of quietly leaving you with a blank map.

Anonymous cross-origin reads work with no setup: GeoLens answers the standards paths (`/api/collections`, `/api/stac`, conformance) with `Access-Control-Allow-Origin: *` as long as the request carries no credential. Send a credential and that wildcard is gone, so your page's origin has to be listed in the instance's `CORS_ALLOWED_ORIGINS`. A literal `*` there is rejected, since credentialed CORS requires explicit origins.

## Authenticating against your own instance

The demo is public, so none of these examples send a credential. On your own instance, pick the method your client can actually use:

| Client | Use |
|---|---|
| `fetch`, an SDK, Python, GDAL, ArcGIS request interceptors | `X-Api-Key: <key>` header, or `Authorization: Bearer <jwt>` |
| A static XYZ/MVT URL template that cannot set headers | a signed tile token, scoped to one dataset and short-lived |
| Public data, including everything in the demo | nothing |

GeoLens resolves credentials in one fixed order (`_resolve_api_key` and `get_optional_user` in `backend/app/modules/auth/dependencies.py`): the `X-Api-Key` header, then an `?api_key=` query parameter, then a bearer JWT, then anonymous. The header and the query parameter carry the same key and grant the same access. Only the transport differs.

Prefer the header. A key in a URL ends up in browser history, server access logs, every proxy log along the way, analytics, screenshots, and anything anyone copy-pastes, which is why GeoLens deprecated the query lane in geolens#821 and kept it only for clients that genuinely cannot set a header. Desktop GIS consuming an XYZ template is the case it exists for.

Do not put a long-lived API key in a static HTML file, and do not commit one. Anyone who reads the page source has your key with all of your access until someone notices and revokes it.

### Signed tile tokens

`GET /api/tiles/token/<dataset_id>/` mints a token for a single dataset. A vector dataset returns `sig`, `exp`, and `scope` to append to the tile template; a raster dataset returns the whole `tile_url` with those already in the query string.

```bash
curl https://demo.getgeolens.com/api/tiles/token/6f03bafa-34b3-4902-9351-40ce09a8181f/
# {"kind":"raster",
#  "tile_url":"/raster-tiles/6f03.../tiles/{z}/{x}/{y}.png?sig=47a4...&exp=1786838400&scope=6f03...",
#  "expires_in":530, ...}
```

The signature is bound to that one dataset, and `exp` lands on the next 15-minute boundary. A leaked template is therefore worth minutes of read access to one layer, where a leaked API key is worth everything you can reach. `POST /api/tiles/tokens/` mints up to 50 in one call for a multi-layer map.

Two properties decide whether this fits your page.

Minting is itself authorized. A public, published dataset hands a token to anyone, which is why the `curl` above works signed out. A private one answers an anonymous mint with 401, so a page holding no credential cannot mint its own token and something server-side has to hold the key and pass tokens down. A scoped token does not remove the need for a credential. It keeps the credential out of the browser.

Tokens expire and clients do not renew them on their own. MapLibre keeps requesting whatever template you handed it, so a page that stays open has to re-mint and reset the source URL before `exp` passes.

`X-Embed-Token` is a different mechanism and not a substitute here. Embed tokens are minted per *map* by an authenticated owner, and the tile routes read them from the header only, so one cannot ride along in a URL template.

## OGC API Features or vector tiles

The three `features.html` examples fetch every feature once with `?limit=2000` and hold the whole result in browser memory. That works for the demo's subway layers (496 stations, 29 lines). It is the wrong shape for a parcel, road, or building layer, where the same code silently renders one truncated page.

Use OGC API Features when the result is small or bounded, when you need attributes on the client, when you load by viewport or filter instead of all at once, or when the page interacts with individual features.

Use vector tiles when the dataset is large, when users pan and zoom across all of it, when not every feature needs to reach the browser, and when rendering performance matters more than holding the full attribute table. `maplibre/vector-tiles.html` shows that path: the server cuts MVT per tile and the client holds only what is on screen.

Every items response says which case you are in:

```bash
curl "https://demo.getgeolens.com/api/collections/724bf894-dc1a-418c-abc6-555798c44d7c/items?limit=2" \
  | jq '{numberMatched, numberReturned}'
# { "numberMatched": 496, "numberReturned": 2 }
```

`numberMatched` is what the query found; `numberReturned` is what this page contains. When they differ, you are holding one page of a longer result and the response carries a `rel="next"` link. Paging is keyset-based (`after_gid=`), so rows do not shift under a reader mid-scan, and the last page drops the `next` link. `python/analyze.py` follows it in a few lines.

## License

[MIT](LICENSE). The examples are intentionally small — copy them into your project freely.
