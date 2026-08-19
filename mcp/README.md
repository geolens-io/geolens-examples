# Ask an MCP client about your geospatial catalog

`geolens-mcp` is a read-only [MCP](https://modelcontextprotocol.io) server that puts a GeoLens
catalog inside any MCP client's session: Claude Code, Claude Desktop, Cursor, Codex, or one you
wrote yourself. Once it is registered, you stop context-switching to a GIS client to answer "what
data do we even have for this?" You ask the assistant, and it goes and looks. It gets six tools:
`search_datasets` (free-text catalog search), `get_dataset_schema` (columns, geometry type,
SRID, feature count, extent, and source-trust metadata), `get_features` (bounded GeoJSON, with an
optional bbox filter), `list_maps` and `get_map` (saved maps, their layers and view state), and
`query` (one SQL `SELECT` through the backend's read-only sandbox). The first five work against a
public instance with no credentials at all; `query` needs an API key, which is the main thing to
know before you start.

Nothing here can write. The discovery tools are `GET`s, and `query` is a `POST` only in the HTTP
sense: the backend runs it inside a `READ ONLY` transaction. What the assistant can see is bounded by the
credential you give it: with an API key it sees what that key's user sees, and with no credential it
sees public data and nothing else.

## Setup

The server is on PyPI, so `uvx` fetches and runs it on demand; there is nothing to clone. It needs
Python 3.11 or newer. Every example below points at the public demo instance, which serves its
catalog anonymously, so you can paste any of them as-is and have working tools in about a minute.

Every example also pins `geolens-mcp@1.14.0`, the current release and the version the demo reports.
The package ships with each GeoLens release, so the version to run is the one matching your
instance. See [Things that will bite you](#things-that-will-bite-you) for how to move off the pin.

### Clients

Config for each client lives in [`clients/`](./clients):

| Client | File | Use |
|---|---|---|
| Claude Code | [`clients/claude-code.md`](./clients/claude-code.md) | a `claude mcp add` one-liner |
| Claude Desktop | [`clients/claude-desktop.json`](./clients/claude-desktop.json) | merge into `claude_desktop_config.json` |
| Cursor | [`clients/cursor.json`](./clients/cursor.json) | drop in as `.cursor/mcp.json` |
| Codex CLI | [`clients/codex.md`](./clients/codex.md) | an `[mcp_servers.geolens]` table for `config.toml` |
| Anything else that speaks stdio MCP | [`clients/generic.json`](./clients/generic.json) | the plain `{command, args, env}` shape |

Each one points at the public demo with no credentials. For your own instance, change
`GEOLENS_INSTANCE` and add `GEOLENS_API_KEY` in whichever file you use; create the key under
**Settings → API keys** in the GeoLens web UI. Keep real API keys out of a committed config file:
use your client's local/user scope, or reference an environment variable your shell already exports.

### The three environment variables

| Variable | Required | What it does |
|---|---|---|
| `GEOLENS_INSTANCE` | yes | Instance URL. A missing `/api` suffix is appended for you, so `https://demo.getgeolens.com` and `https://demo.getgeolens.com/api` both work. |
| `GEOLENS_API_KEY` | no | Sent as the `X-Api-Key` header. Omit it for public-only access. |
| `GEOLENS_TOKEN` | no | JWT bearer token, used only when `GEOLENS_API_KEY` is unset. |

That is the entire configuration surface. There are no other knobs.

## Five things to ask it

Each prompt names the tools it drives. The catalog references are from the demo instance, so these
run as written.

**1. Find data by describing it.** Exercises `search_datasets`.

> What datasets do we have about hurricanes or major storms? Give me the titles and how many
> features each one has.

Search matches title, description, and keywords. Instances with semantic search configured also rank
by meaning, so a question phrased as a question rather than as keywords still lands.

**2. Ask what is actually in a dataset.** Exercises `search_datasets`, then `get_dataset_schema`.

> Find the major hurricane tracks dataset and tell me its columns, geometry type, and SRID. Which
> column would I use to filter to Category 5 storms?

`get_dataset_schema` is the tool worth prompting the assistant toward before any analysis question. It
returns the column list along with the source-trust fields: `origin`, `source_health`, and a
`source_freshness` of fresh, due, overdue, or unknown. That lets the assistant warn you the data may be
stale instead of quietly answering from it.

**3. Ask a spatial question.** Exercises `search_datasets`, then `get_features` with a bbox.

> How many NYC parcels fall inside the bounding box -74.02,40.70,-74.00,40.72, and show me two of
> them with their block and lot numbers.

The bbox is `minx,miny,maxx,maxy` in WGS84 regardless of the dataset's own SRID. Responses are
capped by `limit` and paged with `offset`, so the assistant reads a bounded sample rather than dragging
43,000 parcels through the context window. Raster datasets have no features and will error here.

**4. Inventory the saved maps.** Exercises `list_maps`.

> List the public maps on this instance with their layer counts, and tell me which ones are about
> weather.

**5. Chain it together.** Exercises `list_maps` → `get_map` → `get_dataset_schema` → `get_features`.

> Open the "Hurricane Exposure" map, figure out which datasets its layers are built from, and tell
> me which coastal region has been hit by the most distinct major storms.

This is where the server earns its keep. The assistant walks the whole chain on its own and only reads rows
once it knows which dataset and column it needs.

If your instance has AI chat enabled and you supply an API key for a user who holds that permission,
add a sixth: **"Use the query tool to count rows per category in that dataset."** (This one cannot
run against the demo anonymously; see the transcript below for what happens if you try.)
`query` runs a single `SELECT` over `data.*` tables against an allowlisted function set (aggregates,
math, string, date, JSON, and common PostGIS predicates like `ST_Area` and `ST_Intersects`), with a
mandatory `restrict_tables` scope, a statement timeout, and a row cap.

## How it actually behaves

Captured on 2026-08-14 by driving the wheel `geolens-mcp` published as version 1.13.0 over stdio
with a minimal MCP client, anonymously, against `https://demo.getgeolens.com` (which reported
itself healthy at 1.13.0; the tool set is unchanged in 1.14.0). Output is real and trimmed for width.

Tool discovery, straight after `initialize`:

```
=== TOOLS ===
- search_datasets: Search the GeoLens catalog for datasets by free text.
- get_dataset_schema: Get a dataset's schema and source trust metadata.
- get_features: Get GeoJSON features for a dataset (bounded).
- list_maps: List saved maps (read-only metadata: id, name, visibility, layer count).
- get_map: Get one saved map's full metadata, including its layers, view state, …
- query: Run one read-only SQL SELECT against accessible datasets.
```

`search_datasets(query="new york city parcels", limit=3)` returns a GeoJSON FeatureCollection where
each feature is a dataset record. The feature `id` is the dataset id you pass to every other tool:

```json
{ "numberMatched": 5, "numberReturned": 3 }

{ "id": "4657a40c-8d91-4436-9b0e-9759d377fbd0", "title": "MNMAP_PLUTO",
  "record_type": "vector_dataset", "source_freshness": "unknown",
  "feature_count": 43068 }
{ "id": "de602fbe-8b30-4755-924f-c9e7fd9613b6", "title": "NYC Subway Lines (MTA)",
  "record_type": "vector_dataset", "feature_count": 29 }
{ "id": "0fa6ca98-8c21-4dd0-8b1c-1241050f10fc", "title": "Manhattan Building Heights",
  "record_type": "vector_dataset", "feature_count": 22324 }
```

`get_dataset_schema` on the subway dataset. Note `srid` and `table_name`, and that `column_info`
carries optional slots (`semantic_role`, `sample_values`, `stats`) that are null unless the instance
has profiled the dataset:

```json
{ "title": "NYC Subway Lines (MTA)", "geometry_type": "MULTILINESTRING",
  "srid": 4326, "original_srid": 4326, "feature_count": 29,
  "table_name": "nyc_subway_lines_mta",
  "summary": "New York City subway service geometries, one feature per service.
              Source: MTA via data.ny.gov (open data, attribute MTA).",
  "extent_bbox": [-74.2527, 40.5122, -73.7545, 40.9037],
  "origin": "upload", "source_format": "geojson", "visibility": "public",
  "license": "MTA open data (data.ny.gov)",
  "source_organization": "MTA via NY State Open Data",
  "source_health": "unknown", "source_freshness": "unknown" }

"column_info": [
  { "name": "service", "type": "character varying", "semantic_role": null,
    "sample_values": null, "stats": null },
  { "name": "service_name", "type": "character varying", "semantic_role": null,
    "sample_values": null, "stats": null }
]
```

`get_features` on the parcel dataset with `bbox="-74.02,40.70,-74.00,40.72"` and `limit=2`. The
`numberMatched` count is what makes this answerable. 1,358 of the 43,068 parcels fall in that box,
and the assistant learns that without reading them:

```json
{ "type": "FeatureCollection", "numberMatched": 1358, "numberReturned": 2 }

{ "id": 1, "geometry": { "type": "MultiPolygon", … },
  "properties": { "cd": 101, "bbl": 1000257501, "lot": 7501, "block": 25, … } }
```

Each parcel carries 85 property keys, which is a good argument for keeping `limit` small.

The full chain from prompt 5, four calls end to end:

```
1. list_maps(search="hurricane exposure")
   → "Hurricane Exposure - Which Coasts the Major Storms Reach"  c072d473-…
2. get_map("c072d473-…")
   → 3 layers → dataset ids caf6b9c8-…, c5fe3ee9-…, 13039dea-…
3. get_dataset_schema("caf6b9c8-…")
   → "Hurricane Exposure by Coastal Region", MULTIPOLYGON, 289 features,
     columns: region, source_count
   get_dataset_schema("c5fe3ee9-…")
   → "Major Hurricane Tracks (Cat 3+ legs, one per storm)", MULTILINESTRING,
     202 features, columns: name, season, peak_wind_kt, peak_category,
     major_legs, landfall
   get_dataset_schema("13039dea-…")
   → "Atlantic Basin Regions (Natural Earth admin-1)", MULTIPOLYGON,
     480 features, columns: region, country
4. get_features("caf6b9c8-…", limit=3)
   → numberMatched: 289
     { "region": "Acklins",  "source_count": 7 }
     { "region": "Alabama",  "source_count": 8 }
     { "region": "Alajuela", "source_count": 2 }
```

And the honest failure. Anonymous `query` is refused, exactly as documented:

```
query(sql="SELECT 1 AS n", restrict_tables=["nonexistent"], row_limit=1)
→ isError: True
  GeoLens API 401 for /query/: Could not validate credentials
```

Bad ids are rejected client-side before any request goes out, which is worth knowing because it is a
different error than a 404:

```
get_features(dataset_id="not-a-uuid")
→ isError: True
  Invalid id (expected a UUID): 'not-a-uuid'
```

## Things that will bite you

Anonymous access sees published public data only. If the assistant comes back saying your own instance has
no datasets, check `GEOLENS_API_KEY` before you go looking at the catalog.

`query` needs both an API key and a user with the AI-chat permission. Without them you get the 401
above, while the other five tools keep working. A session where "search works but query doesn't" is
a credential problem, not a broken install.

The version pin will go stale, and that is the trade. Without it, `uvx geolens-mcp` resolves the
latest release on every run, so the server can change under a session you have not touched. With
it, you stay put until you bump. `geolens-mcp` is released alongside GeoLens itself, so track your
instance: `https://your-instance/api/health` reports the version to match. A pin uv cannot resolve
fails loudly rather than quietly falling back.

Raster datasets have no features. `get_features` against one errors rather than returning an empty
collection; use `get_dataset_schema` to check `record_type` first.

## Source

The server is hand-maintained in the GeoLens repo at
[`mcp/geolens_mcp`](https://github.com/geolens-io/geolens/tree/main/mcp), published to PyPI as
[`geolens-mcp`](https://pypi.org/project/geolens-mcp/) under Apache-2.0. It wraps the `geolens`
Python SDK for auth and transport, and its tools call the same REST endpoints the web UI does.
